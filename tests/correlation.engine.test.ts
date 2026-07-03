/**
 * correlation.engine.test.ts
 *
 * Unit tests for CorrelationEngine — cross-asset correlation confirmation
 * (the 5 live signal instruments) and the synthesized DXY proxy (the
 * platform has no real DXY feed, so it's built from EURUSD/GBPUSD/USDJPY/
 * USDCHF returns).
 *
 * Strategy: seed every PEER_INSTRUMENT + DXY-basket leg from ONE shared
 * driver return sequence, each at a fixed scale. Since returns_X = scale_X *
 * driver (exactly, by construction), pearson(returns_A, returns_B) is
 * exactly ±1 depending on sign(scaleA * scaleB) — giving deterministic,
 * exact-equality assertions instead of approximate ones.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { CorrelationEngine } from "../signals-engine/correlation.engine.js";
import { seedCandles, type Candle } from "../market-data/candle.aggregator.js";

const INTERVAL_SEC = 3600; // "1H"
const BASE_TIME = INTERVAL_SEC * 1_000_000;

// 20 steps, deliberately varied signs/magnitudes (real variance, not a
// constant-step ramp) so pearson's denominator is never near-zero — and the
// last 4 steps are net positive, giving a predictable short-term direction.
const DRIVER_RETURNS = [
  0.004, -0.002, 0.006, 0.001, -0.003, 0.005, 0.002, -0.001, 0.007, -0.004,
  0.003, 0.0015, -0.002, 0.004, 0.0025, -0.0015, 0.005, -0.003, 0.002, 0.001,
];

function buildCandles(scale: number, basePrice: number): Candle[] {
  const closes: number[] = [basePrice];
  for (const r of DRIVER_RETURNS) closes.push(closes[closes.length - 1]! * (1 + scale * r));
  return closes.map((price, i) => ({
    time: BASE_TIME + i * INTERVAL_SEC,
    open: price, high: price + 0.01, low: price - 0.01, close: price, volume: 1000,
  }));
}

beforeAll(() => {
  // The 5 canonical signal instruments — XAUUSD intentionally at the opposite
  // scale so it's perfectly anti-correlated with the rest.
  seedCandles("EURUSD", "1H", buildCandles(1, 1.10));
  seedCandles("GBPUSD", "1H", buildCandles(1, 1.25));
  seedCandles("XAUUSD", "1H", buildCandles(-1, 2000));
  seedCandles("US500", "1H", buildCandles(1, 5000));
  seedCandles("BTCUSD", "1H", buildCandles(1, 65000));
  // DXY-basket-only legs.
  seedCandles("USDJPY", "1H", buildCandles(1, 150));
  seedCandles("USDCHF", "1H", buildCandles(1, 0.88));
});

describe("CorrelationEngine — insufficient history", () => {
  it("returns the neutral 50 with INSUFFICIENT quality on a genuine cold start", () => {
    const engine = new CorrelationEngine();
    const result = engine.evaluate("CORR_COLD_START_SYMBOL", "BUY");

    expect(result.dataQuality).toBe("INSUFFICIENT");
    expect(result.correlationScore).toBe(50);
    expect(result.usableCount).toBe(0);
    expect(result.pairs).toHaveLength(0);
    expect(result.dxyCorrelation).toBeNull();
  });
});

describe("CorrelationEngine — sign/magnitude on synthetic series", () => {
  it("scores 100 when every peer + DXY confirms the candidate's hypothesis", () => {
    seedCandles("CORR_BUY_CONFIRM", "1H", buildCandles(1, 100));

    const engine = new CorrelationEngine();
    const result = engine.evaluate("CORR_BUY_CONFIRM", "BUY");

    expect(result.dataQuality).toBe("FULL");
    expect(result.usableCount).toBe(6); // 5 peers + DXY
    expect(result.consistentCount).toBe(6);
    expect(result.correlationScore).toBe(100);
  });

  it("scores 0 on the same data when the hypothesis is flipped to SELL", () => {
    // Reuses CORR_BUY_CONFIRM's already-seeded history — CorrelationEngine is
    // stateless/read-only, so evaluating with the opposite side is safe.
    const engine = new CorrelationEngine();
    const result = engine.evaluate("CORR_BUY_CONFIRM", "SELL");

    expect(result.consistentCount).toBe(0);
    expect(result.correlationScore).toBe(0);
  });
});

describe("CorrelationEngine — DXY synthesis", () => {
  it("computes a non-null DXY correlation with the correct sign from the weighted basket", () => {
    const engine = new CorrelationEngine();
    const result = engine.evaluate("CORR_BUY_CONFIRM", "BUY");

    // CORR_BUY_CONFIRM is a +1-scale series; DXY's combined coefficient over
    // EURUSD(-0.664)+USDJPY(+0.157)+GBPUSD(-0.137)+USDCHF(+0.042), all seeded
    // at scale +1, is negative (-0.602) — so correlation must be exactly -1.
    expect(result.dxyCorrelation).toBe(-1);
    expect(result.dxyDataPoints).toBeGreaterThanOrEqual(10);
  });
});

describe("CorrelationEngine — pairs detail", () => {
  it("reports the correct sign for each peer pair", () => {
    const engine = new CorrelationEngine();
    const result = engine.evaluate("CORR_BUY_CONFIRM", "BUY");

    const bySymbol = new Map(result.pairs.map((p) => [p.symbolB, p.correlation]));
    expect(bySymbol.get("EURUSD")).toBe(1);
    expect(bySymbol.get("GBPUSD")).toBe(1);
    expect(bySymbol.get("US500")).toBe(1);
    expect(bySymbol.get("BTCUSD")).toBe(1);
    expect(bySymbol.get("XAUUSD")).toBe(-1);
    expect(result.pairs).toHaveLength(5);
  });
});

describe("CorrelationEngine — self-exclusion", () => {
  it("excludes the candidate symbol from its own peer pairs when it is itself a peer instrument", () => {
    const engine = new CorrelationEngine();
    const result = engine.evaluate("EURUSD", "BUY");

    expect(result.pairs.some((p) => p.symbolB === "EURUSD")).toBe(false);
    expect(result.pairs).toHaveLength(4); // GBPUSD, XAUUSD, US500, BTCUSD
    expect(result.usableCount).toBe(5); // 4 peers + DXY
    expect(result.dataQuality).toBe("FULL");
  });
});
