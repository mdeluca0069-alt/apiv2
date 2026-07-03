/**
 * dynamic.risk.engine.test.ts
 *
 * Unit tests for DynamicRiskEngine — deterministic SL/TP/RR sizing that
 * replaced the old fixed atr*2/atr*3/atr*5 multiples. Coverage: determinism,
 * monotonicity (volatility/trend/conviction/regime), direction correctness,
 * the atr=0 edge case, and (Task 13 Phase 6) the optional marketIntelligence/
 * portfolioContext nudges to convictionScale.
 */
import { describe, it, expect } from "vitest";
import { DynamicRiskEngine, type RiskInputs } from "../signals-engine/dynamic.risk.engine.js";
import type { MarketIntelligenceSnapshot } from "../signals-engine/market.intelligence.js";
import type { PortfolioDecisionContext } from "../risk-service/portfolio.intelligence.js";

function baseInputs(overrides: Partial<RiskInputs> = {}): RiskInputs {
  return {
    entryPrice: 100,
    atr: 1,
    direction: 1,
    trendStrength: 20,
    volatilityLevel: "MEDIUM",
    confidence: 75,
    marketRegime: "RANGING",
    mtfConfidenceMultiplier: 1.0,
    ...overrides,
  };
}

// Deliberately partial fixtures — DynamicRiskEngine only ever reads
// .marketBreadth off MarketIntelligenceSnapshot and .portfolioHeat off
// PortfolioDecisionContext, so only those fields are populated.
function withBreadth(pctAboveEma200: number): MarketIntelligenceSnapshot {
  return { marketBreadth: { universeSize: 5, pctAboveEma200 } } as MarketIntelligenceSnapshot;
}
function withHeat(pctOfEquity: number): PortfolioDecisionContext {
  return { portfolioHeat: { riskAtStakeUsd: 0, pctOfEquity, unprotectedPositions: 0 } } as PortfolioDecisionContext;
}

describe("DynamicRiskEngine — determinism", () => {
  it("produces byte-identical output for identical inputs", () => {
    const engine = new DynamicRiskEngine();
    const a = engine.compute(baseInputs());
    const b = engine.compute(baseInputs());
    expect(a).toEqual(b);
  });
});

describe("DynamicRiskEngine — volatility monotonicity", () => {
  it("widens the stop under EXTREME volatility compared to LOW volatility, all else equal", () => {
    const engine = new DynamicRiskEngine();
    const low = engine.compute(baseInputs({ volatilityLevel: "LOW" }));
    const extreme = engine.compute(baseInputs({ volatilityLevel: "EXTREME" }));
    expect(extreme.slMultiple).toBeGreaterThan(low.slMultiple);
  });
});

describe("DynamicRiskEngine — trend strength monotonicity", () => {
  it("uses a tighter stop in a strong trend than in a choppy/weak trend, all else equal", () => {
    const engine = new DynamicRiskEngine();
    const strong = engine.compute(baseInputs({ trendStrength: 35 }));
    const weak = engine.compute(baseInputs({ trendStrength: 10 }));
    expect(strong.slMultiple).toBeLessThan(weak.slMultiple);
  });
});

describe("DynamicRiskEngine — conviction monotonicity", () => {
  it("extends targets for higher confidence, all else equal", () => {
    const engine = new DynamicRiskEngine();
    const lowConf = engine.compute(baseInputs({ confidence: 60 }));
    const highConf = engine.compute(baseInputs({ confidence: 95 }));
    expect(highConf.tp1Multiple).toBeGreaterThan(lowConf.tp1Multiple);
    expect(highConf.tp2Multiple).toBeGreaterThan(lowConf.tp2Multiple);
  });

  it("extends targets for stronger multi-timeframe agreement, all else equal", () => {
    const engine = new DynamicRiskEngine();
    const weakMtf = engine.compute(baseInputs({ mtfConfidenceMultiplier: 0.7 }));
    const strongMtf = engine.compute(baseInputs({ mtfConfidenceMultiplier: 1.15 }));
    expect(strongMtf.tp1Multiple).toBeGreaterThan(weakMtf.tp1Multiple);
  });
});

describe("DynamicRiskEngine — regime adjustment", () => {
  it("narrows targets in COMPRESSION and widens them in EXPANSION, relative to RANGING", () => {
    const engine = new DynamicRiskEngine();
    const ranging = engine.compute(baseInputs({ marketRegime: "RANGING" }));
    const compression = engine.compute(baseInputs({ marketRegime: "COMPRESSION" }));
    const expansion = engine.compute(baseInputs({ marketRegime: "EXPANSION" }));

    expect(compression.tp1Multiple).toBeLessThan(ranging.tp1Multiple);
    expect(expansion.tp1Multiple).toBeGreaterThan(ranging.tp1Multiple);
  });
});

describe("DynamicRiskEngine — direction correctness", () => {
  it("places stop below and targets above entry for a BUY", () => {
    const engine = new DynamicRiskEngine();
    const r = engine.compute(baseInputs({ direction: 1, entryPrice: 100 }));
    expect(r.stopLoss).toBeLessThan(100);
    expect(r.target1).toBeGreaterThan(100);
    expect(r.target2).toBeGreaterThan(r.target1);
  });

  it("places stop above and targets below entry for a SELL", () => {
    const engine = new DynamicRiskEngine();
    const r = engine.compute(baseInputs({ direction: -1, entryPrice: 100 }));
    expect(r.stopLoss).toBeGreaterThan(100);
    expect(r.target1).toBeLessThan(100);
    expect(r.target2).toBeLessThan(r.target1);
  });
});

describe("DynamicRiskEngine — edge cases", () => {
  it("falls back to a 1.5 risk/reward ratio when atr is 0 (zero-width stop)", () => {
    const engine = new DynamicRiskEngine();
    const r = engine.compute(baseInputs({ atr: 0 }));
    expect(r.stopLoss).toBe(100);
    expect(r.target1).toBe(100);
    expect(r.riskRewardRatio).toBe(1.5);
  });

  it("keeps slMultiple within the documented [1.2, 3.5] bound across extreme inputs", () => {
    const engine = new DynamicRiskEngine();
    const extremeWide = engine.compute(baseInputs({ volatilityLevel: "EXTREME", trendStrength: 5 }));
    const extremeTight = engine.compute(baseInputs({ volatilityLevel: "LOW", trendStrength: 50 }));
    expect(extremeWide.slMultiple).toBeLessThanOrEqual(3.5);
    expect(extremeTight.slMultiple).toBeGreaterThanOrEqual(1.2);
  });

  it("never produces NaN or non-finite values across a sweep of input combinations", () => {
    const engine = new DynamicRiskEngine();
    const vols: RiskInputs["volatilityLevel"][] = ["LOW", "MEDIUM", "HIGH", "EXTREME"];
    const regimes: RiskInputs["marketRegime"][] = ["RANGING", "COMPRESSION", "EXPANSION", "BULLISH_TREND", "BEARISH_TREND"];
    for (const volatilityLevel of vols) {
      for (const marketRegime of regimes) {
        for (const trendStrength of [0, 10, 25, 40, 60]) {
          for (const confidence of [60, 80, 100]) {
            const r = engine.compute(baseInputs({ volatilityLevel, marketRegime, trendStrength, confidence }));
            for (const v of [r.stopLoss, r.target1, r.target2, r.riskRewardRatio, r.slMultiple, r.tp1Multiple, r.tp2Multiple]) {
              expect(Number.isFinite(v)).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe("DynamicRiskEngine — risk/reward consistency", () => {
  it("riskRewardRatio equals tp1Multiple/slMultiple regardless of atr magnitude", () => {
    const engine = new DynamicRiskEngine();
    for (const atr of [0.5, 1, 3.7, 12]) {
      const r = engine.compute(baseInputs({ atr }));
      expect(r.riskRewardRatio).toBeCloseTo(r.tp1Multiple / r.slMultiple, 2);
    }
  });
});

describe("DynamicRiskEngine — Phase 6: optional marketIntelligence/portfolioContext", () => {
  it("is byte-for-byte unchanged when both optional fields are omitted", () => {
    const engine = new DynamicRiskEngine();
    const withoutFields = engine.compute(baseInputs());
    const explicitlyUndefined = engine.compute(baseInputs({ marketIntelligence: undefined, portfolioContext: undefined }));
    expect(explicitlyUndefined).toEqual(withoutFields);
  });

  it("high market breadth raises conviction for a BUY and lowers it for a SELL, relative to the no-breadth baseline", () => {
    const engine = new DynamicRiskEngine();
    const baselineBuy  = engine.compute(baseInputs({ direction: 1 }));
    const highBreadthBuy = engine.compute(baseInputs({ direction: 1, marketIntelligence: withBreadth(90) }));
    expect(highBreadthBuy.tp1Multiple).toBeGreaterThan(baselineBuy.tp1Multiple);

    const baselineSell  = engine.compute(baseInputs({ direction: -1 }));
    const highBreadthSell = engine.compute(baseInputs({ direction: -1, marketIntelligence: withBreadth(90) }));
    expect(highBreadthSell.tp1Multiple).toBeLessThan(baselineSell.tp1Multiple);
  });

  it("low market breadth lowers conviction for a BUY and raises it for a SELL, relative to the no-breadth baseline", () => {
    const engine = new DynamicRiskEngine();
    const baselineBuy = engine.compute(baseInputs({ direction: 1 }));
    const lowBreadthBuy = engine.compute(baseInputs({ direction: 1, marketIntelligence: withBreadth(10) }));
    expect(lowBreadthBuy.tp1Multiple).toBeLessThan(baselineBuy.tp1Multiple);

    const baselineSell = engine.compute(baseInputs({ direction: -1 }));
    const lowBreadthSell = engine.compute(baseInputs({ direction: -1, marketIntelligence: withBreadth(10) }));
    expect(lowBreadthSell.tp1Multiple).toBeGreaterThan(baselineSell.tp1Multiple);
  });

  it("higher portfolio heat narrows targets relative to the zero-heat baseline", () => {
    const engine = new DynamicRiskEngine();
    const noHeat   = engine.compute(baseInputs({ portfolioContext: withHeat(0) }));
    const highHeat = engine.compute(baseInputs({ portfolioContext: withHeat(60) }));
    expect(highHeat.tp1Multiple).toBeLessThan(noHeat.tp1Multiple);
  });

  it("never pushes convictionScale-derived multiples outside the pre-existing [0.85, 1.6] scale bounds, even at extreme breadth/heat values", () => {
    const engine = new DynamicRiskEngine();
    for (const pctAboveEma200 of [0, 50, 100]) {
      for (const pctOfEquity of [0, 200, 1000]) {
        for (const direction of [1, -1] as const) {
          const r = engine.compute(baseInputs({
            direction,
            marketIntelligence: withBreadth(pctAboveEma200),
            portfolioContext: withHeat(pctOfEquity),
          }));
          expect(r.tp1Multiple).toBeGreaterThanOrEqual(3.0 * 0.85);
          expect(r.tp1Multiple).toBeLessThanOrEqual(3.0 * 1.6);
          expect(Number.isFinite(r.tp1Multiple)).toBe(true);
        }
      }
    }
  });

  it("appends a breadth/heat note to the rationale only when the corresponding optional input is present", () => {
    const engine = new DynamicRiskEngine();
    const plain = engine.compute(baseInputs());
    expect(plain.rationale).not.toContain("Market breadth");
    expect(plain.rationale).not.toContain("Portfolio heat");

    const withBoth = engine.compute(baseInputs({ marketIntelligence: withBreadth(70), portfolioContext: withHeat(20) }));
    expect(withBoth.rationale).toContain("Market breadth");
    expect(withBoth.rationale).toContain("Portfolio heat");
  });
});
