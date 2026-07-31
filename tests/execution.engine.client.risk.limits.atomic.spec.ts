/**
 * execution.engine.client.risk.limits.atomic.spec.ts
 *
 * PHASE2_REMEDIATION (H6) — risk.engine.ts's preTradeCheck() already ran
 * clientExposureLimits.check() and concentrationGuard.check() as SOFT,
 * non-locking pre-trade reads (both files' own doc comments already
 * flagged this: "a same-instant double-submit race here could in theory
 * admit one order slightly over cap"). Only exposureRegistry's PER-SYMBOL
 * check was re-validated atomically inside execution.engine.ts's unified
 * transaction (via checkCanOpenAtomic()) -- per-CLIENT exposure and
 * concentration caps were not, so two near-simultaneous orders for the
 * same client could both pass the soft check and both commit, together
 * breaching a cap neither alone would have.
 *
 * Fix: execute() now also calls clientExposureLimits.checkAtomic() and
 * concentrationGuard.checkAtomic() inside the same transaction, after the
 * margin lock and per-symbol exposure check, before position creation.
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

const { mockAssertEligible, mockGetCachedUserTier } = vi.hoisted(() => ({
  mockAssertEligible: vi.fn().mockResolvedValue({ eligible: true }),
  mockGetCachedUserTier: vi.fn().mockResolvedValue("STANDARD"),
}));
vi.mock("../risk-service/risk.engine.js", () => ({
  assertAccountEligibleToTrade: mockAssertEligible,
  getCachedUserTier: mockGetCachedUserTier,
}));
vi.mock("../risk-service/kill.switch.js", () => ({
  killSwitch: { isActive: vi.fn().mockReturnValue(false), getState: vi.fn().mockReturnValue({ active: false, reason: "" }) },
}));

const { mockFill } = vi.hoisted(() => ({ mockFill: vi.fn() }));
vi.mock("../execution-service/fill.engine.js", () => ({
  fillEngine: { fill: mockFill, providerId: "MOCK_LP" },
}));

const { mockCheckCanOpenAtomic } = vi.hoisted(() => ({
  mockCheckCanOpenAtomic: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../risk-service/exposure.limits.js", () => ({
  exposureRegistry: {
    openPosition: vi.fn(), closePosition: vi.fn(),
    checkCanOpenAtomic: mockCheckCanOpenAtomic,
  },
}));

const { mockClientExposureCheckAtomic } = vi.hoisted(() => ({
  mockClientExposureCheckAtomic: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../risk-service/client.exposure.limits.js", () => ({
  clientExposureLimits: { checkAtomic: mockClientExposureCheckAtomic },
}));

const { mockConcentrationCheckAtomic } = vi.hoisted(() => ({
  mockConcentrationCheckAtomic: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../risk-service/concentration.guard.js", () => ({
  concentrationGuard: { checkAtomic: mockConcentrationCheckAtomic },
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

function fullFillResult() {
  return { averagePrice: 1.0870, filledQuantity: 10_000, remainingQuantity: 0, partialFill: false, slippage: 0, fees: 1.08 };
}

function lastRejectedEmit() {
  const call = emitSpy.mock.calls.find((c) => c[0] === "order.rejected");
  return call?.[1] as { orderId: string; userId: string; symbol: string; reason: string; timestamp: string } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetQuote.mockReturnValue(ORIGINAL_QUOTE);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
  mockTx.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
    const sql = strings.join("");
    if (sql.includes("SET locked = locked +")) return Promise.resolve([{ id: "ledger-1" }]);
    if (sql.includes("WalletAccount")) return Promise.resolve([{ balance: "100000", locked: "0" }]);
    if (sql.includes("filledQuantity")) return Promise.resolve([{ status: "FILLED", filledQty: "10000", qty: "10000" }]);
    return Promise.resolve([]);
  });
  mockTx.position.create.mockResolvedValue({});
  mockTx.outboxEvent.create.mockResolvedValue({ id: "outbox-1" });
  mockCheckCanOpenAtomic.mockResolvedValue({ ok: true });
  mockClientExposureCheckAtomic.mockResolvedValue({ ok: true });
  mockConcentrationCheckAtomic.mockResolvedValue({ ok: true });
  mockAssertEligible.mockResolvedValue({ eligible: true });
  mockGetCachedUserTier.mockResolvedValue("STANDARD");
  mockFill.mockReturnValue(fullFillResult());
});

describe("ExecutionEngine.execute() — PHASE2_REMEDIATION (H6): atomic per-client exposure/concentration re-check", () => {
  it("calls clientExposureLimits.checkAtomic() and concentrationGuard.checkAtomic() inside the SAME tx as the margin lock", async () => {
    await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(mockClientExposureCheckAtomic).toHaveBeenCalledWith(mockTx, "user-1", "STANDARD", expect.any(Number));
    expect(mockConcentrationCheckAtomic).toHaveBeenCalledWith(mockTx, "user-1", "EURUSD", expect.any(Number));
  });

  it("rejects with CLIENT_EXPOSURE_LIMIT_EXCEEDED and rolls back (no position created) when the atomic client-exposure check fails", async () => {
    mockClientExposureCheckAtomic.mockResolvedValue({
      ok: false, reason: "CLIENT_EXPOSURE_LIMIT_EXCEEDED", detail: "STANDARD tier cap exceeded",
    });

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("CLIENT_EXPOSURE_LIMIT_EXCEEDED");
    expect(mockTx.position.create).not.toHaveBeenCalled();
    expect(lastRejectedEmit()?.reason).toContain("STANDARD tier cap exceeded");
  });

  it("rejects with CONCENTRATION_LIMIT_EXCEEDED and rolls back (no position created) when the atomic concentration check fails", async () => {
    mockConcentrationCheckAtomic.mockResolvedValue({
      ok: false, reason: "CONCENTRATION_LIMIT_EXCEEDED", detail: "HHI 55.0 exceeds limit",
    });

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("CONCENTRATION_LIMIT_EXCEEDED");
    expect(mockTx.position.create).not.toHaveBeenCalled();
  });

  it("checks client-exposure BEFORE concentration, and both AFTER the per-symbol exposure check", async () => {
    await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    const symbolOrder = mockCheckCanOpenAtomic.mock.invocationCallOrder[0]!;
    const clientOrder  = mockClientExposureCheckAtomic.mock.invocationCallOrder[0]!;
    const concOrder    = mockConcentrationCheckAtomic.mock.invocationCallOrder[0]!;

    expect(symbolOrder).toBeLessThan(clientOrder);
    expect(clientOrder).toBeLessThan(concOrder);
  });

  it("still fills normally when both atomic checks pass (no false positives)", async () => {
    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("FILLED");
    expect(lastRejectedEmit()).toBeUndefined();
  });

  it("looks up the user's tier via the shared 60s-TTL cache (getCachedUserTier), not a fresh query", async () => {
    await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(mockGetCachedUserTier).toHaveBeenCalledWith("user-1");
  });
});
