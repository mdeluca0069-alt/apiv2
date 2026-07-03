/**
 * candle.aggregator.test.ts
 *
 * Regression coverage for getCandles()'s Phase 8 performance fix: it used to
 * spread the ENTIRE history array (up to MAX_CANDLES=11,000 entries) before
 * slicing down to `limit`, regardless of how small `limit` was. The fix
 * slices first, then copies only what's needed. This file locks in that the
 * returned candles are unchanged — same tail, same ascending order, same
 * handling of the in-progress "current" candle — only the cost changed.
 */
import { describe, it, expect } from "vitest";
import { seedCandles, getCandles, startCandleAggregator, type Candle } from "../market-data/candle.aggregator.js";
import { eventBus } from "../events-bus/event.bus.js";

const INTERVAL_SEC = 3600; // "1H"
const BASE_TIME = INTERVAL_SEC * 2_000_000;

function candle(i: number, price: number): Candle {
  return { time: BASE_TIME + i * INTERVAL_SEC, open: price, high: price + 1, low: price - 1, close: price, volume: 100 };
}

describe("getCandles — slice-before-copy correctness", () => {
  it("returns exactly the last N candles, ascending, when history exceeds the limit", () => {
    const symbol = "AGG_TEST_TAIL";
    const candles = Array.from({ length: 30 }, (_, i) => candle(i, 100 + i));
    seedCandles(symbol, "1H", candles);

    const result = getCandles(symbol, "1H", 5);

    expect(result).toHaveLength(5);
    expect(result.map((c) => c.close)).toEqual([125, 126, 127, 128, 129]); // last 5 of 100..129
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.time).toBeGreaterThan(result[i - 1]!.time);
    }
  });

  it("returns the full history (no padding, no throw) when history is smaller than the limit", () => {
    const symbol = "AGG_TEST_SHORT";
    seedCandles(symbol, "1H", [candle(0, 100), candle(1, 101), candle(2, 102)]);

    const result = getCandles(symbol, "1H", 200);

    expect(result).toHaveLength(3);
    expect(result.map((c) => c.close)).toEqual([100, 101, 102]);
  });

  it("returns an empty array for a symbol/timeframe with no history at all", () => {
    const result = getCandles("AGG_TEST_NEVER_SEEDED", "1H", 50);
    expect(result).toEqual([]);
  });

  it("limit=1 returns just the single most recent completed candle", () => {
    const symbol = "AGG_TEST_LIMIT_ONE";
    seedCandles(symbol, "1H", Array.from({ length: 10 }, (_, i) => candle(i, 100 + i)));

    const result = getCandles(symbol, "1H", 1);

    expect(result).toHaveLength(1);
    expect(result[0]!.close).toBe(109);
  });
});

describe("getCandles — in-progress 'current' candle handling", () => {
  it("appends the in-progress candle after the history tail, still ascending, and reserves one slot for it", () => {
    startCandleAggregator();
    const symbol = "AGG_TEST_CURRENT";

    // onTick() always opens the "current" candle at the REAL wall-clock slot
    // (it ignores any timestamp in the event payload) — so anchor the seeded
    // history to end exactly one slot before "now", guaranteeing the
    // in-progress candle lands immediately after it.
    const nowSec = Math.floor(Date.now() / 1000);
    const currentSlot = Math.floor(nowSec / INTERVAL_SEC) * INTERVAL_SEC;
    const history = Array.from({ length: 10 }, (_, i) => ({
      time: currentSlot - (10 - i) * INTERVAL_SEC,
      open: 100 + i, high: 100 + i + 1, low: 100 + i - 1, close: 100 + i, volume: 100,
    }));
    seedCandles(symbol, "1H", history);

    eventBus.emit("market.quote", {
      symbol, mid: 999, bid: 998.9, ask: 999.1, spread: 0.2, changePct: 0, timestamp: new Date().toISOString(),
    });

    const result = getCandles(symbol, "1H", 5);

    expect(result).toHaveLength(5);
    expect(result[result.length - 1]!.close).toBe(999); // the in-progress candle, last (most recent)
    expect(result.slice(0, 4).map((c) => c.close)).toEqual([106, 107, 108, 109]); // history tail, 4 slots reserved
  });
});
