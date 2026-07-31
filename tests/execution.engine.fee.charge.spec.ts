/**
 * execution.engine.fee.charge.spec.ts
 *
 * PHASE2_REMEDIATION (H7) — fillEngine.fill() has always computed an
 * execution fee (fillResult.fees, proportional to whatever was actually
 * filled, using the FEE_BPS table in liquidity.provider.ts) and that exact
 * figure was already written into Order.fees/Fill.fees/TradeAudit.fees and
 * surfaced as "commission revenue" on the admin dashboard and in tax
 * reporting -- but grepping wallet-service/ and execution.engine.ts
 * confirmed the ONLY wallet operation at position OPEN was the margin
 * lock; the fee was computed, displayed, and counted as revenue, but never
 * actually collected from the client. (Contrast with position CLOSE:
 * settlement.engine.ts's commission.calculator.ts-based charge IS
 * genuinely debited -- this open-time fee was the sole gap.)
 *
 * Fix: execute() now charges fillResult.fees atomically, via the same
 * conditional-UPDATE-then-INSERT-ledger pattern checkAndLockMargin() uses
 * -- debits WalletAccount.balance directly (not `locked`) and writes a
 * COMMISSION-type ledger entry (DR CLIENT / CR BROKER_COMMISSION), the
 * same shape settlement.engine.ts already uses at close. A client whose
 * free balance can't cover the fee fails closed and rolls back the margin
 * lock too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetQuote } = vi.hoisted(() => ({ mockGetQuote: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockGetQuote, isStale: vi.fn().mockReturnValue(false) },
}));

const { mockTx, mockPrisma } = vi.hoisted(() => {
  const mockTx = {
    $queryRaw:   vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    position:    { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    walletAccount: { update: vi.fn().mockResolvedValue({}) },
    ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn() },
  };
  const mockPrisma = {
    $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    $executeRaw:  vi.fn().mockResolvedValue(undefined),
    $queryRaw:    vi.fn(),
    tradeAudit:   { create: vi.fn().mockResolvedValue({}) },
  };
  return { mockTx, mockPrisma };
});
vi.mock("../shared/db.js", () => ({ prisma: mockPrisma, IS_PERSISTENT: true }));

vi.mock("../risk-service/risk.engine.js", () => ({
  assertAccountEligibleToTrade: vi.fn().mockResolvedValue({ eligible: true }),
  getCachedUserTier: vi.fn().mockResolvedValue("STANDARD"),
}));
vi.mock("../risk-service/kill.switch.js", () => ({
  killSwitch: { isActive: vi.fn().mockReturnValue(false), getState: vi.fn().mockReturnValue({ active: false, reason: "" }) },
}));
vi.mock("../risk-service/client.exposure.limits.js", () => ({
  clientExposureLimits: { checkAtomic: vi.fn().mockResolvedValue({ ok: true }) },
}));
vi.mock("../risk-service/concentration.guard.js", () => ({
  concentrationGuard: { checkAtomic: vi.fn().mockResolvedValue({ ok: true }) },
}));

const { mockFill } = vi.hoisted(() => ({ mockFill: vi.fn() }));
vi.mock("../execution-service/fill.engine.js", () => ({
  fillEngine: { fill: mockFill, providerId: "MOCK_LP" },
}));

vi.mock("../risk-service/exposure.limits.js", () => ({
  exposureRegistry: {
    openPosition: vi.fn(), closePosition: vi.fn(),
    checkCanOpenAtomic: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn(), observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

vi.mock("../settlement/reconciliation.engine.js", () => ({
  reconciliationEngine: { repairOrphanMargin: vi.fn().mockResolvedValue(0) },
}));

const { eventBus } = await import("../events-bus/event.bus.js");
const emitSpy = vi.spyOn(eventBus, "emit");

const { executionEngine } = await import("../execution-service/execution.engine.js");

const ORIGINAL_QUOTE = { bid: 1.0868, ask: 1.0870, mid: 1.0869, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 };

function baseRequest() {
  return {
    orderId: "order-1", userId: "user-1", symbol: "EURUSD",
    side: "BUY" as const, type: "MARKET" as const,
    quantity: 10_000, leverage: 10, marginRequired: 100, notional: 10_870,
  };
}

function fillWithFee(fees: number) {
  return { averagePrice: 1.0870, filledQuantity: 10_000, remainingQuantity: 0, partialFill: false, slippage: 0, fees };
}

function lastRejectedEmit() {
  const call = emitSpy.mock.calls.find((c) => c[0] === "order.rejected");
  return call?.[1] as { orderId: string; userId: string; symbol: string; reason: string; timestamp: string } | undefined;
}

/** Precisely distinguishes the margin-lock UPDATE, the fee-charge UPDATE,
 *  and the diagnostic SELECT -- unlike other execution.engine test files'
 *  shared dispatcher, which routes the fee-charge query into the generic
 *  "WalletAccount" branch (a false-positive pass, since it never actually
 *  simulates the fee-charge's own conditional-UPDATE-returns-empty
 *  failure mode). walletBalance is consumed by the margin lock first;
 *  feeAvailableBalance independently controls whether the LATER fee
 *  charge succeeds, so the two can be tested independently. */
function makeQueryRawDispatcher(walletBalance: string, walletLocked: string, feeAvailableBalance: string) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("");
    if (sql.includes("SET locked = locked +")) {
      const required = values[0] as { toNumber?: () => number };
      const requiredNum = typeof required?.toNumber === "function" ? required.toNumber() : Number(required);
      const available = parseFloat(walletBalance) - parseFloat(walletLocked);
      if (available < requiredNum || parseFloat(walletBalance) <= 0) return Promise.resolve([]);
      return Promise.resolve([{ id: "ledger-margin" }]);
    }
    if (sql.includes("SET balance = balance -")) {
      const feeRequired = values[0] as { toNumber?: () => number };
      const feeRequiredNum = typeof feeRequired?.toNumber === "function" ? feeRequired.toNumber() : Number(feeRequired);
      if (parseFloat(feeAvailableBalance) < feeRequiredNum) return Promise.resolve([]);
      return Promise.resolve([{ id: "ledger-fee" }]);
    }
    if (sql.includes("WalletAccount")) {
      return Promise.resolve([{ balance: walletBalance, locked: walletLocked }]);
    }
    if (sql.includes("filledQuantity")) {
      return Promise.resolve([{ status: "FILLED", filledQty: "10000", qty: "10000" }]);
    }
    return Promise.resolve([]);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetQuote.mockReturnValue(ORIGINAL_QUOTE);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
  mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("100000", "0", "100000"));
  mockTx.position.create.mockResolvedValue({});
  mockTx.outboxEvent.create.mockResolvedValue({ id: "outbox-1" });
  mockFill.mockReturnValue(fillWithFee(1.08));
});

describe("ExecutionEngine.execute() — PHASE2_REMEDIATION (H7): execution fee is actually charged", () => {
  it("issues a conditional UPDATE against WalletAccount.balance for the fee amount, inside the same transaction", async () => {
    await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    const feeCall = mockTx.$queryRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join("").includes("SET balance = balance -"));
    expect(feeCall).toBeDefined();
    const feeAmount = feeCall![1] as { toNumber?: () => number };
    expect(feeAmount.toNumber?.()).toBeCloseTo(1.08, 2);
  });

  it("writes a COMMISSION ledger entry, DR CLIENT / CR BROKER_COMMISSION, matching settlement.engine.ts's close-time shape", async () => {
    await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    const feeCall = mockTx.$queryRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join("").includes("SET balance = balance -"));
    const sql = (feeCall![0] as TemplateStringsArray).join("");
    expect(sql).toContain("'COMMISSION'");
    expect(sql).toContain("BROKER_COMMISSION");
  });

  it("does NOT charge a fee (no UPDATE issued) when fillResult.fees is 0", async () => {
    mockFill.mockReturnValue(fillWithFee(0));

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("FILLED");
    const feeCall = mockTx.$queryRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join("").includes("SET balance = balance -"));
    expect(feeCall).toBeUndefined();
  });

  it("rejects with FEE_CHARGE_FAILED and rolls back (no position created) when free balance can't cover the fee", async () => {
    mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("100000", "0", "0.50")); // less than the 1.08 fee
    mockFill.mockReturnValue(fillWithFee(1.08));

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("FEE_CHARGE_FAILED");
    expect(mockTx.position.create).not.toHaveBeenCalled();
    expect(lastRejectedEmit()?.reason).toContain("insufficient free balance");
  });

  it("charges the fee AFTER the margin lock and per-symbol/per-client risk checks, before position creation", async () => {
    await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    const calls = mockTx.$queryRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join(""));
    const marginIdx = calls.findIndex((sql) => sql.includes("SET locked = locked +"));
    const feeIdx    = calls.findIndex((sql) => sql.includes("SET balance = balance -"));
    const positionCallOrder = mockTx.position.create.mock.invocationCallOrder[0];

    expect(marginIdx).toBeGreaterThanOrEqual(0);
    expect(feeIdx).toBeGreaterThan(marginIdx);
    // position.create() happens strictly after the fee's $queryRaw call --
    // compare against the query-raw call's own invocation order, not array index.
    const feeCallOrder = mockTx.$queryRaw.mock.invocationCallOrder[feeIdx]!;
    expect(feeCallOrder).toBeLessThan(positionCallOrder!);
  });

  it("still fills successfully and creates the position when the fee charge succeeds", async () => {
    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("FILLED");
    expect(mockTx.position.create).toHaveBeenCalledTimes(1);
  });
});
