/**
 * synthetic.candle.provenance.spec.ts
 *
 * MARKET_DATA_FREEZE.md §0.4 — synthetic.seeder.ts's Box-Muller GBM
 * placeholder candles were structurally identical to real candles, with no
 * field distinguishing them. multi.timeframe.engine.ts's dataQuality gate
 * (FULL/PARTIAL/INSUFFICIENT) counted raw candles.length, so a symbol
 * seeded entirely with synthetic history reported "FULL" data quality --
 * feeding the "never signal from one timeframe alone" alignment vote and
 * the trader-facing MTF_ALIGNED_x_OF_y confluence factor as if Daily/4H
 * genuinely confirmed the trade, when no real market data was involved at
 * all.
 *
 * Proves: (1) a symbol seeded exclusively with candles marked
 * synthetic:true never reports dataQuality "FULL", even when the raw count
 * clears MIN_CANDLES; (2) once enough of those candles are real
 * (synthetic:false/omitted), dataQuality correctly reports FULL; (3) a mix
 * that's majority-synthetic still reports PARTIAL/INSUFFICIENT based on
 * the REAL count, not the total.
 */
import { describe, it, expect } from "vitest";
import { MultiTimeframeEngine, type TimeframeKey } from "../signals-engine/multi.timeframe.engine.js";
import { seedCandles, type Candle, type Timeframe } from "../market-data/candle.aggregator.js";

const TF_SECONDS: Record<TimeframeKey, number> = {
  "1D": 86400, "4H": 14400, "1H": 3600, "15M": 900, "5M": 300,
};
const ALL_TFS: TimeframeKey[] = ["1D", "4H", "1H", "15M", "5M"];

function trendCandles(tf: TimeframeKey, count: number, synthetic: boolean, startPrice = 100, startIndex = 0): Candle[] {
  const interval = TF_SECONDS[tf];
  const baseTime = interval * 2_000_000; // distinct anchor from other candle-aggregator test files
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const price = startPrice + 0.5 * i;
    out.push({ time: baseTime + (startIndex + i) * interval, open: price, high: price + 0.2, low: price - 0.2, close: price, volume: 1000, synthetic });
  }
  return out;
}

function seedAll(symbol: string, tfs: TimeframeKey[], count: number, synthetic: boolean): void {
  for (const tf of tfs) {
    seedCandles(symbol, tf as Timeframe, trendCandles(tf, count, synthetic));
  }
}

describe("Candle.synthetic provenance — MultiTimeframeEngine.dataQuality (MARKET_DATA_FREEZE.md §0.4)", () => {
  it("never reports FULL for a timeframe seeded entirely with synthetic candles, even above MIN_CANDLES", () => {
    const symbol = "SYNTH_PROV_ALL_FAKE";
    seedAll(symbol, ALL_TFS, 220, true); // 220 > every MIN_CANDLES threshold, but all synthetic

    const engine = new MultiTimeframeEngine();
    const result = engine.evaluate(symbol, "BUY");

    for (const tf of result.timeframes) {
      expect(tf.dataQuality).not.toBe("FULL");
    }
  });

  it("reports FULL once the same symbol has enough REAL candles, same total count", () => {
    const symbol = "SYNTH_PROV_ALL_REAL";
    seedAll(symbol, ALL_TFS, 220, false);

    const engine = new MultiTimeframeEngine();
    const result = engine.evaluate(symbol, "BUY");

    for (const tf of result.timeframes) {
      expect(tf.dataQuality).toBe("FULL");
    }
  });

  it("classifies a majority-synthetic mix by its real count, not the total", () => {
    const symbol = "SYNTH_PROV_MIXED";
    // 1H needs 200 real candles for FULL. Seed 210 synthetic + 15 real = 225
    // total (would have been "FULL" under the old total-count logic), but
    // only 15 real -> INSUFFICIENT (below MIN_USABLE_CANDLES=20) or PARTIAL.
    const synth = trendCandles("1H", 210, true, 100);
    const real  = trendCandles("1H", 15, false, 205, 210); // continues both price and time series after synth
    seedCandles(symbol, "1H", [...synth, ...real]);

    const engine = new MultiTimeframeEngine();
    const result = engine.evaluate(symbol, "BUY");
    const oneHour = result.timeframes.find((t) => t.timeframe === "1H")!;

    expect(oneHour.dataQuality).not.toBe("FULL");
    expect(oneHour.candleCount).toBeGreaterThanOrEqual(225); // total count unaffected -- still informational
  });

  it("a symbol with no synthetic flag at all (undefined, the pre-existing real-tick shape) still reports FULL as before", () => {
    const symbol = "SYNTH_PROV_UNFLAGGED";
    for (const tf of ALL_TFS) {
      const interval = TF_SECONDS[tf];
      const baseTime = interval * 2_500_000;
      const candles: Candle[] = Array.from({ length: 220 }, (_, i) => ({
        time: baseTime + i * interval, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1000,
        // no `synthetic` field at all -- matches every real onTick()-produced
        // candle shape before this fix and every pre-existing test fixture.
      }));
      seedCandles(symbol, tf as Timeframe, candles);
    }

    const engine = new MultiTimeframeEngine();
    const result = engine.evaluate(symbol, "BUY");
    for (const tf of result.timeframes) {
      expect(tf.dataQuality).toBe("FULL");
    }
  });
});
