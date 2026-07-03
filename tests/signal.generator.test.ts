/**
 * signal.generator.test.ts
 *
 * Smoke test proving MarketStructureEngine is wired into SignalGenerator's
 * per-symbol engine bundle without breaking the existing replay/seed path.
 *
 * Deliberately scoped to seedEngines() rather than a full evaluate() run:
 * evaluate() reaches adaptiveWeights.getWeights(), a module-level singleton
 * that touches the real DB when DATABASE_URL is set in the environment —
 * unsafe for a hermetic unit test. seedEngines() is pure in-memory (feeds
 * EMA/RSI/MACD/Bollinger/Volatility/Regime/Structure with no DB or network
 * calls), so it can prove the new engine integrates cleanly without risking
 * a real database round-trip.
 */
import { describe, it, expect } from "vitest";
import { SignalGenerator } from "../signals-engine/signal.generator.js";
import type { OHLCV } from "../ai-core/volatility.engine.js";

function syntheticCandles(count: number): OHLCV[] {
  const out: OHLCV[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    price += Math.sin(i / 5) * 0.8 + 0.05;
    out.push({ open: price, high: price + 0.3, low: price - 0.3, close: price, volume: 1000 });
  }
  return out;
}

describe("SignalGenerator.seedEngines — MarketStructureEngine wiring", () => {
  it("replays historical candles through every engine, including structure, without throwing", () => {
    const generator = new SignalGenerator(undefined);
    const candles = syntheticCandles(60);

    expect(() => generator.seedEngines("TESTSYM", candles)).not.toThrow();
  });

  it("is a no-op (does not throw) when given an empty candle list", () => {
    const generator = new SignalGenerator(undefined);
    expect(() => generator.seedEngines("TESTSYM", [])).not.toThrow();
  });
});
