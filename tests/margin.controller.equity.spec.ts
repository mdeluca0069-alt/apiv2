/**
 * margin.controller.equity.spec.ts
 *
 * FASE 4.2 (Risk Engine, Bug #2) — MarginController.getMarginState() used to
 * sum the persisted Position.pnl column, which PositionPriceMonitor only
 * refreshes every 5s and can silently drop a position from forever (frozen
 * at 0). This is the pre-trade risk gate (canAcceptOrder consumes this
 * directly) — it must never approve an order against phantom free margin.
 *
 * Fix: unrealizedPnl is now recomputed live from quoteCache on every call,
 * using the same canonical pnlCalculator.unrealized() formula the rest of
 * the platform uses (bid for BUY, ask for SELL).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindUnique, mockFindMany } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockFindMany:   vi.fn(),
}));
vi.mock("../shared/db.js", () => ({
  prisma: { walletAccount: { findUnique: mockFindUnique }, position: { findMany: mockFindMany } },
}));

const { mockQuoteGet } = vi.hoisted(() => ({ mockQuoteGet: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockQuoteGet },
}));

const { marginController } = await import("../risk-service/margin.controller.js");

function decimalLike(n: number) {
  return { toNumber: () => n };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuoteGet.mockReturnValue(undefined);
});

describe("MarginController.getMarginState() — live equity", () => {
  it("computes unrealizedPnl fresh from the current quote, not a stale persisted value", async () => {
    mockFindUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(3_000) });
    mockFindMany.mockResolvedValue([
      { symbol: "EURUSD", side: "BUY", quantity: decimalLike(100_000), entryPrice: decimalLike(1.0600), marginUsed: decimalLike(3_000) },
    ]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 });

    const state = await marginController.getMarginState("user-1");

    // (1.0000 - 1.0600) * 100000 = -6000
    expect(state.unrealizedPnl).toBeCloseTo(-6_000, 2);
    expect(state.equity).toBeCloseTo(4_000, 2);
    expect(state.freeMargin).toBeCloseTo(1_000, 2);
  });

  it("a position with no live quote contributes zero, not a stale/fabricated value", async () => {
    mockFindUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(3_000) });
    mockFindMany.mockResolvedValue([
      { symbol: "EURUSD", side: "BUY", quantity: decimalLike(100_000), entryPrice: decimalLike(1.0600), marginUsed: decimalLike(3_000) },
    ]);
    mockQuoteGet.mockReturnValue(undefined); // feed down for this symbol right now

    const state = await marginController.getMarginState("user-1");

    expect(state.unrealizedPnl).toBe(0);
    expect(state.equity).toBe(10_000);
  });

  it("SELL positions are valued at ask, not bid", async () => {
    mockFindUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(1_000) });
    mockFindMany.mockResolvedValue([
      { symbol: "EURUSD", side: "SELL", quantity: decimalLike(100_000), entryPrice: decimalLike(1.0600), marginUsed: decimalLike(1_000) },
    ]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0500, ask: 1.0700, mid: 1.0600 });

    const state = await marginController.getMarginState("user-1");

    // SELL valued at ask: (entry - ask) * qty = (1.0600 - 1.0700) * 100000 = -1000
    expect(state.unrealizedPnl).toBeCloseTo(-1_000, 2);
  });

  it("canAcceptOrder rejects based on the live-recomputed equity, not a stale one", async () => {
    mockFindUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(3_000) });
    mockFindMany.mockResolvedValue([
      { symbol: "EURUSD", side: "BUY", quantity: decimalLike(100_000), entryPrice: decimalLike(1.0600), marginUsed: decimalLike(3_000) },
    ]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 });

    const state = await marginController.getMarginState("user-1");

    // freeMargin=1000, requesting 2000 more margin should be rejected
    expect(marginController.canAcceptOrder(state, 2_000)).toBe(false);
    expect(marginController.canAcceptOrder(state, 500)).toBe(true);
  });
});
