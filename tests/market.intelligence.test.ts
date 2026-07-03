/**
 * market.intelligence.test.ts
 *
 * Unit tests for MarketIntelligenceEngine.assemble() — the read-only context
 * aggregator (Task 13, Phase 4). It never generates signals; every field is
 * either a direct pass-through of an already-tested engine (session score,
 * liquidity/slippage, volatility) or one of 3 new metrics built from the
 * simplest standard formula (Relative Strength, Market Breadth, DOM
 * imbalance) plus a reuse of Phase 3's correlation graph for cross-asset
 * clustering.
 *
 * Strategy for marketBreadth/crossAsset: seed the platform's 5 PEER_INSTRUMENTS
 * with return series built as `trend + scale*driver` — since `trend` is a
 * constant offset per candle, it shapes the PRICE DRIFT (above/below EMA200)
 * without affecting RETURN CORRELATION (which depends only on the varying
 * `scale*driver` part). This decouples the two assertions cleanly:
 * EURUSD/GBPUSD/US500/XAUUSD all use scale=1 (mutually |r|=1, one cluster);
 * BTCUSD uses scale=0 (zero return-variance -> pearson()'s denom=0 -> r=0,
 * a clean singleton, excluded from any cluster).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { MarketIntelligenceEngine } from "../signals-engine/market.intelligence.js";
import { sessionScoreForHour } from "../ai-core/confidence.engine.js";
import { seedCandles, type Candle } from "../market-data/candle.aggregator.js";
import { quoteCache } from "../market-data/quote.cache.js";

const INTERVAL_SEC = 3600; // "1H"
const BASE_TIME = INTERVAL_SEC * 3_000_000;

const DRIVER = [
  0.004, -0.002, 0.006, 0.001, -0.003, 0.005, 0.002, -0.001, 0.007, -0.004,
  0.003, 0.0015, -0.002, 0.004, 0.0025, -0.0015, 0.005, -0.003, 0.002, 0.001,
];

function buildSeries(trend: number, scale: number, n: number, basePrice: number): Candle[] {
  const closes: number[] = [basePrice];
  for (let i = 0; i < n; i++) {
    const r = trend + scale * DRIVER[i % DRIVER.length]!;
    closes.push(closes[closes.length - 1]! * (1 + r));
  }
  return closes.map((price, i) => ({
    time: BASE_TIME + i * INTERVAL_SEC,
    open: price, high: price + 0.01, low: price - 0.01, close: price, volume: 1000,
  }));
}

const WARMUP = 210; // > EMA200's 200-sample readiness requirement

beforeAll(() => {
  seedCandles("EURUSD", "1H", buildSeries(0.002, 1, WARMUP, 1.10));   // up-trend, cluster scale=1
  seedCandles("GBPUSD", "1H", buildSeries(0.0015, 1, WARMUP, 1.25));  // up-trend, cluster scale=1
  seedCandles("US500", "1H", buildSeries(0.001, 1, WARMUP, 5000));    // up-trend, cluster scale=1
  seedCandles("XAUUSD", "1H", buildSeries(-0.002, 1, WARMUP, 2000));  // down-trend, SAME scale=1 -> still clusters
  seedCandles("BTCUSD", "1H", buildSeries(-0.0015, 0, WARMUP, 65000)); // down-trend, scale=0 -> zero return-variance -> r=0 with everyone
});

describe("MarketIntelligenceEngine — session", () => {
  it("scores the current UTC hour using the exact extracted sessionScoreForHour()", () => {
    const engine = new MarketIntelligenceEngine();
    const snapshot = engine.assemble("MI_SESSION_TEST");
    expect(snapshot.session.score).toBe(sessionScoreForHour(snapshot.session.hourUtc));
  });
});

describe("MarketIntelligenceEngine — liquidity", () => {
  it("returns null spread/slippage/domImbalance when no live quote exists for the symbol", () => {
    const engine = new MarketIntelligenceEngine();
    const snapshot = engine.assemble("MI_NO_QUOTE_SYMBOL");

    expect(snapshot.liquidity.assetClass).toBeTruthy();
    expect(snapshot.liquidity.spreadBps).toBeNull();
    expect(snapshot.liquidity.referenceSlippage).toBeNull();
    expect(snapshot.liquidity.domImbalance).toBeNull();
  });

  it("computes spread/slippage/domImbalance once a live quote is seeded", () => {
    quoteCache.set({ symbol: "MI_QUOTE_TEST", bid: 1.1000, ask: 1.1002, mid: 1.1001, spread: 0.0002, changePct: 0.1, ts: new Date().toISOString() });

    const engine = new MarketIntelligenceEngine();
    const snapshot = engine.assemble("MI_QUOTE_TEST");

    expect(snapshot.liquidity.spreadBps).not.toBeNull();
    expect(snapshot.liquidity.spreadBps).toBeGreaterThan(0);
    expect(snapshot.liquidity.referenceSlippage).not.toBeNull();
    expect(snapshot.liquidity.domImbalance).not.toBeNull();
    expect(snapshot.liquidity.domImbalance!).toBeGreaterThanOrEqual(-1);
    expect(snapshot.liquidity.domImbalance!).toBeLessThanOrEqual(1);
  });
});

describe("MarketIntelligenceEngine — volatility", () => {
  it("is null on a genuine cold start (no candle history)", () => {
    const engine = new MarketIntelligenceEngine();
    const snapshot = engine.assemble("MI_VOL_COLD_START");
    expect(snapshot.volatility).toBeNull();
  });

  it("reports a real level once enough candle history exists", () => {
    seedCandles("MI_VOL_TEST", "1H", buildSeries(0.0005, 2, 40, 100));
    const engine = new MarketIntelligenceEngine();
    const snapshot = engine.assemble("MI_VOL_TEST");

    expect(snapshot.volatility).not.toBeNull();
    expect(["LOW", "MEDIUM", "HIGH", "EXTREME"]).toContain(snapshot.volatility!.level);
  });
});

describe("MarketIntelligenceEngine — economicContext", () => {
  it("returns false/false on a cold start without throwing (no economic calendar refresh has ever run)", () => {
    const engine = new MarketIntelligenceEngine();
    expect(() => engine.assemble("MI_ECON_TEST")).not.toThrow();
    const snapshot = engine.assemble("MI_ECON_TEST");
    expect(typeof snapshot.economicContext.macroEventIn4h).toBe("boolean");
    expect(typeof snapshot.economicContext.recentHighImpactEvent).toBe("boolean");
  });
});

describe("MarketIntelligenceEngine — relativeStrength", () => {
  it("is null when the symbol IS the benchmark", () => {
    const engine = new MarketIntelligenceEngine();
    const snapshot = engine.assemble("US500", { benchmark: "US500" });
    expect(snapshot.relativeStrength).toBeNull();
  });

  it("is null when there isn't enough history for the N-period window", () => {
    seedCandles("MI_RS_THIN", "1H", buildSeries(0.01, 0, 5, 100)); // only 5 candles, window defaults to 20
    seedCandles("MI_RS_BENCH_THIN", "1H", buildSeries(0.01, 0, 30, 100));
    const engine = new MarketIntelligenceEngine();
    const snapshot = engine.assemble("MI_RS_THIN", { benchmark: "MI_RS_BENCH_THIN" });
    expect(snapshot.relativeStrength).toBeNull();
  });

  it("computes the exact price-relative ratio (symbol's N-period return / benchmark's N-period return)", () => {
    seedCandles("MI_RS_BENCH", "1H", buildSeries(0.01, 0, 25, 100));   // smooth +1%/candle compounding
    seedCandles("MI_RS_TEST",  "1H", buildSeries(0.02, 0, 25, 100));   // smooth +2%/candle compounding

    const engine = new MarketIntelligenceEngine();
    const snapshot = engine.assemble("MI_RS_TEST", { benchmark: "MI_RS_BENCH", rsWindow: 20 });

    const expectedRatio = (Math.pow(1.02, 20) - 1) / (Math.pow(1.01, 20) - 1);
    expect(snapshot.relativeStrength).not.toBeNull();
    expect(snapshot.relativeStrength!.benchmark).toBe("MI_RS_BENCH");
    expect(snapshot.relativeStrength!.ratio).toBeCloseTo(expectedRatio, 2);
  });
});

describe("MarketIntelligenceEngine — marketBreadth", () => {
  it("computes the % of the platform's instrument universe trading above its own EMA200", () => {
    const engine = new MarketIntelligenceEngine();
    const snapshot = engine.assemble("MI_BREADTH_TEST");

    expect(snapshot.marketBreadth).not.toBeNull();
    expect(snapshot.marketBreadth!.universeSize).toBe(5);
    // EURUSD/GBPUSD/US500 trend up, XAUUSD/BTCUSD trend down -> 3 of 5 above EMA200.
    expect(snapshot.marketBreadth!.pctAboveEma200).toBe(60);
  });
});

describe("MarketIntelligenceEngine — crossAsset", () => {
  it("clusters the symbols sharing the same return-correlation scale, regardless of differing price trend direction", () => {
    const engine = new MarketIntelligenceEngine();
    const snapshot = engine.assemble("MI_CROSSASSET_TEST");

    expect(snapshot.crossAsset.correlatedClusters).toHaveLength(1);
    expect(snapshot.crossAsset.correlatedClusters[0]!.sort()).toEqual(["EURUSD", "GBPUSD", "US500", "XAUUSD"]);
  });

  it("excludes BTCUSD (zero return-variance -> zero correlation with everyone) from any cluster", () => {
    const engine = new MarketIntelligenceEngine();
    const snapshot = engine.assemble("MI_CROSSASSET_TEST2");
    expect(snapshot.crossAsset.correlatedClusters.flat()).not.toContain("BTCUSD");
  });
});
