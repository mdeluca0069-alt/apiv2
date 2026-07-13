/**
 * risk.snapshot.service.equity.spec.ts
 *
 * FASE 4.2 (Risk Engine, Bug #2) — RiskSnapshotService.getSnapshot() computed
 * equity as `Number(wallet.equity) || (balance + sum of persisted Position.pnl)`.
 * wallet.equity is never written anywhere in this codebase, so the `||`
 * fallback always ran, using the same stale-column mechanism as
 * MarginController.getMarginState(). This dashboard risk score/marginLevel
 * is what a client and compliance staff see -- it must not diverge from
 * what the pre-trade gate actually uses.
 *
 * Fix: equity's unrealized-P&L term is now recomputed live from quoteCache,
 * same formula and same live-quote source as the margin gate fix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindUnique, mockFindMany } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockFindMany:   vi.fn(),
}));
vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: { walletAccount: { findUnique: mockFindUnique }, position: { findMany: mockFindMany } },
}));

const { mockQuoteGet } = vi.hoisted(() => ({ mockQuoteGet: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockQuoteGet },
}));

const { mockGetStats } = vi.hoisted(() => ({ mockGetStats: vi.fn().mockResolvedValue(null) }));
vi.mock("../analytics/trading.analytics.service.js", () => ({
  tradingAnalyticsService: { getStats: mockGetStats },
}));

const { RiskSnapshotService } = await import("../risk-service/risk.snapshot.service.js");

function decimalLike(n: number) {
  return { toNumber: () => n, valueOf: () => n };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetStats.mockResolvedValue(null);
  mockQuoteGet.mockReturnValue(undefined);
});

describe("RiskSnapshotService.getSnapshot() — live equity", () => {
  it("computes equity from live-recomputed unrealized P&L, ignoring the never-written wallet.equity field", async () => {
    mockFindUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(3_000), equity: decimalLike(0) });
    mockFindMany.mockResolvedValue([
      { symbol: "EURUSD", side: "BUY", quantity: decimalLike(100_000), entryPrice: decimalLike(1.0600), marginUsed: decimalLike(3_000) },
    ]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 });

    const service  = new RiskSnapshotService();
    const snapshot = await service.getSnapshot("user-1");

    // equity = 10,000 + (1.0000-1.0600)*100000 = 10,000 - 6,000 = 4,000
    // marginLevelPct = 4,000/3,000*100 = 133.3%
    expect(snapshot.marginLevelPct).toBeCloseTo(133.3, 0);
  });

  it("a position with no live quote contributes zero to the risk score inputs", async () => {
    mockFindUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(1_000), equity: decimalLike(0) });
    mockFindMany.mockResolvedValue([
      { symbol: "EURUSD", side: "BUY", quantity: decimalLike(100_000), entryPrice: decimalLike(1.0600), marginUsed: decimalLike(1_000) },
    ]);
    mockQuoteGet.mockReturnValue(undefined);

    const service  = new RiskSnapshotService();
    const snapshot = await service.getSnapshot("user-1");

    // equity stays at balance (10,000) since the position contributes 0
    // marginLevelPct = 10,000/1,000*100 = 1000%
    expect(snapshot.marginLevelPct).toBeCloseTo(1000, 0);
  });
});
