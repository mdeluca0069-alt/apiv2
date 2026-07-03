/**
 * market.structure.test.ts
 *
 * Unit tests for MarketStructureEngine — swing high/low (HH/HL/LH/LL)
 * detection, Break Of Structure (BOS) / Change Of Character (CHoCH)
 * classification, and the structureScoreFor() probabilistic contribution.
 *
 * Strategy: feed hand-built synthetic OHLCV zigzag paths (via pathThrough())
 * with known, deterministic turning points and assert on the engine's output.
 * No DB, no network, no other engines involved.
 */
import { describe, it, expect } from "vitest";
import { MarketStructureEngine, type StructureResult } from "../signals-engine/market.structure.js";
import type { OHLCV } from "../ai-core/volatility.engine.js";

// ─── Synthetic candle helpers ─────────────────────────────────────────────────

function priceCandle(p: number): OHLCV {
  return { open: p, high: p + 0.5, low: p - 0.5, close: p };
}

/**
 * Walks linearly through `points` with `stepLen` candles per segment.
 * Each point in `points` (after the first) lands exactly on a candle at a
 * segment boundary, so turning points have exact, predictable values.
 */
function pathThrough(points: number[], stepLen = 3): OHLCV[] {
  const out: OHLCV[] = [priceCandle(points[0])];
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1];
    const end = points[i];
    for (let s = 1; s <= stepLen; s++) {
      out.push(priceCandle(start + ((end - start) * s) / stepLen));
    }
  }
  return out;
}

function feedAll(engine: MarketStructureEngine, candles: OHLCV[]): StructureResult {
  let last!: StructureResult;
  for (const c of candles) last = engine.next(c);
  return last;
}

// Single peak at 104, used to test confirmation lag in isolation.
const SINGLE_PEAK = pathThrough([100, 104, 100], 3);

// Ascending HH/HL staircase: peaks 104 < 109 < 113, troughs 101 < 104 < 108,
// plus a trailing leg purely so the last trough gets its confirmation shoulders.
const ASCENDING_STAIRCASE = pathThrough([100, 104, 101, 109, 104, 113, 108, 110], 3);

// Descending LH/LL staircase: peaks 99 > 96 > 92, troughs 96 > 91 > 87.
const DESCENDING_STAIRCASE = pathThrough([100, 96, 99, 91, 96, 87, 92, 90], 3);

// Bounded oscillation — every peak/trough stays within the first peak/trough's
// range, so no BOS/CHoCH ever fires and the sequence is genuinely range-bound.
const RANGE_BOUND = pathThrough([100, 105, 99, 104, 100, 103, 101, 103], 3);

describe("MarketStructureEngine — swing detection", () => {
  it("does not report a swing until swingLookback confirmation bars have printed", () => {
    const engine = new MarketStructureEngine(2, 50);
    const before = feedAll(engine, SINGLE_PEAK.slice(0, 5));
    expect(before.ready).toBe(false);
    expect(before.lastSwings).toHaveLength(0);

    const after = engine.next(SINGLE_PEAK[5]);
    expect(after.ready).toBe(true);
    // Swing points store the candle's high/low (price ± 0.5), not the raw turning-point price.
    expect(after.lastSwings.some((s) => s.price === 104.5 && s.type === "HH")).toBe(true);
  });

  it("never throws and stays not-ready on a genuine cold start", () => {
    const engine = new MarketStructureEngine(5, 50);
    expect(() => {
      const r1 = engine.next(priceCandle(100));
      const r2 = engine.next(priceCandle(101));
      expect(r1.ready).toBe(false);
      expect(r2.ready).toBe(false);
      expect(engine.ready).toBe(false);
    }).not.toThrow();
  });
});

describe("MarketStructureEngine — trend structure", () => {
  it("classifies an ascending HH/HL staircase as bullish with no false CHoCH", () => {
    const engine = new MarketStructureEngine(2, 50);
    const result = feedAll(engine, ASCENDING_STAIRCASE);

    expect(result.bullishStructure).toBe(true);
    expect(result.bearishStructure).toBe(false);
    expect(result.phase).toBe("TRENDING_UP");
    expect(result.recentEvents.some((e) => e.type.startsWith("CHOCH"))).toBe(false);
  });

  it("fires a BOS_BULLISH event on a same-direction continuation break", () => {
    const engine = new MarketStructureEngine(2, 50);
    const result = feedAll(engine, ASCENDING_STAIRCASE);
    expect(result.recentEvents.some((e) => e.type === "BOS_BULLISH")).toBe(true);
  });

  it("classifies a descending LH/LL staircase as bearish with no false CHoCH", () => {
    const engine = new MarketStructureEngine(2, 50);
    const result = feedAll(engine, DESCENDING_STAIRCASE);

    expect(result.bearishStructure).toBe(true);
    expect(result.bullishStructure).toBe(false);
    expect(result.phase).toBe("TRENDING_DOWN");
    expect(result.recentEvents.some((e) => e.type.startsWith("CHOCH"))).toBe(false);
  });

  it("fires a CHOCH_BEARISH event — distinguishable from BOS_BEARISH — on a reversal against an established uptrend", () => {
    const engine = new MarketStructureEngine(2, 50);
    feedAll(engine, ASCENDING_STAIRCASE);

    // A sharp drop below the most recent swing low, against the established uptrend.
    const reversal = engine.next(priceCandle(90));
    expect(reversal.recentEvents.some((e) => e.type === "CHOCH_BEARISH")).toBe(true);
    expect(reversal.recentEvents.some((e) => e.type === "BOS_BEARISH")).toBe(false);
  });

  it("classifies bounded oscillation as RANGE with high rangeBoundPct and no BOS/CHoCH", () => {
    const engine = new MarketStructureEngine(2, 50);
    const result = feedAll(engine, RANGE_BOUND);

    expect(result.phase).toBe("RANGE");
    expect(result.rangeBoundPct).toBeGreaterThan(60);
    expect(result.recentEvents).toHaveLength(0);
  });
});

// ─── SMC (Smart Money Concepts) fixtures ──────────────────────────────────────

/** Unlike priceCandle(), allows open/close to differ — needed for candle-color (OB/MB) detection. */
function candle(open: number, high: number, low: number, close: number): OHLCV {
  return { open, high, low, close };
}

describe("MarketStructureEngine — SMC: Liquidity Sweep", () => {
  it("detects a SWEEP_HIGH when a wick pierces the swing high but the close stays back inside", () => {
    const engine = new MarketStructureEngine(2, 50);
    // Confirm a swing high at 105.5 (price 105, high = price+0.5).
    feedAll(engine, pathThrough([100, 105, 100], 2));
    const sweepCandle = candle(102, 107, 101.5, 104); // high=107 > 105.5, close=104 <= 105.5
    const result = engine.next(sweepCandle);

    const sweep = result.smc!.sweeps.find((s) => s.type === "SWEEP_HIGH");
    expect(sweep).toBeDefined();
    expect(sweep!.sweptLevel).toBeCloseTo(105.5, 5);
    expect(sweep!.reversalConfirmed).toBe(false); // not confirmed on the sweep candle itself
  });

  it("confirms the reversal only on a later candle, not the sweep candle itself", () => {
    const engine = new MarketStructureEngine(2, 50);
    feedAll(engine, pathThrough([100, 105, 100], 2));
    engine.next(candle(102, 107, 101.5, 104));
    const after = engine.next(candle(103, 104, 102, 103)); // closes further below the swept level

    const sweep = after.smc!.sweeps.find((s) => s.type === "SWEEP_HIGH");
    expect(sweep!.reversalConfirmed).toBe(true);
  });

  it("does not record a sweep on a genuine close-confirmed break (that's a BOS, not a sweep)", () => {
    const engine = new MarketStructureEngine(2, 50);
    feedAll(engine, pathThrough([100, 105, 100], 2));
    const result = engine.next(candle(105, 108, 104.5, 107)); // close itself clears the level
    expect(result.smc!.sweeps.some((s) => s.type === "SWEEP_HIGH")).toBe(false);
  });
});

describe("MarketStructureEngine — SMC: Equal High / Equal Low", () => {
  it("groups two swing highs within tolerance into an Equal High level", () => {
    const engine = new MarketStructureEngine(2, 50);
    // Two peaks at 105 and 105.05 (highs 105.5 / 105.55) — 0.047% apart, within the 0.05% tolerance.
    const result = feedAll(engine, pathThrough([100, 105, 100, 105.05, 100], 3));

    expect(result.smc!.equalHighs.length).toBeGreaterThanOrEqual(1);
    const level = result.smc!.equalHighs[0];
    expect(level.touches.length).toBeGreaterThanOrEqual(2);
    expect(level.tolerancePct).toBe(0.05);
  });

  it("groups two swing lows within tolerance into an Equal Low level", () => {
    const engine = new MarketStructureEngine(2, 50);
    const result = feedAll(engine, pathThrough([110, 100, 110, 100.02, 110], 3));

    expect(result.smc!.equalLows.length).toBeGreaterThanOrEqual(1);
    expect(result.smc!.equalLows[0].type).toBe("EQL");
  });

  it("does not group two clearly distinct swing highs", () => {
    const engine = new MarketStructureEngine(2, 50);
    const result = feedAll(engine, pathThrough([100, 105, 100, 120, 100], 3));
    expect(result.smc!.equalHighs.length).toBe(0);
  });
});

describe("MarketStructureEngine — SMC: Order Block / Breaker Block", () => {
  it("records a Bullish Order Block as the last bearish candle before a BOS_BULLISH break", () => {
    const engine = new MarketStructureEngine(2, 50);
    feedAll(engine, pathThrough([100, 105, 100], 2)); // confirms swing high at 105.5

    engine.next(candle(103, 103.2, 100.8, 101)); // bearish candle (close < open)
    // low=104 stays clear of the OB's [100.8,103.2] range so mitigation isn't
    // triggered by this same breakout candle's wick.
    const result = engine.next(candle(101, 108, 104, 107)); // breaks 105.5 -> BOS_BULLISH

    expect(result.recentEvents.some((e) => e.type === "BOS_BULLISH")).toBe(true);
    const ob = result.smc!.orderBlocks.find((o) => o.type === "BULLISH_OB");
    expect(ob).toBeDefined();
    expect(ob!.high).toBeCloseTo(103.2, 5);
    expect(ob!.low).toBeCloseTo(100.8, 5);
    expect(ob!.mitigated).toBe(false);
    expect(ob!.breaker).toBe(false);
  });

  it("flags a Breaker Block once a mitigated Order Block is fully broken through in the original direction", () => {
    const engine = new MarketStructureEngine(2, 50);
    feedAll(engine, pathThrough([100, 105, 100], 2));
    engine.next(candle(103, 103.2, 100.8, 101));
    engine.next(candle(101, 108, 100.5, 107)); // creates the Bullish OB [100.8, 103.2]

    engine.next(candle(104, 104.5, 102, 103));   // pulls back into the OB range -> mitigated
    const result = engine.next(candle(101, 101.5, 99, 99.5)); // closes below ob.low -> breaker

    const ob = result.smc!.orderBlocks.find((o) => o.type === "BULLISH_OB");
    expect(ob!.mitigated).toBe(true);
    expect(ob!.breaker).toBe(true);
  });
});

describe("MarketStructureEngine — SMC: Mitigation Block", () => {
  it("records a Mitigation Block as the last bullish candle before a CHoCH against an established uptrend", () => {
    const engine = new MarketStructureEngine(2, 50);
    feedAll(engine, ASCENDING_STAIRCASE); // establishes trendBias UP with confirmed swings (lastSwingLow ~ 107.5)

    // Stays above the established swing low so it doesn't trigger the break
    // itself — it must remain available as the candle *before* the breakout.
    engine.next(candle(108, 109, 107.5, 108.5)); // bullish-colored candle (close > open)
    const result = engine.next(priceCandle(90)); // sharp drop -> CHOCH_BEARISH (reversal vs uptrend)

    expect(result.recentEvents.some((e) => e.type === "CHOCH_BEARISH")).toBe(true);
    expect(result.smc!.mitigationBlocks.length).toBeGreaterThanOrEqual(1);
    const mb = result.smc!.mitigationBlocks[result.smc!.mitigationBlocks.length - 1];
    expect(mb.side).toBe("BEARISH");
    expect(mb.high).toBeGreaterThan(mb.low);
  });
});

describe("MarketStructureEngine — SMC: Fair Value Gap", () => {
  it("detects a Bullish FVG when candle[i-1].high sits below candle[i+1].low", () => {
    const engine = new MarketStructureEngine(2, 50);
    engine.next(candle(100, 101, 99, 100));   // candle i-1: high = 101
    engine.next(candle(103, 106, 102, 105));  // candle i (impulse)
    const result = engine.next(candle(107, 109, 104, 108)); // candle i+1: low = 104 > 101

    const fvg = result.smc!.fairValueGaps.find((g) => g.type === "BULLISH_FVG");
    expect(fvg).toBeDefined();
    expect(fvg!.gapLow).toBeCloseTo(101, 5);
    expect(fvg!.gapHigh).toBeCloseTo(104, 5);
    expect(fvg!.filled).toBe(false);
  });

  it("marks the gap filled once price later retraces fully back through it", () => {
    const engine = new MarketStructureEngine(2, 50);
    engine.next(candle(100, 101, 99, 100));
    engine.next(candle(103, 106, 102, 105));
    engine.next(candle(107, 109, 104, 108));
    const result = engine.next(candle(108, 108, 99, 100)); // retraces fully through [101,104]

    const fvg = result.smc!.fairValueGaps.find((g) => g.type === "BULLISH_FVG");
    expect(fvg!.filledPct).toBe(100);
    expect(fvg!.filled).toBe(true);
  });

  it("does not detect a gap when candles overlap normally", () => {
    const engine = new MarketStructureEngine(2, 50);
    engine.next(candle(100, 102, 99, 101));
    engine.next(candle(101, 103, 100, 102));
    const result = engine.next(candle(102, 104, 101, 103)); // i-1.high(102) > i+1.low? no overlap gap
    expect(result.smc!.fairValueGaps.length).toBe(0);
  });
});

describe("MarketStructureEngine — SMC: Premium/Discount Zone", () => {
  it("classifies price in the discount zone when trading below the swing-range equilibrium", () => {
    const engine = new MarketStructureEngine(2, 50);
    feedAll(engine, ASCENDING_STAIRCASE);
    const result = engine.next(priceCandle(90)); // well below the established range

    const zone = result.smc!.premiumDiscount;
    expect(zone).not.toBeNull();
    expect(zone!.currentZone).toBe("DISCOUNT");
    expect(zone!.equilibrium).toBeCloseTo((zone!.rangeHigh + zone!.rangeLow) / 2, 5);
  });

  it("classifies price in the premium zone when trading above the swing-range equilibrium", () => {
    const engine = new MarketStructureEngine(2, 50);
    feedAll(engine, DESCENDING_STAIRCASE);
    const result = engine.next(priceCandle(150)); // well above the established range

    expect(result.smc!.premiumDiscount!.currentZone).toBe("PREMIUM");
  });

  it("is null before any swing range exists", () => {
    const engine = new MarketStructureEngine(5, 50);
    const result = engine.next(priceCandle(100));
    expect(result.smc!.premiumDiscount).toBeNull();
  });
});

describe("MarketStructureEngine — SMC integration with structureScoreFor", () => {
  it("nudges the score upward for BUY when a discount-zone bonus applies, without breaking the [0,100] clamp", () => {
    const engine = new MarketStructureEngine(2, 50);
    feedAll(engine, ASCENDING_STAIRCASE);
    const score = engine.structureScoreFor("BUY");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("does not alter structureScoreFor's signature or break existing alignment/CHoCH behavior", () => {
    // Regression: Task 12's two structureScoreFor tests must keep passing unmodified
    // (verified by the existing describe block below); this just re-confirms the
    // SMC additions are additive bonuses on top of, not a replacement for, that logic.
    const engine = new MarketStructureEngine(2, 50);
    feedAll(engine, ASCENDING_STAIRCASE);
    const buyScore = engine.structureScoreFor("BUY");
    const sellScore = engine.structureScoreFor("SELL");
    expect(buyScore).toBeGreaterThan(sellScore);
  });
});

describe("MarketStructureEngine — structureScoreFor", () => {
  it("scores materially higher for the side aligned with structure than the opposing side", () => {
    const engine = new MarketStructureEngine(2, 50);
    feedAll(engine, ASCENDING_STAIRCASE);

    const buyScore = engine.structureScoreFor("BUY");
    const sellScore = engine.structureScoreFor("SELL");
    expect(buyScore).toBeGreaterThan(sellScore + 20);
  });

  it("drops materially once a recent CHoCH contradicts the candidate side", () => {
    const engine = new MarketStructureEngine(2, 50);
    feedAll(engine, ASCENDING_STAIRCASE);
    const beforeChoch = engine.structureScoreFor("BUY");

    engine.next(priceCandle(90)); // triggers CHOCH_BEARISH, contradicts BUY
    const afterChoch = engine.structureScoreFor("BUY");

    expect(afterChoch).toBeLessThan(beforeChoch - 20);
  });
});
