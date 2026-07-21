/**
 * portfolio.intelligence.test.ts
 *
 * Unit tests for PortfolioIntelligenceService.assemble() — the pre-trade
 * context aggregator (Task 13, Phase 5). VarEngine/CorrelationMatrixEngine/
 * ExposureAnalyticsService are reused as-is (their own test suites already
 * cover their math); this file focuses on the 5 new metrics this phase adds:
 * Portfolio Heat, Sector Exposure (asset-class proxy), Currency Exposure,
 * Kelly Allocation, Expected Drawdown.
 *
 * Isolation strategy (mirrors tests/calibration.service.test.ts): IS_PERSISTENT
 * = true so every DB-backed code path executes, with every prisma model
 * method this phase's dependency chain touches mocked as a controllable vi.fn().
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mimics Prisma.Decimal closely enough for this file's purposes: code paths
// that call .toNumber() (most of this codebase) AND code paths that coerce
// via Number(x) (var.engine.ts's wallet balance/locked) both need to work.
function dec(n: number) {
  return { toNumber: () => n, valueOf: () => n };
}

const {
  mockWalletFindUnique,
  mockPositionFindMany,
  mockTradeAuditFindMany,
  mockSnapshotFindMany,
} = vi.hoisted(() => ({
  mockWalletFindUnique:  vi.fn().mockResolvedValue({ balance: dec(0), locked: dec(0) }),
  mockPositionFindMany:  vi.fn().mockResolvedValue([]),
  mockTradeAuditFindMany: vi.fn().mockResolvedValue([]),
  mockSnapshotFindMany:  vi.fn().mockResolvedValue([]),
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    walletAccount: { findUnique: mockWalletFindUnique },
    position:      { findMany: mockPositionFindMany },
    tradeAudit:    { findMany: mockTradeAuditFindMany },
    accountDailySnapshot: { findMany: mockSnapshotFindMany },
  },
}));

// MARKET_DATA_FREEZE.md §0.3: exposure.analytics.ts/var.engine.ts/
// portfolio.intelligence.ts now value open positions live via
// market-data/position.valuation.ts (quoteCache), never the old
// Position.markPrice DB column. Mocked here with the same values this
// file's fixtures originally put in markPrice, so every downstream
// assertion (notional-derived currency exposure, etc.) keeps testing the
// same numbers with no change in intent.
const { mockQuoteCacheGet } = vi.hoisted(() => ({ mockQuoteCacheGet: vi.fn().mockReturnValue(undefined) }));
vi.mock("../market-data/quote.cache.js", () => ({ quoteCache: { get: mockQuoteCacheGet } }));

import { portfolioIntelligence } from "../risk-service/portfolio.intelligence.js";
import { currenciesForSymbol } from "../economic-calendar/economic.event.service.js";

const USER_ID = "user-1";

beforeEach(() => {
  mockWalletFindUnique.mockReset().mockResolvedValue({ balance: dec(0), locked: dec(0) });
  mockPositionFindMany.mockReset().mockResolvedValue([]);
  mockTradeAuditFindMany.mockReset().mockResolvedValue([]);
  mockSnapshotFindMany.mockReset().mockResolvedValue([]);
  mockQuoteCacheGet.mockReset().mockReturnValue(undefined);
});

// Two open positions shared by most tests: one with a stop, one without; one
// FX pair BUY, one metal SELL — exercises portfolioHeat, currencyExposure,
// and sectorProxy simultaneously from one fixture.
function seedOpenPositions() {
  mockPositionFindMany.mockResolvedValue([
    {
      symbol: "EURUSD", side: "BUY", quantity: dec(10_000),
      entryPrice: dec(1.10), marginUsed: dec(500), pnl: dec(50),
      stopLoss: dec(1.095),
    },
    {
      symbol: "XAUUSD", side: "SELL", quantity: dec(5),
      entryPrice: dec(2000), marginUsed: dec(400), pnl: dec(50),
      stopLoss: null,
    },
  ]);
  mockWalletFindUnique.mockResolvedValue({ balance: dec(10_000), locked: dec(900) });
  // Live quotes standing in for this fixture's original markPrice values.
  mockQuoteCacheGet.mockImplementation((symbol: string) => {
    if (symbol === "EURUSD") return { symbol, bid: 1.1049, ask: 1.1051, mid: 1.105, spread: 0.0002, changePct: 0, ts: new Date().toISOString() };
    if (symbol === "XAUUSD") return { symbol, bid: 1989.9, ask: 1990.1, mid: 1990,  spread: 0.2,    changePct: 0, ts: new Date().toISOString() };
    return undefined;
  });
}

describe("PortfolioIntelligenceService — basic assembly", () => {
  it("assembles a full context with no open positions and no history, without throwing", async () => {
    const context = await portfolioIntelligence.assemble(USER_ID);
    expect(context.userId).toBe(USER_ID);
    expect(context.portfolioHeat.riskAtStakeUsd).toBe(0);
    expect(context.currencyExposure).toEqual([]);
    expect(context.kellyAllocation).toBeNull();
    expect(context.expectedDrawdown.length).toBeGreaterThan(0); // VarEngine always returns a 0-5 day forecast
  });

  it("reuses ExposureAnalyticsService's byAssetClass directly as sectorProxy (no recomputation)", async () => {
    seedOpenPositions();
    const context = await portfolioIntelligence.assemble(USER_ID);
    expect(context.sectorProxy).toEqual(context.exposure.byAssetClass);
    expect(context.sectorProxy.length).toBeGreaterThan(0);
  });

  it("reuses CorrelationMatrixEngine's diversity score directly", async () => {
    const context = await portfolioIntelligence.assemble(USER_ID);
    expect(typeof context.diversity).toBe("number");
  });
});

describe("PortfolioIntelligenceService — portfolioHeat", () => {
  it("sums risk-at-stake only across positions that have a stop, and counts the rest as unprotected", async () => {
    seedOpenPositions();
    const context = await portfolioIntelligence.assemble(USER_ID);

    // EURUSD: 10,000 * |1.10 - 1.095| = 50. XAUUSD has no stop -> excluded, counted as unprotected.
    expect(context.portfolioHeat.riskAtStakeUsd).toBe(50);
    expect(context.portfolioHeat.unprotectedPositions).toBe(1);
    expect(context.portfolioHeat.pctOfEquity).toBeGreaterThan(0);
  });
});

describe("PortfolioIntelligenceService — currencyExposure", () => {
  it("nets base/quote currency legs per the standard FX long/short convention, reusing currenciesForSymbol()", async () => {
    seedOpenPositions();
    const context = await portfolioIntelligence.assemble(USER_ID);

    const byCurrency = new Map(context.currencyExposure.map((l) => [l.currency, l.netExposureUsd]));
    const [eurBase, usdQuote] = currenciesForSymbol("EURUSD");
    const [xauBase] = currenciesForSymbol("XAUUSD");

    // EURUSD BUY 10,000 @ markPrice 1.105 -> notional 11,050: +EUR, -USD.
    expect(byCurrency.get(eurBase!)).toBe(11_050);
    // XAUUSD SELL 5 @ markPrice 1990 -> notional 9,950: -XAU, +USD (sign flips for SELL).
    expect(byCurrency.get(xauBase!)).toBe(-9_950);
    expect(byCurrency.get(usdQuote!)).toBe(-11_050 + 9_950);
  });

  it("returns an empty array when there are no open positions", async () => {
    const context = await portfolioIntelligence.assemble(USER_ID);
    expect(context.currencyExposure).toEqual([]);
  });
});

describe("PortfolioIntelligenceService — kellyAllocation", () => {
  function seedSnapshots(dailyPnls: number[]) {
    let equity = 10_000;
    const rows = dailyPnls.map((pnl, i) => {
      equity += pnl;
      return {
        snapshotDate: new Date(Date.UTC(2026, 0, i + 1)),
        equity: dec(equity), balance: dec(equity), realizedPnlDay: dec(pnl), totalFeesDay: dec(0),
      };
    });
    mockSnapshotFindMany.mockResolvedValue(rows);
  }

  it("computes f* = p - (1-p)/b from the portfolio's own win rate and avgWin/avgLoss", async () => {
    seedSnapshots([100, -50, 200, -50]); // winRate=50%, avgWin=150, avgLoss=50 -> b=3

    const context = await portfolioIntelligence.assemble(USER_ID);
    const p = 0.5, b = 3;
    const expectedFullKelly = p - (1 - p) / b;

    expect(context.kellyAllocation).not.toBeNull();
    expect(context.kellyAllocation!.winProbability).toBeCloseTo(p, 4);
    expect(context.kellyAllocation!.payoffRatio).toBeCloseTo(b, 2);
    expect(context.kellyAllocation!.fullKelly).toBeCloseTo(expectedFullKelly, 3);
    expect(context.kellyAllocation!.halfKelly).toBeCloseTo(expectedFullKelly / 2, 3);
  });

  it("reports a negative fullKelly honestly (not clamped to 0) when the edge is negative", async () => {
    seedSnapshots([50, -200, 50, -200]); // winRate=50%, avgWin=50, avgLoss=200 -> b=0.25, clearly negative edge

    const context = await portfolioIntelligence.assemble(USER_ID);
    expect(context.kellyAllocation!.fullKelly).toBeLessThan(0);
  });

  it("is null when there are no closing days at all (insufficient data, not a fabricated number)", async () => {
    const context = await portfolioIntelligence.assemble(USER_ID);
    expect(context.kellyAllocation).toBeNull();
  });

  it("is null when there are wins but no losing days (payoff ratio undefined)", async () => {
    seedSnapshots([100, 100, 200]); // all winning days, avgLoss=0
    const context = await portfolioIntelligence.assemble(USER_ID);
    expect(context.kellyAllocation).toBeNull();
  });
});

describe("PortfolioIntelligenceService — expectedDrawdown", () => {
  it("re-expresses VarEngine's historicalVar95 * daysAhead as a % of equity, matching the marginForecast day range", async () => {
    seedOpenPositions();
    mockTradeAuditFindMany.mockResolvedValue([
      { pnlRealized: dec(-100), closedAt: new Date(Date.UTC(2025, 0, 1)) },
      { pnlRealized: dec(-80),  closedAt: new Date(Date.UTC(2025, 0, 2)) },
      { pnlRealized: dec(120),  closedAt: new Date(Date.UTC(2025, 0, 3)) },
    ]);

    const context = await portfolioIntelligence.assemble(USER_ID);

    expect(context.expectedDrawdown.length).toBe(context.var.marginForecast.length);
    for (const point of context.expectedDrawdown) {
      const expected = context.var.equity > 0
        ? ((context.var.historicalVar95.varUsd * point.daysAhead) / context.var.equity) * 100
        : 0;
      expect(point.drawdownPct).toBeCloseTo(expected, 2);
    }
    // Day 0 is always exactly 0% by construction (var95 * 0 = 0).
    expect(context.expectedDrawdown[0]!.drawdownPct).toBe(0);
  });
});
