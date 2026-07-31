/**
 * execution.engine.atomic.spec.ts
 *
 * FASE 2.1/2.2 — Core Trading Certification.
 *
 * Proves that ExecutionEngine.execute()'s margin-lock, position-create, Fill
 * record, filledQuantity increment, status transition, and OutboxEvent are
 * one atomic unit: either all of them commit together, or none do.
 *
 * order.lifecycle.ts and margin.controller.ts run for real here (not mocked)
 * against a fake `tx` object — this exercises the actual composability those
 * modules now provide (an optional `db`/`tx` parameter defaulting to the
 * top-level prisma client), not just a re-statement of the test's own mocks.
 * Only shared/db.ts (prisma), fill.engine.ts, exposure.limits.ts,
 * gateway/metrics.ts, quote.cache.ts, and reconciliation.engine.ts are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eventBus } from "../events-bus/event.bus.js";

const { mockTx, mockPrisma } = vi.hoisted(() => {
  const mockTx = {
    $queryRaw:   vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    // PHASE2_REMEDIATION (H4): checkAndLockMargin()'s atomic claim now also
    // reads open positions to compute live unrealizedPnl -- empty here (no
    // open positions relevant to this file's scope), so the equity-aware
    // gate behaves identically to the old balance-only one for these tests.
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

// CRITICAL_REMEDIATION Phase 2 (H15): execute() now re-checks account
// eligibility (KYC) and the kill switch before proceeding -- this file
// tests margin/atomicity, not account eligibility, so both pass by default.
vi.mock("../risk-service/risk.engine.js", () => ({
  assertAccountEligibleToTrade: vi.fn().mockResolvedValue({ eligible: true }),
  getCachedUserTier: vi.fn().mockResolvedValue("STANDARD"),
}));
// PHASE2_REMEDIATION (H6): execute()'s transaction now also atomically
// re-checks per-client exposure/concentration caps -- default to success.
vi.mock("../risk-service/client.exposure.limits.js", () => ({
  clientExposureLimits: { checkAtomic: vi.fn().mockResolvedValue({ ok: true }) },
}));
vi.mock("../risk-service/concentration.guard.js", () => ({
  concentrationGuard: { checkAtomic: vi.fn().mockResolvedValue({ ok: true }) },
}));
vi.mock("../risk-service/kill.switch.js", () => ({
  killSwitch: { isActive: vi.fn().mockReturnValue(false), getState: vi.fn().mockReturnValue({ active: false }) },
}));

const { mockFill } = vi.hoisted(() => ({ mockFill: vi.fn() }));
vi.mock("../execution-service/fill.engine.js", () => ({
  fillEngine: { fill: mockFill, providerId: "MOCK_LP" },
}));

// MARKET_DATA_FREEZE.md §0.13: this file tests margin/atomicity, not market
// data -- quoteCache mocked minimally so the new stale-feed gate in
// execute() never fires here (get() has no live-quote-drift assertions in
// this file either, so `undefined` -- fails open on the drift check --
// matches this file's original, unmocked-but-effectively-empty behavior).
vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: vi.fn().mockReturnValue(undefined), isStale: vi.fn().mockReturnValue(false) },
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

const { executionEngine } = await import("../execution-service/execution.engine.js");

const REQ = {
  orderId: "order-1", userId: "user-1", symbol: "EURUSD",
  side: "BUY" as const, type: "MARKET" as const,
  quantity: 10_000, leverage: 10, marginRequired: 100, notional: 10_870,
};
const QUOTE = { bid: 1.0868, ask: 1.0870, mid: 1.0869, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 };

function fullFillResult() {
  return {
    averagePrice: 1.0870, filledQuantity: 10_000, remainingQuantity: 0,
    partialFill: false, slippage: 0, fees: 1.08,
  };
}

/** tx.$queryRaw serves three distinct callers — margin.controller.ts's atomic
 *  conditional lock UPDATE, its diagnostic fallback SELECT (only reached when
 *  the conditional UPDATE affects 0 rows), and order.lifecycle.ts's
 *  recordFillLeg UPDATE — dispatch on the query text (the tagged-template's
 *  first arg) so each gets the shape (and, for the conditional UPDATE, the
 *  WHERE-clause semantics) it expects. */
function makeQueryRawDispatcher(walletBalance: string, walletLocked: string) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("");
    if (sql.includes("SET locked = locked +")) {
      // Simulate the real conditional UPDATE ... WHERE (balance - locked) >= required:
      // 0 rows back if insufficient, matching real Postgres — a naive mock that
      // always returns a row would hide the insufficient-margin case entirely.
      const required = values[0] as { toNumber?: () => number; toString: () => string };
      const requiredNum = typeof required?.toNumber === "function" ? required.toNumber() : parseFloat(String(required));
      const available = parseFloat(walletBalance) - parseFloat(walletLocked);
      if (available < requiredNum || parseFloat(walletBalance) <= 0) return Promise.resolve([]);
      // FASE 2.3 perf: this is now a CTE returning the LedgerEntry INSERT's
      // RETURNING id, not the wallet's balance/locked.
      return Promise.resolve([{ id: "ledger-1" }]);
    }
    if (sql.includes("WalletAccount")) {
      // Diagnostic-only fallback SELECT — plain snapshot read.
      return Promise.resolve([{ balance: walletBalance, locked: walletLocked }]);
    }
    if (sql.includes("filledQuantity")) {
      return Promise.resolve([{ status: "FILLED", filledQty: String(REQ.quantity), qty: String(REQ.quantity) }]);
    }
    return Promise.resolve([]);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
  // Wallet row with plenty of free margin, by default.
  mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("10000", "0"));
  mockTx.position.create.mockResolvedValue({});
  mockTx.outboxEvent.create.mockResolvedValue({ id: "outbox-1" });
  mockCheckCanOpenAtomic.mockResolvedValue({ ok: true });
});

describe("ExecutionEngine.execute() — full fill is one atomic transaction", () => {
  it("commits margin lock, position, fill, increment, transition, and outbox inside a single $transaction", async () => {
    mockFill.mockReturnValue(fullFillResult());
    const emitted: unknown[] = [];
    const onFilled = (e: unknown) => emitted.push(e);
    eventBus.on("order.filled", onFilled);

    const result = await executionEngine.execute(REQ, QUOTE);

    eventBus.off("order.filled", onFilled);

    expect(result.status).toBe("FILLED");
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // All the writes happened against the SAME tx passed into the transaction
    // callback, not against the top-level prisma client. Margin lock + its
    // MARGIN_LOCK ledger leg are one $queryRaw CTE now (FASE 2.2/2.3 perf),
    // not walletAccount.update / ledgerEntry.create.
    expect(mockTx.$queryRaw).toHaveBeenCalled();
    expect(mockTx.ledgerEntry.create).not.toHaveBeenCalled();
    expect(mockTx.position.create).toHaveBeenCalledTimes(1);
    expect(mockTx.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(mockTx.outboxEvent.create.mock.calls[0][0].data.eventType).toBe("order.filled");

    // The outbox row's id, created inside the transaction, is threaded through
    // to the emitted event so the WS bridge can mark it published instead of
    // creating a redundant second row.
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { outboxId: string }).outboxId).toBe("outbox-1");
  });

  it("instrument exposure halted: throws inside the transaction (not a plain return) so the already-written margin lock rolls back too", async () => {
    mockFill.mockReturnValue(fullFillResult());
    mockCheckCanOpenAtomic.mockResolvedValue({
      ok: false, reason: "INSTRUMENT_HALTED", detail: "EURUSD gross exposure would be 99999999 USD (limit: 10000000 USD)",
    });

    const result = await executionEngine.execute(REQ, QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("INSTRUMENT_HALTED");
    expect(mockCheckCanOpenAtomic).toHaveBeenCalledWith(mockTx, REQ.symbol, REQ.side, REQ.notional);
    // By the time the exposure check runs, margin.controller.ts has already
    // written the lock (this mock can't observe a real Postgres rollback,
    // but the code path here must THROW rather than return {ok:false} — a
    // plain return would let the callback "succeed" and commit those writes
    // instead of rolling them back; a real-DB regression test for this
    // exact class of bug lives in the k6 benchmark / invariants.sql gate).
    expect(mockTx.position.create).not.toHaveBeenCalled();
    expect(mockTx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("insufficient margin: rejects before any position, fill, or outbox row is created", async () => {
    mockFill.mockReturnValue(fullFillResult());
    mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("50", "0")); // less than marginRequired=100

    const result = await executionEngine.execute(REQ, QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("MARGIN_INSUFFICIENT");
    expect(mockTx.ledgerEntry.create).not.toHaveBeenCalled(); // no MARGIN_LOCK leg written
    expect(mockTx.position.create).not.toHaveBeenCalled();
    expect(mockTx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("a failure after margin lock (e.g. the outbox insert) rolls back the whole unit — no order.filled/position.opened is ever observed", async () => {
    mockFill.mockReturnValue(fullFillResult());
    mockTx.outboxEvent.create.mockRejectedValue(new Error("simulated outbox insert failure"));
    // A real Prisma $transaction rolls back (and rejects) when the callback
    // throws — reproduce that here since mockTx writes aren't backed by a
    // real DB that would do this for us.
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => {
      return fn(mockTx); // the callback's own rejection propagates — no catch here
    });

    const filledEvents: unknown[] = [];
    const openedEvents: unknown[] = [];
    const onFilled = (e: unknown) => filledEvents.push(e);
    const onOpened = (e: unknown) => openedEvents.push(e);
    eventBus.on("order.filled", onFilled);
    eventBus.on("position.opened", onOpened);

    const result = await executionEngine.execute(REQ, QUOTE);

    eventBus.off("order.filled", onFilled);
    eventBus.off("position.opened", onOpened);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("LP_UNAVAILABLE");
    // The transaction did attempt the writes (proving they're all in the same
    // unit — a real Postgres transaction would undo mockTx.walletAccount.update
    // and mockTx.position.create here too), but no domain event for a
    // successful fill/position was ever emitted, since the whole thing failed.
    expect(filledEvents).toHaveLength(0);
    expect(openedEvents).toHaveLength(0);
    // The order was explicitly rejected afterward (not left silently ACCEPTED).
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
  });
});
