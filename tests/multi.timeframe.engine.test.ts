/**
 * multi.timeframe.engine.test.ts
 *
 * Unit tests for MultiTimeframeEngine — the "never signal from one timeframe
 * alone" gate, graceful degradation when Daily/4H history hasn't backfilled
 * yet, and the feed-skip optimization that avoids re-running indicators on
 * timeframes whose latest candle hasn't changed.
 *
 * Strategy: seed the real in-memory candle.aggregator store (seedCandles/
 * getCandles — no DB, no network) with synthetic trending OHLCV per
 * timeframe, then exercise MultiTimeframeEngine.evaluate() against it.
 * Each test uses a unique symbol to keep the shared in-memory store isolated.
 */
import { describe, it, expect } from "vitest";
import { MultiTimeframeEngine, type TimeframeKey } from "../signals-engine/multi.timeframe.engine.js";
import { seedCandles, type Candle, type Timeframe } from "../market-data/candle.aggregator.js";

const TF_SECONDS: Record<TimeframeKey, number> = {
  "1D": 86400, "4H": 14400, "1H": 3600, "15M": 900, "5M": 300,
};

const ALL_TFS: TimeframeKey[] = ["1D", "4H", "1H", "15M", "5M"];

function trendCandles(tf: TimeframeKey, count: number, direction: "up" | "down" | "flat", startPrice = 100): Candle[] {
  const interval = TF_SECONDS[tf];
  const baseTime = interval * 1_000_000; // arbitrary aligned anchor, far from epoch 0
  const step = direction === "up" ? 0.5 : direction === "down" ? -0.5 : 0;
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const price = startPrice + step * i;
    out.push({ time: baseTime + i * interval, open: price, high: price + 0.2, low: price - 0.2, close: price, volume: 1000 });
  }
  return out;
}

/** Seeds every timeframe in `tfs` with `count` trending candles for `symbol`. */
function seedAll(symbol: string, tfs: TimeframeKey[], count: number, direction: "up" | "down" | "flat"): void {
  for (const tf of tfs) {
    seedCandles(symbol, tf as Timeframe, trendCandles(tf, count, direction));
  }
}

describe("MultiTimeframeEngine — never signal from one timeframe alone", () => {
  it("accepts a candidate when all 5 timeframes are fully seeded and aligned bullish", () => {
    const symbol = "MTF_ALL_ALIGNED";
    seedAll(symbol, ALL_TFS, 220, "up");

    const engine = new MultiTimeframeEngine();
    const result = engine.evaluate(symbol, "BUY");

    expect(result.sufficientAlignment).toBe(true);
    expect(result.dominantDirection).toBe("BUY");
    expect(result.degradedTimeframes).toHaveLength(0);
  });

  it("rejects when only a minority of usable timeframes agree (2 of 5 bullish, 3 bearish)", () => {
    const symbol = "MTF_MINORITY";
    seedAll(symbol, ["1D", "4H"], 220, "up");
    seedAll(symbol, ["1H", "15M", "5M"], 220, "down");

    const engine = new MultiTimeframeEngine();
    const result = engine.evaluate(symbol, "BUY");

    expect(result.sufficientAlignment).toBe(false);
  });

  it("accepts when a strong majority agree (4 of 5 bullish, 1 bearish)", () => {
    const symbol = "MTF_MAJORITY";
    seedAll(symbol, ["1D", "4H", "1H", "15M"], 220, "up");
    seedAll(symbol, ["5M"], 220, "down");

    const engine = new MultiTimeframeEngine();
    const result = engine.evaluate(symbol, "BUY");

    expect(result.sufficientAlignment).toBe(true);
    expect(result.dominantDirection).toBe("BUY");
  });

  it("degrades Daily/4H gracefully instead of going signal-silent before backfill completes", () => {
    const symbol = "MTF_DEGRADED";
    // 1D/4H deliberately left unseeded (simulates pre-backfill state).
    seedAll(symbol, ["1H", "15M", "5M"], 220, "up");

    const engine = new MultiTimeframeEngine();
    const result = engine.evaluate(symbol, "BUY");

    expect(result.degradedTimeframes).toEqual(expect.arrayContaining(["1D", "4H"]));
    expect(result.sufficientAlignment).toBe(true);
    expect(result.dominantDirection).toBe("BUY");
  });

  it("never throws and reports insufficient alignment on a genuine cold start", () => {
    const symbol = "MTF_COLD_START";
    const engine = new MultiTimeframeEngine();

    expect(() => {
      const result = engine.evaluate(symbol, "BUY");
      expect(result.sufficientAlignment).toBe(false);
      expect(result.timeframes.every((t) => t.dataQuality === "INSUFFICIENT")).toBe(true);
    }).not.toThrow();
  });
});

describe("MultiTimeframeEngine — data quality classification", () => {
  it("classifies a timeframe with partial history (above the usable floor, below the full threshold) as PARTIAL", () => {
    const symbol = "MTF_PARTIAL";
    seedAll(symbol, ["1D"], 30, "up"); // MIN_USABLE=20 < 30 < MIN_CANDLES["1D"]=50

    const engine = new MultiTimeframeEngine();
    const result = engine.evaluate(symbol, "BUY");

    const daily = result.timeframes.find((t) => t.timeframe === "1D")!;
    expect(daily.dataQuality).toBe("PARTIAL");
    expect(daily.candleCount).toBe(30);
  });
});

describe("MultiTimeframeEngine — feed-skip optimization", () => {
  it("does not advance lastFedTime on a second evaluate() call when no new candles arrived", () => {
    const symbol = "MTF_FEED_SKIP";
    seedAll(symbol, ["1H"], 220, "up");

    const engine = new MultiTimeframeEngine();
    engine.evaluate(symbol, "BUY");
    const firstFed = engine.lastFedTimeFor(symbol, "1H");

    engine.evaluate(symbol, "BUY"); // no new candles seeded in between
    const secondFed = engine.lastFedTimeFor(symbol, "1H");

    expect(firstFed).not.toBeNull();
    expect(secondFed).toBe(firstFed);
  });

  it("creates a bundle for every timeframe after the first evaluate() call", () => {
    const symbol = "MTF_BUNDLE_CREATION";
    seedAll(symbol, ["1H"], 220, "up");

    const engine = new MultiTimeframeEngine();
    expect(engine.hasBundle(symbol, "1H")).toBe(false);
    engine.evaluate(symbol, "BUY");
    expect(engine.hasBundle(symbol, "1H")).toBe(true);
  });
});
