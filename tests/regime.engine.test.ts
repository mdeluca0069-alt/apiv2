/**
 * regime.engine.test.ts
 *
 * Unit tests for RegimeEngine — the pre-existing 10 deterministic regimes
 * (spot-checked for regression, since no dedicated test file existed before
 * this extension) plus the 4 new regimes (ACCUMULATION, DISTRIBUTION, PANIC,
 * RECOVERY) and the new optional probabilistic output (heuristic
 * probability/confidence, history-based reliability, empirical transition
 * matrix).
 *
 * Strategy: hand-built synthetic OHLCV sequences (trend / range / shock /
 * choppy-stabilization), calibrated empirically against the real engine
 * (no DB, no other engines involved) — the same approach used throughout
 * this suite for indicator-engine fixtures.
 */
import { describe, it, expect } from "vitest";
import { RegimeEngine, type RegimeResult } from "../ai-core/regime.engine.js";
import type { OHLCV } from "../ai-core/volatility.engine.js";

function candle(price: number, hi?: number, lo?: number): OHLCV {
  return { open: price, high: hi ?? price + 0.3, low: lo ?? price - 0.3, close: price };
}

function trend(n: number, step: number, start = 100): OHLCV[] {
  const out: OHLCV[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p += step;
    out.push(candle(p, p + Math.abs(step) + 0.2, p - Math.abs(step) - 0.2));
  }
  return out;
}

/**
 * Alternating up/down ticks around a fixed base — dampens ADX toward zero
 * (genuine range) rather than reigniting a fresh directional trend the way a
 * smooth continuation would. Each candle is computed relative to the fixed
 * `base` (not cumulative), matching the exact sequence this phase's fixtures
 * were calibrated against.
 */
function choppy(n: number, amplitude: number, base: number): OHLCV[] {
  const out: OHLCV[] = [];
  for (let i = 0; i < n; i++) out.push(candle(base + (i % 2 === 0 ? 1 : -1) * amplitude));
  return out;
}

function feedAll(engine: RegimeEngine, candles: OHLCV[], context: Parameters<RegimeEngine["next"]>[1] = {}): RegimeResult {
  let last!: RegimeResult;
  for (const c of candles) {
    const r = engine.next(c, context);
    if (r) last = r;
  }
  return last;
}

describe("RegimeEngine — pre-existing regime classification (regression)", () => {
  it("classifies a sustained strong uptrend as BULLISH_TREND", () => {
    const engine = new RegimeEngine();
    const result = feedAll(engine, trend(220, 0.6), { atrNormalized: 0.8, atrExpanding: false });

    expect(result.regime).toBe("BULLISH_TREND");
    expect(result.ema50AboveEma200).toBe(true);
    expect(result.priceAboveEma200).toBe(true);
  });

  it("classifies a flat, choppy market with no clear trend as RANGING", () => {
    const engine = new RegimeEngine();
    feedAll(engine, trend(200, 0.01)); // flat warm-up
    const result = feedAll(engine, choppy(14, 1.0, 102)); // ADX decays through the 15-25 RANGING band around here

    expect(result.regime).toBe("RANGING");
  });

  it("still classifies COMPRESSION when ADX is very low and no structurePhase is supplied (legacy callers unaffected)", () => {
    const engine = new RegimeEngine();
    feedAll(engine, trend(200, 0.01));
    const result = feedAll(engine, choppy(30, 0.8, 102)); // no structurePhase in context

    expect(result.regime).toBe("COMPRESSION");
  });

  it("NEWS_DRIVEN still overrides every other classification", () => {
    const engine = new RegimeEngine();
    const result = feedAll(engine, trend(220, 0.6), { atrNormalized: 0.8, recentNewsEvent: true });
    expect(result.regime).toBe("NEWS_DRIVEN");
    expect(result.probabilistic!.probability).toBe(100); // hard override, not a threshold zone
  });
});

describe("RegimeEngine — new regime: PANIC", () => {
  it("classifies a violent ADX reversal with an expanding volatility shock as PANIC", () => {
    const engine = new RegimeEngine();
    feedAll(engine, trend(220, 0.8), { atrNormalized: 0.8, atrExpanding: false });
    const result = feedAll(engine, trend(8, -3, 100 + 220 * 0.8), { atrNormalized: 2.5, atrExpanding: true });

    expect(result.regime).toBe("PANIC");
    expect(result.adxSlope).toBeLessThan(-1);
  });

  it("does not classify PANIC from a sharp move without an accompanying volatility-expansion flag", () => {
    const engine = new RegimeEngine();
    feedAll(engine, trend(220, 0.8), { atrNormalized: 0.8, atrExpanding: false });
    const result = feedAll(engine, trend(8, -3, 100 + 220 * 0.8), { atrNormalized: 2.5, atrExpanding: false });

    expect(result.regime).not.toBe("PANIC");
  });
});

describe("RegimeEngine — new regime: RECOVERY", () => {
  it("classifies ADX re-basing (positive slope) within the post-PANIC window as RECOVERY", () => {
    const engine = new RegimeEngine();
    feedAll(engine, trend(220, 0.8), { atrNormalized: 0.8, atrExpanding: false });
    feedAll(engine, trend(8, -3, 100 + 220 * 0.8), { atrNormalized: 2.5, atrExpanding: true }); // triggers PANIC

    let sawRecovery = false;
    const base = 100 + 220 * 0.8 - 8 * 3;
    for (let i = 0; i < 12; i++) {
      const price = base + (i % 2 === 0 ? 1 : -1) * 0.8; // alternating around a fixed base, not cumulative
      const r = engine.next(candle(price), { atrNormalized: 0.6, atrExpanding: false });
      if (r?.regime === "RECOVERY") sawRecovery = true;
    }
    expect(sawRecovery).toBe(true);
  });

  it("never fires without a preceding PANIC regime", () => {
    const engine = new RegimeEngine();
    feedAll(engine, trend(200, 0.01));
    const result = feedAll(engine, choppy(30, 0.8, 102)); // same shape as the recovery window, no panic preceded it
    expect(result.regime).not.toBe("RECOVERY");
  });
});

describe("RegimeEngine — new regimes: ACCUMULATION / DISTRIBUTION (structure-confirmed refinement)", () => {
  it("classifies low-ADX conditions as ACCUMULATION when structurePhase confirms it", () => {
    const engine = new RegimeEngine();
    feedAll(engine, trend(200, 0.01));
    const result = feedAll(engine, choppy(30, 0.3, 102), { structurePhase: "ACCUMULATION" });
    expect(result.regime).toBe("ACCUMULATION");
  });

  it("classifies low-ADX conditions as DISTRIBUTION when structurePhase confirms it", () => {
    const engine = new RegimeEngine();
    feedAll(engine, trend(200, 0.01));
    const result = feedAll(engine, choppy(30, 0.3, 102), { structurePhase: "DISTRIBUTION" });
    expect(result.regime).toBe("DISTRIBUTION");
  });

  it("falls back to COMPRESSION/LOW_VOLATILITY when structurePhase doesn't confirm accumulation or distribution", () => {
    const engine = new RegimeEngine();
    feedAll(engine, trend(200, 0.01));
    const result = feedAll(engine, choppy(30, 0.3, 102), { structurePhase: "RANGE" });
    expect(["COMPRESSION", "LOW_VOLATILITY"]).toContain(result.regime);
  });
});

describe("RegimeEngine — probabilistic output", () => {
  it("always returns a probability/confidence in [0,100] and a reliability that grows with sample count", () => {
    const engine = new RegimeEngine();
    const early = feedAll(engine, trend(201, 0.6)); // just past EMA200 warm-up
    const later = feedAll(engine, trend(100, 0.6));

    for (const r of [early, later]) {
      expect(r.probabilistic!.probability).toBeGreaterThanOrEqual(0);
      expect(r.probabilistic!.probability).toBeLessThanOrEqual(100);
      expect(r.probabilistic!.confidence).toBeGreaterThanOrEqual(0);
      expect(r.probabilistic!.confidence).toBeLessThanOrEqual(100);
    }
    expect(later.probabilistic!.reliability).toBeGreaterThanOrEqual(early.probabilistic!.reliability);
  });

  it("returns an empty transitionProbability the first time a regime is ever observed", () => {
    const engine = new RegimeEngine();
    const result = feedAll(engine, trend(200, 0.01)); // first-ever regime classification
    expect(result.probabilistic!.transitionProbability).toEqual({});
  });

  it("builds a real empirical transition matrix once a regime has actually been left and re-entered", () => {
    const engine = new RegimeEngine();
    feedAll(engine, trend(220, 0.8), { atrNormalized: 0.8, atrExpanding: false });
    feedAll(engine, trend(8, -3, 100 + 220 * 0.8), { atrNormalized: 2.5, atrExpanding: true }); // PANIC

    // Run the stabilization window once (TREND_EXHAUSTION repeats, then leaves to RECOVERY,
    // then later returns to TREND_EXHAUSTION) — re-entering TREND_EXHAUSTION should now carry
    // a non-empty, real transition history for it.
    let price = 100 + 220 * 0.8 - 8 * 3;
    let sawReentry = false;
    for (let i = 0; i < 20; i++) {
      price += (i % 2 === 0 ? 1 : -1) * 0.8;
      const r = engine.next(candle(price), { atrNormalized: 0.6, atrExpanding: false });
      if (r?.regime === "TREND_EXHAUSTION" && i > 9) {
        const tp = r.probabilistic!.transitionProbability;
        if (Object.keys(tp).length > 0) {
          sawReentry = true;
          const total = Object.values(tp).reduce((a, b) => a + (b ?? 0), 0);
          expect(total).toBeCloseTo(1, 5);
        }
      }
    }
    expect(sawReentry).toBe(true);
  });
});

describe("RegimeEngine — reset()", () => {
  it("clears panic cooldown, last regime, and transition history so the engine behaves like a fresh instance", () => {
    const engine = new RegimeEngine();
    feedAll(engine, trend(220, 0.8), { atrNormalized: 0.8, atrExpanding: false });
    feedAll(engine, trend(8, -3, 100 + 220 * 0.8), { atrNormalized: 2.5, atrExpanding: true }); // PANIC + cooldown set

    engine.reset();
    expect(engine.ready).toBe(false);

    // The very first post-reset classification must show empty transition
    // history (proving regimeHistory was actually cleared, not just EMA state).
    const firstAfterReset = feedAll(engine, trend(200, 0.01));
    expect(firstAfterReset.probabilistic!.transitionProbability).toEqual({});

    // A recovery-shaped sequence must NOT classify as RECOVERY post-reset —
    // proving panicCooldown was actually cleared too.
    const result = feedAll(engine, choppy(12, 0.8, 102));
    expect(result.regime).not.toBe("RECOVERY");
  });
});
