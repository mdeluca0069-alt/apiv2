/**
 * confidence.engine.test.ts
 *
 * Unit tests for the structureAlignment dimension added to ConfidenceEngine —
 * verifies the neutral cold-start fallback and that structure data actually
 * moves the weighted confidence total (not just computed and discarded).
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

/** Builds a MultiTimeframeResult with `buyCount` BUY-directed and the rest SELL-directed usable timeframes. */
function mtfResult(buyCount: number, totalUsable: number, insufficientCount = 0): MultiTimeframeResult {
  const keys: TimeframeKey[] = ["1D", "4H", "1H", "15M", "5M"];
  const timeframes = keys.slice(0, totalUsable + insufficientCount).map((tf, i) => ({
    timeframe: tf,
    trend: 50, momentum: 50, structure: 50, volatility: 50,
    direction: (i < insufficientCount ? "NEUTRAL" : i - insufficientCount < buyCount ? "BUY" : "SELL") as "BUY" | "SELL" | "NEUTRAL",
    dataQuality: (i < insufficientCount ? "INSUFFICIENT" : "FULL") as "FULL" | "PARTIAL" | "INSUFFICIENT",
    candleCount: i < insufficientCount ? 0 : 250,
  }));
  return {
    timeframes,
    alignmentCount: buyCount,
    dominantDirection: "BUY",
    mtfConfidenceMultiplier: 1.0,
    sufficientAlignment: buyCount > totalUsable / 2,
    degradedTimeframes: keys.slice(0, insufficientCount),
  };
}

function correlationSnapshot(score: number): CorrelationSnapshot {
  return {
    symbol: "TESTSYM",
    signalSide: "BUY",
    pairs: [],
    dxyCorrelation: null,
    dxyDataPoints: 0,
    consistentCount: score,
    usableCount: 100,
    correlationScore: score,
    dataQuality: "FULL",
  };
}

describe("ConfidenceEngine.scoreStructure", () => {
  it("returns the neutral 50 when structure data is unavailable (cold start)", () => {
    const engine = new ConfidenceEngine();
    expect(engine.scoreStructure(baseFactors({ structure: null }))).toBe(50);
  });

  it("reads structureScore straight through when structure data is present", () => {
    const engine = new ConfidenceEngine();
    expect(engine.scoreStructure(baseFactors({ structure: structureResult(90) }))).toBe(90);
  });
});

describe("ConfidenceEngine.score — structureAlignment wiring", () => {
  it("produces a higher overall confidence for strongly-aligned structure than strongly-contradicting structure, all else equal", () => {
    const engine = new ConfidenceEngine();

    const aligned = engine.score(baseFactors({ structure: structureResult(90) }));
    const contradicting = engine.score(baseFactors({ structure: structureResult(10) }));

    expect(aligned.confidence).toBeGreaterThan(contradicting.confidence);
    expect(aligned.breakdown.structureAlignment).toBe(90);
    expect(contradicting.breakdown.structureAlignment).toBe(10);
  });

  it("includes structureAlignment in scoreBreakdownOnly's output", () => {
    const engine = new ConfidenceEngine();
    const breakdown = engine.scoreBreakdownOnly(baseFactors({ structure: structureResult(75) }));
    expect(breakdown.structureAlignment).toBe(75);
  });
});

describe("ConfidenceEngine.scoreMultiTimeframe", () => {
  it("returns the neutral 50 when multi-timeframe data is unavailable", () => {
    const engine = new ConfidenceEngine();
    expect(engine.scoreMultiTimeframe(baseFactors({ multiTimeframe: null }))).toBe(50);
  });

  it("scales with the share of usable timeframes agreeing with signalSide", () => {
    const engine = new ConfidenceEngine();
    // 3 of 4 usable timeframes agree with BUY → 75.
    const score = engine.scoreMultiTimeframe(baseFactors({ signalSide: "BUY", multiTimeframe: mtfResult(3, 4) }));
    expect(score).toBe(75);
  });

  it("excludes INSUFFICIENT timeframes from the agreement ratio", () => {
    const engine = new ConfidenceEngine();
    // 2 of 3 usable agree with BUY (2 more timeframes are INSUFFICIENT and excluded) → 67, not diluted to 40%.
    const score = engine.scoreMultiTimeframe(baseFactors({ signalSide: "BUY", multiTimeframe: mtfResult(2, 3, 2) }));
    expect(score).toBe(67);
  });
});

describe("ConfidenceEngine.score — multi-timeframe multiplier", () => {
  it("scales down overall confidence when the multi-timeframe multiplier is below 1", () => {
    const engine = new ConfidenceEngine();
    const full = engine.score(baseFactors({ multiTimeframe: { ...mtfResult(4, 5), mtfConfidenceMultiplier: 1.15 } }));
    const weak = engine.score(baseFactors({ multiTimeframe: { ...mtfResult(4, 5), mtfConfidenceMultiplier: 0.7 } }));
    expect(weak.confidence).toBeLessThan(full.confidence);
  });
});

describe("ConfidenceEngine.scoreCorrelation", () => {
  it("returns the neutral 50 when correlation data is unavailable (cold start)", () => {
    const engine = new ConfidenceEngine();
    expect(engine.scoreCorrelation(baseFactors({ correlation: null }))).toBe(50);
  });

  it("reads correlationScore straight through when correlation data is present", () => {
    const engine = new ConfidenceEngine();
    expect(engine.scoreCorrelation(baseFactors({ correlation: correlationSnapshot(83) }))).toBe(83);
  });
});

describe("ConfidenceEngine.score — correlationContext wiring", () => {
  it("produces a higher overall confidence for strongly-confirming correlation than strongly-contradicting, all else equal", () => {
    const engine = new ConfidenceEngine();

    const confirming = engine.score(baseFactors({ correlation: correlationSnapshot(95) }));
    const contradicting = engine.score(baseFactors({ correlation: correlationSnapshot(5) }));

    expect(confirming.confidence).toBeGreaterThan(contradicting.confidence);
    expect(confirming.breakdown.correlationContext).toBe(95);
    expect(contradicting.breakdown.correlationContext).toBe(5);
  });

  it("includes correlationContext in scoreBreakdownOnly's output", () => {
    const engine = new ConfidenceEngine();
    const breakdown = engine.scoreBreakdownOnly(baseFactors({ correlation: correlationSnapshot(62) }));
    expect(breakdown.correlationContext).toBe(62);
  });
});
