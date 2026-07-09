import type { MarketRegime } from "../ai-core/regime.engine.js";
import type { VolatilityLevel } from "../ai-core/volatility.engine.js";
import type { PortfolioDecisionContext } from "../risk-service/portfolio.intelligence.js";

export type RiskInputs = {
  entryPrice: number;
  atr: number;
  direction: 1 | -1;
  trendStrength: number;       // ADX, roughly 0-60+
  volatilityLevel: VolatilityLevel;
  confidence: number;          // 0-100
  marketRegime: MarketRegime;
  mtfConfidenceMultiplier: number; // from MultiTimeframeEngine, ~0.5-1.15
  /** Optional — Phase 5. Absent or omitted: zero effect on output (byte-for-byte unchanged). */
  portfolioContext?: PortfolioDecisionContext;
};

export type RiskOutput = {
  stopLoss: number;
  target1: number;
  target2: number;
  riskRewardRatio: number;
  slMultiple: number;
  tp1Multiple: number;
  tp2Multiple: number;
  rationale: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const VOL_SL_ADJUSTMENT: Record<VolatilityLevel, number> = {
  LOW: -0.25,
  MEDIUM: 0,
  HIGH: 0.25,
  EXTREME: 0.5,
};

const BASE_SL_MULTIPLE = 2.0;
const BASE_TP1_MULTIPLE = 3.0;
const BASE_TP2_MULTIPLE = 5.0;
const MIN_CONFIDENCE_FLOOR = 60; // matches SignalGenerator.MIN_CONFIDENCE — confidence below this never reaches risk sizing

// Phase 6 — small, explicitly bounded nudges applied before the existing
// convictionScale clamp(0.85, 1.6); these can never push the scale outside
// that pre-existing range, only shift where it lands within it.
const PORTFOLIO_HEAT_PENALTY_SCALE = 0.5;
const PORTFOLIO_HEAT_PENALTY_CAP = 0.3;

/**
 * Deterministic ATR-based stop/target sizing — same inputs always produce the
 * same outputs (no randomness, no external calls). Replaces the previous
 * fixed atr*2/atr*3/atr*5 multiples with sizing that adapts to volatility,
 * trend strength, conviction (confidence + multi-timeframe agreement), and
 * regime, while keeping the same SL/TP/RR output shape as before.
 */
export class DynamicRiskEngine {
  compute(inputs: RiskInputs): RiskOutput {
    const { entryPrice, atr, direction, trendStrength, volatilityLevel, confidence, marketRegime, mtfConfidenceMultiplier, portfolioContext } = inputs;

    // Stop distance: wider in noisy/choppy/extreme-volatility conditions,
    // tighter when a strong trend itself acts as support/resistance.
    let slMultiple = BASE_SL_MULTIPLE + VOL_SL_ADJUSTMENT[volatilityLevel];
    if (trendStrength >= 30) slMultiple -= 0.2;
    else if (trendStrength < 15) slMultiple += 0.2;
    slMultiple = clamp(slMultiple, 1.2, 3.5);

    // Reward distance: scales with conviction — confidence above the platform's
    // minimum gate, multi-timeframe agreement, and regime character.
    let convictionScale =
      0.85
      + Math.max(0, confidence - MIN_CONFIDENCE_FLOOR) / 100
      + (mtfConfidenceMultiplier - 1) * 0.6
      + (trendStrength >= 30 ? 0.15 : 0);

    if (marketRegime === "COMPRESSION") convictionScale *= 0.85;
    else if (marketRegime === "EXPANSION") convictionScale *= 1.1;

    // Phase 6 — optional Portfolio Intelligence nudge. Absent input leaves
    // convictionScale (and every downstream value) byte-for-byte unchanged.
    let heatNote = "";
    const heat = portfolioContext?.portfolioHeat;
    if (heat) {
      const penalty = Math.min(PORTFOLIO_HEAT_PENALTY_CAP, (heat.pctOfEquity / 100) * PORTFOLIO_HEAT_PENALTY_SCALE);
      convictionScale -= penalty;
      heatNote = ` Portfolio heat ${heat.pctOfEquity.toFixed(1)}% of equity already at risk (-${penalty.toFixed(2)} conviction).`;
    }

    convictionScale = clamp(convictionScale, 0.85, 1.6);

    const tp1Multiple = BASE_TP1_MULTIPLE * convictionScale;
    const tp2Multiple = BASE_TP2_MULTIPLE * convictionScale;

    const stopLoss = entryPrice - direction * atr * slMultiple;
    const target1  = entryPrice + direction * atr * tp1Multiple;
    const target2  = entryPrice + direction * atr * tp2Multiple;

    const riskAmount   = Math.abs(entryPrice - stopLoss);
    const rewardAmount = Math.abs(target1 - entryPrice);
    const riskRewardRatio = riskAmount > 0 ? Number((rewardAmount / riskAmount).toFixed(2)) : 1.5;

    const rationale =
      `Stop at ${slMultiple.toFixed(2)}× ATR (${atr.toFixed(6)}) — ` +
      `${volatilityLevel} volatility, ${trendStrength >= 30 ? "strong" : trendStrength < 15 ? "weak" : "moderate"} trend (ADX ${trendStrength.toFixed(1)}). ` +
      `Targets at ${tp1Multiple.toFixed(2)}×/${tp2Multiple.toFixed(2)}× ATR — conviction scale ${convictionScale.toFixed(2)} ` +
      `(confidence ${confidence.toFixed(0)}%, MTF ×${mtfConfidenceMultiplier.toFixed(2)}, regime ${marketRegime}).` +
      heatNote;

    return {
      stopLoss,
      target1,
      target2,
      riskRewardRatio,
      slMultiple,
      tp1Multiple,
      tp2Multiple,
      rationale,
    };
  }
}

export const dynamicRiskEngine = new DynamicRiskEngine();
export default DynamicRiskEngine;
