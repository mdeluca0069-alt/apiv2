/**
 * execution.engine.rejectorder.cleanup.failure.spec.ts
 *
 * PHASE E (failure-injection audit): every `orderLifecycle.rejectOrder()`
 * call inside ExecutionEngine.execute()'s catch block (compensating for a
 * transaction failure) and its `!outcome.ok` branch (MARGIN_INSUFFICIENT)
 * was unguarded -- unlike order.controller.ts's equivalent transactional-
 * failure compensating calls, which are already `.catch(() => {})`-guarded
 * (checkAndLockMargin/pendingOrderBook.add failure paths). If the DB was
 * also unavailable right when execute() tried to persist the rejection --
 * a plausible correlated failure, not an independent coincidence, since
 * the original failure was itself often a DB/transaction error -- the
 * resulting throw replaced the original error entirely and propagated out
 * of execute() uncaught, skipping emitOrderRejected() and the REJECTED
 * return. The caller (the execution queue worker) would see an unhandled
 * exception instead of a REJECTED result, for an order now stuck ACCEPTED
 * with no compensating record of why it failed.
 *
 * Fix: every such rejectOrder() call is now `.catch()`-guarded (logging,
 * not silently swallowed) so execute() always still returns its REJECTED
 * result and still calls emitOrderRejected(), even when the compensating
 * persistence itself fails.
 *
 * Reuses execution.engine.rejection.events.spec.ts's mocking scaffold
 * (same real orderLifecycle module, backed by the mocked shared/db.js
 * prisma singleton -- rejectOrder() ultimately calls db.$executeRaw()).
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
    // rejectOrder() -> transition() calls this directly (not via tx) --
    // this is the call that must be made to fail to reproduce the bug.
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
vi.mock("../risk-service/client.exposure.limits.js", () => ({
  clientExposureLimits: { checkAtomic: vi.fn().mockResolvedValue({ ok: true }) },
}));
vi.mock("../risk-service/concentration.guard.js", () => ({
  concentrationGuard: { checkAtomic: vi.fn().mockResolvedValue({ ok: true }) },
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

function makeQueryRawDispatcher(walletBalance: string, walletLocked: string) {
  return (strings: TemplateStringsArray) => {
    const sql = strings.join("");
    if (sql.includes("SET locked = locked +")) {
      const available = Number(walletBalance) - Number(walletLocked);
      return Promise.resolve(available >= 1086.70 ? [{ id: "ledger-1" }] : []);
    }
    if (sql.includes("WalletAccount")) return Promise.resolve([{ balance: walletBalance, locked: walletLocked }]);
    if (sql.includes("filledQuantity")) return Promise.resolve([{ status: "FILLED", filledQty: "10000", qty: "10000" }]);
    return Promise.resolve([]);
  };
}

/**
 * execute() also calls orderLifecycle.transition(..., "ACCEPTED", ...)
 * BEFORE the try/catch this fix targets -- that call goes through the
 * same prisma.$executeRaw, but is unrelated and must keep succeeding, or
 * every test would fail before ever reaching the code under test. Only
 * the REJECTED-transition UPDATE (identifiable by its "rejectionReason"
 * column) simulates the correlated DB outage.
 */
function failOnlyRejectionUpdate(err: Error) {
  return (strings: TemplateStringsArray) => {
    const sql = strings.join("");
    if (sql.includes(`"rejectionReason"`)) return Promise.reject(err);
    return Promise.resolve(undefined);
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetQuote.mockReturnValue(ORIGINAL_QUOTE);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
  mockPrisma.$executeRaw.mockResolvedValue(undefined);
  mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("100000", "0"));
  mockTx.position.create.mockResolvedValue({});
  mockTx.outboxEvent.create.mockResolvedValue({ id: "outbox-1" });
  mockCheckCanOpenAtomic.mockResolvedValue({ ok: true });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

function lastRejectedEmit() {
  const call = emitSpy.mock.calls.find((c) => c[0] === "order.rejected");
  return call?.[1] as { orderId: string; userId: string; symbol: string; reason: string; timestamp: string } | undefined;
}

describe("ExecutionEngine.execute() — PHASE E: rejectOrder() itself failing during compensation", () => {
  it("catch-block branch (generic transaction failure): still returns REJECTED and still emits order.rejected even when rejectOrder() ALSO throws", async () => {
    mockFill.mockReturnValue(fullFillResult());
    mockPrisma.$transaction.mockRejectedValue(new Error("connection reset"));
    // The compensating rejectOrder() call goes through prisma.$executeRaw
    // directly (not via tx, since the transaction already failed/rolled
    // back) -- fail that too, simulating a correlated DB outage.
    mockPrisma.$executeRaw.mockImplementation(failOnlyRejectionUpdate(new Error("db unreachable")));

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("LP_UNAVAILABLE");
    // emitOrderRejected must still fire -- previously the uncaught rejectOrder()
    // throw would have propagated out of execute() before this line ran.
    expect(lastRejectedEmit()).toBeDefined();
    expect(lastRejectedEmit()!.reason).toContain("connection reset");
    // The cleanup failure itself must be logged, not silently discarded.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("rejectOrder() itself failed"),
      expect.any(String),
    );
  });

  it("MARGIN_INSUFFICIENT branch (!outcome.ok): still returns REJECTED and still emits order.rejected even when rejectOrder() ALSO throws", async () => {
    mockFill.mockReturnValue(fullFillResult());
    mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("50", "0")); // far below required margin
    mockPrisma.$executeRaw.mockImplementation(failOnlyRejectionUpdate(new Error("db unreachable")));

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("MARGIN_INSUFFICIENT");
    expect(lastRejectedEmit()).toBeDefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("rejectOrder() itself failed"),
      expect.any(String),
    );
  });

  it("regression check: when rejectOrder() succeeds normally, no cleanup-failure log is emitted", async () => {
    mockFill.mockReturnValue(fullFillResult());
    mockPrisma.$transaction.mockRejectedValue(new Error("connection reset"));
    // $executeRaw stays healthy (default mockResolvedValue from beforeEach).

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect(lastRejectedEmit()).toBeDefined();
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("rejectOrder() itself failed"),
      expect.anything(),
    );
  });
});
