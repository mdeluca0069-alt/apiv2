/**
 * confidence.engine.crosscutting.test.ts
 *
 * Phase 9 — interaction edge cases only visible once multiple Phase 1/2/4
 * engines coexist in one ConfidenceEngine.score() call. Each phase's own test
 * file (market.structure, multi.timeframe, correlation, confidence) verified
 * its dimension in isolation with the others held at neutral/null. This file
 * verifies they COMPOSE sensibly: when two dimensions disagree, confidence
 * should land moderate — not as extreme as if both agreed or both
 * contradicted — and when all three genuinely align (or all contradict),
 * confidence should move decisively in that direction.
 */
import { describe, it, expect } from "vitest";
import { ConfidenceEngine, type ConfluenceFactors } from "../ai-core/confidence.engine.js";
import type { StructureResult } from "../signals-engine/market.structure.js";
import type { MultiTimeframeResult, TimeframeKey } from "../signals-engine/multi.timeframe.engine.js";
import type { CorrelationSnapshot } from "../signals-engine/correlation.engine.js";

function baseFactors(overrides: Partial<ConfluenceFactors> = {}): ConfluenceFactors {
  return {
    signalSide: "BUY",
    regime: "RANGING",
    priceVsEma200: "above",
    ema50VsEma200: "above",
    rsi: null,
    macd: null,
    bollinger: null,
    volatilityLevel: "MEDIUM",
    volumeAboveAverage: true,
    sessionHour: 8,
    macroEventIn4h: false,
    structure: null,
    multiTimeframe: null,
    correlation: null,
    ...overrides,
  };
}

function structureResult(score: number): StructureResult {
  return {
    phase: "TRENDING_UP",
    lastSwings: [],
    recentEvents: [],
    structureScore: score,
    bullishStructure: score > 50,
    bearishStructure: score < 50,
    rangeBoundPct: 10,
    ready: true,
  };
}

/** Builds a MultiTimeframeResult where `agreeCount` of `total` usable timeframes agree with BUY. */
function mtfResult(agreeCount: number, total: number): MultiTimeframeResult {
  const keys: TimeframeKey[] = ["1D", "4H", "1H", "15M", "5M"];
  const timeframes = keys.slice(0, total).map((tf, i) => ({
    timeframe: tf, trend: 50, momentum: 50, structure: 50, volatility: 50,
    direction: (i < agreeCount ? "BUY" : "SELL") as "BUY" | "SELL" | "NEUTRAL",
    dataQuality: "FULL" as const, candleCount: 250,
  }));
  const agreementRatio = agreeCount / total;
  const sufficientAlignment = agreeCount > total / 2;
  return {
    timeframes,
    alignmentCount: agreeCount,
    dominantDirection: agreeCount >= total / 2 ? "BUY" : "SELL",
    mtfConfidenceMultiplier: sufficientAlignment ? Math.min(1.15, 0.85 + agreementRatio * 0.3) : Math.max(0.5, 0.5 + agreementRatio * 0.3),
    sufficientAlignment,
    degradedTimeframes: [],
  };
}

function correlationResult(score: number): CorrelationSnapshot {
  return {
    symbol: "TESTSYM", signalSide: "BUY", pairs: [], dxyCorrelation: null, dxyDataPoints: 0,
    consistentCount: score, usableCount: 100, correlationScore: score, dataQuality: "FULL",
  };
}

describe("Cross-cutting: structure vs multi-timeframe disagreement", () => {
  it("lands moderate when structure contradicts but multi-timeframe strongly confirms", () => {
    const engine = new ConfidenceEngine();

    const bothConfirm = engine.score(baseFactors({ structure: structureResult(95), multiTimeframe: mtfResult(5, 5) }));
    const bothContradict = engine.score(baseFactors({ structure: structureResult(5), multiTimeframe: mtfResult(1, 5) }));
    const split = engine.score(baseFactors({ structure: structureResult(5), multiTimeframe: mtfResult(5, 5) }));

    expect(split.confidence).toBeLessThan(bothConfirm.confidence);
    expect(split.confidence).toBeGreaterThan(bothContradict.confidence);
  });
});

describe("Cross-cutting: correlation vs structure disagreement", () => {
  it("lands moderate when correlation contradicts but structure strongly confirms", () => {
    const engine = new ConfidenceEngine();

    const bothConfirm = engine.score(baseFactors({ structure: structureResult(90), correlation: correlationResult(90) }));
    const bothContradict = engine.score(baseFactors({ structure: structureResult(10), correlation: correlationResult(10) }));
    const split = engine.score(baseFactors({ structure: structureResult(90), correlation: correlationResult(10) }));

    expect(split.confidence).toBeLessThan(bothConfirm.confidence);
    expect(split.confidence).toBeGreaterThan(bothContradict.confidence);
  });
});

describe("Cross-cutting: triple alignment vs triple contradiction", () => {
  it("compounds constructively when structure, multi-timeframe and correlation all genuinely confirm", () => {
    const engine = new ConfidenceEngine();
    const result = engine.score(baseFactors({
      structure: structureResult(95),
      multiTimeframe: mtfResult(5, 5),
      correlation: correlationResult(95),
    }));

    expect(result.confidence).toBeGreaterThanOrEqual(85);
    expect(result.reliable).toBe(true);
  });

  it("compounds destructively when structure, multi-timeframe and correlation all genuinely contradict", () => {
    const engine = new ConfidenceEngine();
    const result = engine.score(baseFactors({
      structure: structureResult(5),
      multiTimeframe: mtfResult(1, 5),
      correlation: correlationResult(5),
    }));

    expect(result.confidence).toBeLessThan(60);
    expect(result.reliable).toBe(false);
  });
});

describe("Cross-cutting: regime multiplier composes with the new dimensions, not overridden by them", () => {
  it("still measurably discounts confidence under COMPRESSION even when structure/MTF/correlation are all strongly positive", () => {
    const engine = new ConfidenceEngine();
    const strongFactors = {
      structure: structureResult(95),
      multiTimeframe: mtfResult(5, 5),
      correlation: correlationResult(95),
    };

    const ranging = engine.score(baseFactors({ regime: "RANGING", ...strongFactors }));
    const compression = engine.score(baseFactors({ regime: "COMPRESSION", ...strongFactors }));

    expect(compression.confidence).toBeLessThan(ranging.confidence);
    // COMPRESSION's 0.7x multiplier should be clearly visible, not washed out
    // by the strong sub-scores (breakdown values themselves stay identical —
    // only the final multiplied confidence differs).
    expect(compression.breakdown.structureAlignment).toBe(ranging.breakdown.structureAlignment);
    expect(compression.breakdown.multiTimeframeAlignment).toBe(ranging.breakdown.multiTimeframeAlignment);
  });
});

describe("Cross-cutting: multi-timeframe sub-score moderates confidence independently of the hard gate", () => {
  it("pulls confidence down when MTF's own agreement ratio is weak, even with strong structure/correlation", () => {
    const engine = new ConfidenceEngine();
    // 3 of 5 agree — clears sufficientAlignment (3 > 2.5) but is a weaker ratio than 5 of 5.
    const weakMtf = engine.score(baseFactors({
      structure: structureResult(90), correlation: correlationResult(90), multiTimeframe: mtfResult(3, 5),
    }));
    const strongMtf = engine.score(baseFactors({
      structure: structureResult(90), correlation: correlationResult(90), multiTimeframe: mtfResult(5, 5),
    }));

    expect(weakMtf.confidence).toBeLessThan(strongMtf.confidence);
  });
});
