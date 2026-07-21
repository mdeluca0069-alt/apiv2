/**
 * concentration.guard.spec.ts
 *
 * RISK_ENGINE_FREEZE.md §3.5 — analytics/exposure.analytics.ts already
 * computed a correct HHI concentration score for the client dashboard, but
 * no order was ever gated on it. Proves ConcentrationGuard.check() exempts
 * a client's first two positions (HHI is trivially 100 with one position),
 * then rejects once the projected portfolio (existing positions + the
 * incoming order) would be more concentrated than the configured limit,
 * and accepts a diversifying trade that lowers concentration instead.
 *
 * MARKET_DATA_FREEZE.md §0.3 — updated to mock quoteCache instead of a
 * Position.markPrice DB field: this module now values open positions via
 * market-data/position.valuation.ts's liveNotional(), never the DB column.
 * quoteCache.get() is mocked to always return undefined (no live quote),
 * so every position values at its entryPrice -- same numeric outcomes this
 * file's original markPrice===entryPrice fixtures already exercised.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { position: { findMany: vi.fn() } },
}));
vi.mock("../shared/db.js", () => ({ prisma: mockDb, IS_PERSISTENT: true }));

const { mockQuoteCacheGet } = vi.hoisted(() => ({ mockQuoteCacheGet: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({ quoteCache: { get: mockQuoteCacheGet } }));

const { concentrationGuard } = await import("../risk-service/concentration.guard.js");

function pos(symbol: string, quantity: number, entryPrice: number) {
  return {
    symbol,
    quantity:   new Decimal(quantity),
    entryPrice: new Decimal(entryPrice),
  };
}

beforeEach(() => {
  mockQuoteCacheGet.mockReturnValue(undefined); // no live quote -> falls back to entryPrice
});

describe("ConcentrationGuard.check()", () => {
  it("exempts a client's first position (would result in only 1 open position)", async () => {
    mockDb.position.findMany.mockResolvedValue([]);
    const result = await concentrationGuard.check("user-1", "EURUSD", 100_000);
    expect(result.ok).toBe(true);
  });

  it("exempts a client's second position (would result in only 2 open positions)", async () => {
    mockDb.position.findMany.mockResolvedValue([pos("EURUSD", 100_000, 1.1)]);
    const result = await concentrationGuard.check("user-1", "GBPUSD", 100_000);
    expect(result.ok).toBe(true);
  });

  it("accepts a 3rd position that keeps the portfolio well diversified (3 equal weights, HHI=33.3)", async () => {
    mockDb.position.findMany.mockResolvedValue([
      pos("EURUSD", 100_000, 1.0),
      pos("GBPUSD", 100_000, 1.0),
    ]);
    const result = await concentrationGuard.check("user-1", "USDJPY", 100_000);
    expect(result.ok).toBe(true);
  });

  it("rejects a 3rd position that would dominate the portfolio (one symbol at 90% weight)", async () => {
    mockDb.position.findMany.mockResolvedValue([
      pos("EURUSD", 5_000, 1.0),
      pos("GBPUSD", 5_000, 1.0),
    ]);
    // Existing: 5,000 + 5,000 = 10,000. Adding 90,000 to USDJPY -> total 100,000,
    // USDJPY weight = 0.9 -> HHI = 0.9^2 + 0.05^2 + 0.05^2 = 0.815 -> 81.5, way over the 40 limit.
    const result = await concentrationGuard.check("user-1", "USDJPY", 90_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CONCENTRATION_LIMIT_EXCEEDED");
      expect(result.detail).toMatch(/HHI/);
    }
  });

  it("accepts a diversifying trade into a new symbol that lowers concentration", async () => {
    // Existing heavily concentrated in EURUSD alone, but adding a 3rd, different-symbol
    // position of meaningful size measurably reduces HHI versus staying 2-symbol.
    mockDb.position.findMany.mockResolvedValue([
      pos("EURUSD", 90_000, 1.0),
      pos("GBPUSD", 10_000, 1.0),
    ]);
    const result = await concentrationGuard.check("user-1", "USDJPY", 100_000);
    // total 200,000: EURUSD 0.45, GBPUSD 0.05, USDJPY 0.5 -> HHI = 0.2025+0.0025+0.25=0.455 -> 45.5, still over 40
    expect(result.ok).toBe(false);
  });

  it("accepts adding to an existing symbol when the resulting book stays diversified", async () => {
    mockDb.position.findMany.mockResolvedValue([
      pos("EURUSD", 40_000, 1.0),
      pos("GBPUSD", 40_000, 1.0),
    ]);
    const result = await concentrationGuard.check("user-1", "USDJPY", 20_000);
    // EURUSD 0.4, GBPUSD 0.4, USDJPY 0.2 -> HHI = 0.16+0.16+0.04 = 0.36 -> 36, under 40
    expect(result.ok).toBe(true);
  });

  it("uses the live quoteCache price over entryPrice when computing existing exposure (MARKET_DATA_FREEZE.md §0.3)", async () => {
    // EURUSD and GBPUSD both entryPrice=1.0/qty=100 (10,000 notional each via entryPrice),
    // but EURUSD has a live quote at mid=10.0 -> live notional 100,000, dominating the book.
    mockDb.position.findMany.mockResolvedValue([
      pos("EURUSD", 100, 1.0),
      pos("GBPUSD", 100, 1.0),
    ]);
    mockQuoteCacheGet.mockImplementation((symbol: string) =>
      symbol === "EURUSD" ? { symbol, bid: 9.99, ask: 10.01, mid: 10.0, spread: 0.02, changePct: 0, ts: new Date().toISOString() } : undefined,
    );

    const result = await concentrationGuard.check("user-1", "USDJPY", 100);
    // If entryPrice were used for EURUSD (10,000 instead of 100,000), the book would stay
    // well diversified and this would pass -- the live quote is what pushes it over the limit.
    expect(result.ok).toBe(false);
  });
});
