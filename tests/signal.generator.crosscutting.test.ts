/**
 * signal.generator.crosscutting.test.ts
 *
 * Phase 9 — the one invariant that cannot be verified at the ConfidenceEngine
 * level alone: the multi-timeframe "never signal from one timeframe alone"
 * gate lives in SignalGenerator.evaluate() itself, as a hard `return null`
 * BEFORE ConfidenceEngine.score() ever runs. No combination of strong local
 * indicators can talk its way past it.
 *
 * Strategy: feed the IDENTICAL local candle sequence (a hand-tuned RSI-oversold
 * + MACD-bullish-cross + price-above-EMA200 setup — i.e. everything the local
 * BUY gate needs) through two otherwise-identical SignalGenerator instances,
 * differing only in what's seeded into the global candle store for
 * MultiTimeframeEngine. One symbol gets a 5-timeframe bullish-aligned setup;
 * the other gets a majority-bearish one. Same local setup, opposite outcome —
 * isolating MTF as the deciding factor.
 *
 * IS_PERSISTENT is mocked false, so adaptiveWeights/signalTelemetry no-op to
 * their in-memory defaults — no real DB touched; SignalGenerator is
 * constructed with no `db` argument, so persist() trivially succeeds too.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../shared/db.js", () => ({ IS_PERSISTENT: false, prisma: null }));

import { SignalGenerator } from "../signals-engine/signal.generator.js";
import type { OHLCV } from "../ai-core/volatility.engine.js";
import { seedCandles, type Candle, type Timeframe } from "../market-data/candle.aggregator.js";

const TF_SECONDS: Record<Timeframe, number> = {
  "1M": 60, "5M": 300, "15M": 900, "30M": 1800, "1H": 3600, "4H": 14400, "1D": 86400,
};

/**
 * Hand-tuned price path (found by direct exploration of the real RSI/MACD/EMA200
 * engines) where the final candle simultaneously satisfies RSI<30 (oversold),
 * a MACD bullish histogram cross, and price > EMA200 — the exact AND of
 * conditions SignalGenerator's BUY gate requires. The flat plateau after the
 * decline is deliberate: it lets MACD's faster EMA recover toward the flat
 * price (eventually crossing its signal line) while RSI's Wilder-smoothed
 * avgGain/avgLoss decay at the same proportional rate (ratio ~unchanged), so
 * the two indicators' very different recovery speeds line up on one candle.
 */
function buildBullishGateSequence(): OHLCV[] {
  const prices: number[] = [];
  let p = 100;
  for (let i = 0; i < 160; i++) { p += 0.15; prices.push(p); }
  for (let i = 0; i < 50; i++)  { p += 0.5;  prices.push(p); }
  for (let i = 0; i < 8; i++)   { p -= 1.5;  prices.push(p); }
  for (let i = 0; i < 40; i++)  { prices.push(p); }
  for (let i = 0; i < 10; i++)  { p += 0.2;  prices.push(p); }

  return prices.map((price): OHLCV => ({
    open: price, high: price + 0.1, low: price - 0.1, close: price, volume: 1000,
  }));
}

function trendCandles(tf: Timeframe, count: number, direction: "up" | "down"): Candle[] {
  const interval = TF_SECONDS[tf];
  const baseTime = interval * 3_000_000;
  const step = direction === "up" ? 0.5 : -0.5;
  return Array.from({ length: count }, (_, i) => {
    const price = 100 + step * i;
    return { time: baseTime + i * interval, open: price, high: price + 0.2, low: price - 0.2, close: price, volume: 1000 };
  });
}

function seedAllTimeframesBullish(symbol: string): void {
  for (const tf of ["1D", "4H", "1H", "15M", "5M"] as Timeframe[]) {
    seedCandles(symbol, tf, trendCandles(tf, 220, "up"));
  }
}

function seedMajorityBearish(symbol: string): void {
  // 1 of 5 bullish, 4 of 5 bearish — the "never alone" gate must reject this
  // even though the LOCAL candle sequence below is a textbook BUY setup.
  seedCandles(symbol, "1D", trendCandles("1D", 220, "up"));
  for (const tf of ["4H", "1H", "15M", "5M"] as Timeframe[]) {
    seedCandles(symbol, tf, trendCandles(tf, 220, "down"));
  }
}

describe("Cross-cutting: multi-timeframe gate vs. an otherwise-qualifying local setup", () => {
  it("fires a BUY signal when the local gate qualifies AND multi-timeframe confirms", async () => {
    const symbol = "XCUT_MTF_ALIGNED";
    seedAllTimeframesBullish(symbol);

    const generator = new SignalGenerator();
    const sequence = buildBullishGateSequence();

    // The qualifying candle sits mid-sequence (the oversold/bullish-cross
    // moment) — every candle fed afterwards hits the 4h cooldown gate and
    // returns null again, so the signal must be captured as it's emitted,
    // not read off the final iteration's result.
    let signal = null;
    for (const candle of sequence) {
      const result = await generator.evaluate(symbol, candle, "1H");
      if (result) signal = result;
    }

    expect(signal).not.toBeNull();
    expect(signal!.signalType).toBe("BUY");
    expect(signal!.confidence).toBeGreaterThanOrEqual(60);
  });

  it("suppresses the IDENTICAL local setup when multi-timeframe alignment is majority-bearish", async () => {
    const symbol = "XCUT_MTF_BLOCKED";
    seedMajorityBearish(symbol);

    const generator = new SignalGenerator();
    const sequence = buildBullishGateSequence();

    let sawAnySignal = false;
    for (const candle of sequence) {
      const result = await generator.evaluate(symbol, candle, "1H");
      if (result) sawAnySignal = true;
    }

    expect(sawAnySignal).toBe(false);
  });
});
