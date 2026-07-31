/**
 * execution.engine.account.eligibility.spec.ts
 *
 * CRITICAL_REMEDIATION Phase 2 (H15) — ExecutionEngine.execute() re-checks
 * account eligibility (KYC status) and the kill switch at the moment of
 * actual execution, not only at order-request time.
 *
 * Root cause, confirmed via code trace: risk.engine.ts's preTradeCheck()
 * correctly gated kycStatus==="approved" and the kill switch at ORDER-
 * REQUEST time, but execute() -- the shared path for both an immediate
 * MARKET fill and a resting LIMIT/STOP order's later fill (trading-
 * service/order.controller.ts's executePendingOrder() calls this same
 * execute(), with no re-check of its own) -- never re-verified either.
 * A resting order placed while the account was KYC-approved and the kill
 * switch was off could still fill hours or days later even if an admin
 * had since revoked KYC approval (the only account-freeze mechanism this
 * schema has -- no separate frozen/suspended column exists) or activated
 * the kill switch.
 *
 * These tests exercise execute() directly (the function both callers
 * funnel through), mirroring the mocking pattern already established in
 * tests/execution.engine.rejection.events.spec.ts.
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
    position:    { create: vi.fn() },
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

vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn(), observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

vi.mock("../settlement/reconciliation.engine.js", () => ({
  reconciliationEngine: { repairOrphanMargin: vi.fn().mockResolvedValue(0) },
}));

const { mockAssertEligible } = vi.hoisted(() => ({ mockAssertEligible: vi.fn() }));
vi.mock("../risk-service/risk.engine.js", () => ({
  assertAccountEligibleToTrade: mockAssertEligible,
}));

const { mockIsActive, mockGetState } = vi.hoisted(() => ({
  mockIsActive: vi.fn(), mockGetState: vi.fn(),
}));
vi.mock("../risk-service/kill.switch.js", () => ({
  killSwitch: { isActive: mockIsActive, getState: mockGetState },
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
  mockFill.mockReturnValue(fullFillResult());
  // Defaults: eligible account, kill switch off -- individual tests override.
  mockAssertEligible.mockResolvedValue({ eligible: true });
  mockIsActive.mockReturnValue(false);
  mockGetState.mockReturnValue({ active: false, reason: "" });
});

describe("ExecutionEngine.execute() — CRITICAL_REMEDIATION (H15): account eligibility re-checked at fill time", () => {
  it("rejects with KYC_NOT_APPROVED when the account is no longer KYC-eligible, even though this represents a RESTING order that was approved at request time", async () => {
    mockAssertEligible.mockResolvedValue({ eligible: false, reason: "KYC status is 'rejected'. Trading requires approved KYC." });

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("KYC_NOT_APPROVED");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled(); // no margin lock, no position — rejected before any money moves
    expect(lastRejectedEmit()?.reason).toContain("KYC status is 'rejected'");
  });

  it("rejects with KILL_SWITCH_ACTIVE when the kill switch was activated after the order was originally accepted", async () => {
    mockIsActive.mockReturnValue(true);
    mockGetState.mockReturnValue({ active: true, reason: "Emergency halt — market anomaly detected" });

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("KILL_SWITCH_ACTIVE");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(lastRejectedEmit()?.reason).toContain("Emergency halt");
  });

  it("kill switch is checked before KYC eligibility (fails fastest, no DB call needed)", async () => {
    mockIsActive.mockReturnValue(true);
    mockGetState.mockReturnValue({ active: true, reason: "halt" });
    mockAssertEligible.mockResolvedValue({ eligible: false, reason: "should not be reached" });

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect((result as { reason?: string }).reason).toBe("KILL_SWITCH_ACTIVE");
    expect(mockAssertEligible).not.toHaveBeenCalled();
  });

  it("still fills normally when eligible and the kill switch is inactive (no false positives)", async () => {
    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("FILLED");
    expect(mockAssertEligible).toHaveBeenCalledWith("user-1");
    expect(lastRejectedEmit()).toBeUndefined();
  });

  it("the eligibility/kill-switch check runs BEFORE the ACCEPTED lifecycle transition -- a rejected order never shows as accepted", async () => {
    mockAssertEligible.mockResolvedValue({ eligible: false, reason: "rejected" });
    const transitionCalls: string[] = [];
    // orderLifecycle.transition/rejectOrder both go through db.$executeRaw directly;
    // capture the raw SQL to confirm no "ACCEPTED" transition was ever written.
    mockPrisma.$executeRaw.mockImplementation((_strings: TemplateStringsArray, ...values: unknown[]) => {
      transitionCalls.push(JSON.stringify(values));
      return Promise.resolve(undefined);
    });

    await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(transitionCalls.some((c) => c.includes("ACCEPTED"))).toBe(false);
    expect(transitionCalls.some((c) => c.includes("REJECTED"))).toBe(true);
  });
});
