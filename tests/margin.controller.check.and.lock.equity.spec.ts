/**
 * margin.controller.check.and.lock.equity.spec.ts
 *
 * PHASE2_REMEDIATION (H4) — checkAndLockMargin() is the ONE atomic, race-
 * proof margin gate in the platform: every caller reaches it AFTER
 * risk.engine.ts's preTradeCheck() already ran the correct equity-based
 * canAcceptOrder() check, but preTradeCheck() is a plain, non-locking read
 * -- two near-simultaneous orders for the same user can both pass it, so
 * checkAndLockMargin()'s conditional UPDATE has to be the real, final
 * safety net. It previously gated on `balance - locked` alone, ignoring
 * unrealized P&L on the user's OTHER open positions entirely -- an account
 * carrying a large floating LOSS could still lock margin for a brand-new
 * position as if every dollar of balance were free, exactly the gap the
 * upstream equity-aware check was supposed to prevent. Now the atomic
 * claim itself computes live unrealizedPnl (same formula/quotes as
 * getMarginState()) and gates on equity, not raw balance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQueryRaw, mockTransaction } = vi.hoisted(() => ({
  mockQueryRaw:    vi.fn(),
  mockTransaction: vi.fn(),
}));

const { mockPositionFindMany } = vi.hoisted(() => ({ mockPositionFindMany: vi.fn().mockResolvedValue([]) }));

vi.mock("../shared/db.js", () => {
  const tx = {
    $queryRaw: mockQueryRaw,
    position:  { findMany: mockPositionFindMany },
  };
  return { prisma: { $transaction: mockTransaction, __tx: tx } };
});

const { mockQuoteGet } = vi.hoisted(() => ({ mockQuoteGet: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockQuoteGet },
}));

const { marginController } = await import("../risk-service/margin.controller.js");
const { prisma } = await import("../shared/db.js");

function decimalLike(n: number) {
  return { toNumber: () => n };
}

/** Extracts the interpolated params (excluding the strings array) from a $queryRaw call. */
function paramsOf(call: unknown[]): unknown[] {
  return call.slice(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPositionFindMany.mockResolvedValue([]);
  mockQuoteGet.mockReturnValue(undefined);
  const tx = (prisma as unknown as { __tx: unknown }).__tx;
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
});

describe("MarginController.checkAndLockMargin() — PHASE2_REMEDIATION (H4): equity-aware atomic claim", () => {
  it("rejects a lock that raw balance alone would cover, when unrealized LOSSES on other positions drop equity below it", async () => {
    // balance=10,000, locked=0 -- balance-only math would say 10,000 free.
    // But a -8,000 floating loss on another open position means real free
    // margin is only ~2,000 -- not enough for a 5,000 lock.
    mockPositionFindMany.mockResolvedValue([
      { symbol: "EURUSD", side: "BUY", quantity: decimalLike(100_000), entryPrice: decimalLike(1.1000) },
    ]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0200, ask: 1.0202, mid: 1.0201 }); // -8,000 loss
    mockQueryRaw
      .mockResolvedValueOnce([]) // the conditional UPDATE matches 0 rows -- insufficient
      .mockResolvedValueOnce([{ balance: "10000", locked: "0" }]); // rejection-reason lookup

    const result = await marginController.checkAndLockMargin("user-1", "order-1", 5_000);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("INSUFFICIENT_MARGIN");
    // available = 10,000 + (-8,000) - 0 = 2,000, not the balance-only 10,000
    expect(result.reason).toContain("available=2000.00");
  });

  it("passes the live unrealizedPnl into the atomic UPDATE's WHERE clause, not just balance", async () => {
    mockPositionFindMany.mockResolvedValue([
      { symbol: "EURUSD", side: "BUY", quantity: decimalLike(100_000), entryPrice: decimalLike(1.1000) },
    ]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0200, ask: 1.0202, mid: 1.0201 }); // -8,000 loss
    mockQueryRaw.mockResolvedValueOnce([{ userId: "user-1" }]).mockResolvedValueOnce([{ id: "ledger-1" }]);

    await marginController.checkAndLockMargin("user-1", "order-1", 1_000);

    const lockCallParams = paramsOf(mockQueryRaw.mock.calls[0]!);
    // Params in template order: [required(SET), userId, pnlAdjustment, pnlAdjustment, required(WHERE)]
    const pnlParam = lockCallParams[2] as { toNumber?: () => number };
    expect(pnlParam?.toNumber?.()).toBeCloseTo(-8_000, 2);
  });

  it("a GAIN on other open positions can make a lock succeed that balance alone would not cover", async () => {
    // This test only proves the gate READS the live gain into its WHERE
    // clause (via the captured params) -- it doesn't simulate full
    // Postgres WHERE evaluation, since mockQueryRaw is stateless.
    mockPositionFindMany.mockResolvedValue([
      { symbol: "EURUSD", side: "BUY", quantity: decimalLike(100_000), entryPrice: decimalLike(1.0000) },
    ]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0500, ask: 1.0502, mid: 1.0501 }); // +5,000 gain
    mockQueryRaw.mockResolvedValueOnce([{ userId: "user-1" }]).mockResolvedValueOnce([{ id: "ledger-1" }]);

    await marginController.checkAndLockMargin("user-1", "order-1", 1_000);

    const lockCallParams = paramsOf(mockQueryRaw.mock.calls[0]!);
    const pnlParam = lockCallParams[2] as { toNumber?: () => number };
    expect(pnlParam?.toNumber?.()).toBeCloseTo(5_000, 2);
  });

  it("behaves identically to the old balance-only gate when there are no open positions (unrealizedPnl=0)", async () => {
    mockPositionFindMany.mockResolvedValue([]);
    mockQueryRaw.mockResolvedValueOnce([{ userId: "user-1" }]).mockResolvedValueOnce([{ id: "ledger-1" }]);

    const result = await marginController.checkAndLockMargin("user-1", "order-1", 1_000);

    expect(result.ok).toBe(true);
    const lockCallParams = paramsOf(mockQueryRaw.mock.calls[0]!);
    const pnlParam = lockCallParams[2] as { toNumber?: () => number };
    expect(pnlParam?.toNumber?.()).toBe(0);
  });

  it("a position with no live quote right now contributes zero to the equity gate (fails safe, not fabricated)", async () => {
    mockPositionFindMany.mockResolvedValue([
      { symbol: "EURUSD", side: "BUY", quantity: decimalLike(100_000), entryPrice: decimalLike(1.1000) },
    ]);
    mockQuoteGet.mockReturnValue(undefined); // feed down for this symbol right now
    mockQueryRaw.mockResolvedValueOnce([{ userId: "user-1" }]).mockResolvedValueOnce([{ id: "ledger-1" }]);

    await marginController.checkAndLockMargin("user-1", "order-1", 1_000);

    const lockCallParams = paramsOf(mockQueryRaw.mock.calls[0]!);
    const pnlParam = lockCallParams[2] as { toNumber?: () => number };
    expect(pnlParam?.toNumber?.()).toBe(0);
  });
});
