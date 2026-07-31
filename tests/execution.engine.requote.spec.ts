/**
 * execution.engine.requote.spec.ts
 *
 * FASE 3.3 — Internal Liquidity Engine.
 *
 * Proves ExecutionEngine.execute() rejects with REQUOTE, cheaply and before
 * any transaction starts (no margin lock, no position, no fill attempted),
 * when the live quote has drifted beyond tolerance from the one the order
 * was originally queued with — and that it fails open (executes normally)
 * when quoteCache has no live quote to compare against, since this is a new
 * protective check layered on top of the existing pipeline, not a
 * replacement for any of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetQuote, mockIsStale } = vi.hoisted(() => ({
  mockGetQuote: vi.fn(),
  // MARKET_DATA_FREEZE.md §0.13: defaults to "live" so the pre-existing
  // requote-drift scenarios below are unaffected; the dedicated stale-feed
  // scenario overrides this explicitly.
  mockIsStale:  vi.fn().mockReturnValue(false),
}));
vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockGetQuote, isStale: mockIsStale },
}));

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
// eligibility (KYC) and the kill switch before proceeding -- not the
// subject of this file, so both pass by default.
vi.mock("../risk-service/risk.engine.js", () => ({
  assertAccountEligibleToTrade: vi.fn().mockResolvedValue({ eligible: true }),
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

const { executionEngine } = await import("../execution-service/execution.engine.js");

const REQ = {
  orderId: "order-1", userId: "user-1", symbol: "EURUSD",
  side: "BUY" as const, type: "MARKET" as const,
  quantity: 10_000, leverage: 10, marginRequired: 100, notional: 10_870,
};
const ORIGINAL_QUOTE = { bid: 1.0868, ask: 1.0870, mid: 1.0869, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 };

function fullFillResult() {
  return {
    averagePrice: 1.0870, filledQuantity: 10_000, remainingQuantity: 0,
    partialFill: false, slippage: 0, fees: 1.08,
  };
}

// tx.$queryRaw serves three distinct callers (margin.controller.ts's
// conditional-lock UPDATE, its diagnostic fallback SELECT, and
// order.lifecycle.ts's recordFillLeg UPDATE) — dispatch on the query text,
// same helper as execution.engine.atomic.spec.ts.
function makeQueryRawDispatcher(walletBalance: string, walletLocked: string) {
  return (strings: TemplateStringsArray) => {
    const sql = strings.join("");
    if (sql.includes("SET locked = locked +")) {
      return Promise.resolve([{ id: "ledger-1" }]);
    }
    if (sql.includes("WalletAccount")) {
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
  mockIsStale.mockReturnValue(false);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
  mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("10000", "0"));
  mockTx.position.create.mockResolvedValue({});
  mockTx.outboxEvent.create.mockResolvedValue({ id: "outbox-1" });
  mockCheckCanOpenAtomic.mockResolvedValue({ ok: true });
  mockFill.mockReturnValue(fullFillResult());
});

describe("ExecutionEngine.execute() — requote check", () => {
  it("rejects with REQUOTE when the live ask drifted beyond tolerance, before any transaction starts", async () => {
    mockGetQuote.mockReturnValue({ bid: 1.0898, ask: 1.0900, mid: 1.0899, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 }); // ~0.276% ask move

    const result = await executionEngine.execute(REQ, ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("REQUOTE");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockFill).not.toHaveBeenCalled();
  });

  it("executes normally when the live quote is within tolerance", async () => {
    mockGetQuote.mockReturnValue({ bid: 1.0869, ask: 1.0871, mid: 1.0870, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 }); // negligible move

    const result = await executionEngine.execute(REQ, ORIGINAL_QUOTE);

    expect(result.status).toBe("FILLED");
    expect(mockFill).toHaveBeenCalledTimes(1);
  });

  it("still executes when quoteCache has no live quote to compare against but the symbol is NOT flagged stale (edge case: fails open on the drift check specifically)", async () => {
    // checkRequote() itself has nothing to compare against and is skipped --
    // this isolates that the drift check alone still fails open, distinct
    // from the dedicated stale-feed gate below.
    mockGetQuote.mockReturnValue(undefined);

    const result = await executionEngine.execute(REQ, ORIGINAL_QUOTE);

    expect(result.status).toBe("FILLED");
    expect(mockFill).toHaveBeenCalledTimes(1);
  });
});

describe("ExecutionEngine.execute() — stale-feed gate at fill time (MARKET_DATA_FREEZE.md §0.13)", () => {
  it("rejects with NO_LIVE_MARKET_DATA when the feed went stale while the order was queued, instead of filling against a frozen price", async () => {
    // This is exactly the gap checkRequote() alone can't catch: the feed
    // died completely after order acceptance, so quoteCache still returns
    // the SAME quote it had at acceptance time (0% drift) -- but it's now
    // flagged stale.
    mockGetQuote.mockReturnValue(ORIGINAL_QUOTE);
    mockIsStale.mockReturnValue(true);

    const result = await executionEngine.execute(REQ, ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("NO_LIVE_MARKET_DATA");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockFill).not.toHaveBeenCalled();
  });

  it("does not reject on staleness when the feed is live", async () => {
    mockGetQuote.mockReturnValue({ bid: 1.0869, ask: 1.0871, mid: 1.0870, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 });
    mockIsStale.mockReturnValue(false);

    const result = await executionEngine.execute(REQ, ORIGINAL_QUOTE);

    expect(result.status).toBe("FILLED");
  });
});
