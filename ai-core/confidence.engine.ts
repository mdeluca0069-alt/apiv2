import type { MarketRegime } from "./regime.engine.js";
import type { RSIResult } from "../indicator-engine/rsi.engine.js";
import type { MACDResult } from "../indicator-engine/macd.engine.js";
import type { BollingerResult } from "../indicator-engine/bollinger.engine.js";
import type { VolatilityLevel } from "./volatility.engine.js";
import type { StructureResult } from "../signals-engine/market.structure.js";
import type { MultiTimeframeResult } from "../signals-engine/multi.timeframe.engine.js";
import type { CorrelationSnapshot } from "../signals-engine/correlation.engine.js";

/**
 * Pure UTC-hour-band lookup, extracted out of scoreSession() so other
 * read-only consumers (e.g. signals-engine/market.intelligence.ts) can reuse
 * the exact same session scoring without needing a full ConfluenceFactors
 * object just to read one field off it.
 */
export function sessionScoreForHour(hourUtc: number): number {
  if (hourUtc >= 7  && hourUtc <= 9)  return 100; // London open
  if (hourUtc >= 13 && hourUtc <= 15) return 100; // NY open
  if (hourUtc >= 19 && hourUtc <= 21) return 70;  // late NY
  if (hourUtc <= 6)                    return 40;  // Asian session
  return 55;
}

export type SignalSide = "BUY" | "SELL";

export type ConfluenceFactors = {
  signalSide: SignalSide;
  regime: MarketRegime;
  priceVsEma200: "above" | "below";
  ema50VsEma200: "above" | "below";
  rsi: RSIResult | null;
  macd: MACDResult | null;
  bollinger: BollingerResult | null;
  volatilityLevel: VolatilityLevel;
  volumeAboveAverage: boolean;
  sessionHour: number;         // UTC hour 0-23
  macroEventIn4h: boolean;     // suppress confidence if true
  /** Market structure (swing/BOS/CHoCH) read for this candidate's side — null until MarketStructureEngine has warmed up. */
  structure: StructureResult | null;
  /** Cross-timeframe agreement for this candidate's side — null until evaluated. */
  multiTimeframe: MultiTimeframeResult | null;
  /** Cross-asset correlation confirmation (peers + synthesized DXY) — null until evaluated. */
  correlation: CorrelationSnapshot | null;
};

export type ConfidenceBreakdown = {
  trendAlignment:     number;
  momentumStrength:   number;
  volatilityContext:  number;
  volumeConfirmation: number;
  macroAlignment:     number;
  sessionTiming:      number;
  structureAlignment: number;
  multiTimeframeAlignment: number;
  correlationContext: number;
};

export type ConfidenceResult = {
  confidence: number;
  breakdown: ConfidenceBreakdown;
  reliable: boolean;
  suppressReason: string | null;
};

// Static defaults — used when no adaptive weights have been computed yet.
// Sum must equal 100 — rebalanced when correlationContext was added.
export const DEFAULT_CONFIDENCE_WEIGHTS: Record<keyof ConfidenceBreakdown, number> = {
  trendAlignment:          18,
  momentumStrength:        15,
  volatilityContext:       11,
  volumeConfirmation:      11,
  macroAlignment:          11,
  sessionTiming:           7,
  structureAlignment:      9,
  multiTimeframeAlignment: 10,
  correlationContext:      8,
};

export class ConfidenceEngine {
  /**
   * Optionally accept dynamic weights from AdaptiveWeightsService.
   * Falls back to static defaults when weights is undefined or null.
   */
  score(
    factors: ConfluenceFactors,
    weights?: Partial<Record<keyof ConfidenceBreakdown, number>> | null,
  ): ConfidenceResult {
    // Hard suppression conditions — weights have no effect here
    if (factors.macroEventIn4h) {
      return {
        confidence: 0,
        breakdown: { trendAlignment: 0, momentumStrength: 0, volatilityContext: 0, volumeConfirmation: 0, macroAlignment: 0, sessionTiming: 0, structureAlignment: 0, multiTimeframeAlignment: 0, correlationContext: 0 },
        reliable: false,
        suppressReason: "High-impact macro event within 4 hours — signal suppressed.",
      };
    }
    if (factors.regime === "RISK_OFF") {
      return {
        confidence: 0,
        breakdown: { trendAlignment: 0, momentumStrength: 0, volatilityContext: 0, volumeConfirmation: 0, macroAlignment: 0, sessionTiming: 0, structureAlignment: 0, multiTimeframeAlignment: 0, correlationContext: 0 },
        reliable: false,
        suppressReason: "Risk-off regime — all signals suppressed.",
      };
    }

    const activeWeights = this._mergeWeights(weights);

    const breakdown: ConfidenceBreakdown = {
      trendAlignment:     this.scoreTrend(factors),
      momentumStrength:   this.scoreMomentum(factors),
      volatilityContext:  this.scoreVolatility(factors),
      volumeConfirmation: this.scoreVolume(factors),
      macroAlignment:     this.scoreMacro(factors),
      sessionTiming:      this.scoreSession(factors),
      structureAlignment: this.scoreStructure(factors),
      multiTimeframeAlignment: this.scoreMultiTimeframe(factors),
      correlationContext: this.scoreCorrelation(factors),
    };

    // Weighted sum (each sub-score is 0–100; weight is its share of 100)
    const raw = (Object.keys(activeWeights) as (keyof ConfidenceBreakdown)[]).reduce((sum, key) => {
      return sum + (breakdown[key] / 100) * activeWeights[key];
    }, 0);

    // Regime multiplier (applied on top of weights)
    const regimeMultiplier =
      factors.regime === "COMPRESSION" ? 0.7
      : factors.regime === "EXPANSION" ? 0.85
      : 1.0;

    // Multi-timeframe multiplier — shapes magnitude on top of the weighted sub-score
    // so a single-timeframe-only setup can't be fully compensated by 7 other strong
    // scores; the hard "never alone" gate itself lives in signal.generator.ts.
    const mtfMultiplier = factors.multiTimeframe?.mtfConfidenceMultiplier ?? 1.0;

    const confidence = Math.round(Math.min(100, raw * regimeMultiplier * mtfMultiplier));
    const reliable   = confidence >= 60;

    return { confidence, breakdown, reliable, suppressReason: null };
  }

  /**
   * Score all sub-dimensions without computing the weighted total.
   * Used by the SelfOptimizer to recompute dimension scores from stored
   * indicator snapshots without needing to re-run the full evaluate() pipeline.
   */
  scoreBreakdownOnly(factors: ConfluenceFactors): ConfidenceBreakdown {
    return {
      trendAlignment:     this.scoreTrend(factors),
      momentumStrength:   this.scoreMomentum(factors),
      volatilityContext:  this.scoreVolatility(factors),
      volumeConfirmation: this.scoreVolume(factors),
      macroAlignment:     this.scoreMacro(factors),
      sessionTiming:      this.scoreSession(factors),
      structureAlignment: this.scoreStructure(factors),
      multiTimeframeAlignment: this.scoreMultiTimeframe(factors),
      correlationContext: this.scoreCorrelation(factors),
    };
  }

  // ── Sub-scorers (public so SelfOptimizer can invoke them individually) ───────

  scoreTrend(f: ConfluenceFactors): number {
    const aligned =
      (f.signalSide === "BUY"  && f.priceVsEma200 === "above" && f.ema50VsEma200 === "above") ||
      (f.signalSide === "SELL" && f.priceVsEma200 === "below" && f.ema50VsEma200 === "below");
    const partialAlign =
      (f.signalSide === "BUY"  && f.priceVsEma200 === "above") ||
      (f.signalSide === "SELL" && f.priceVsEma200 === "below");

    if (aligned)      return 100;
    if (partialAlign) return 60;
    return 15;
  }

  scoreMomentum(f: ConfluenceFactors): number {
    let score = 50;

    if (f.rsi) {
      if (f.signalSide === "BUY"  && f.rsi.zone === "oversold")   score += 25;
      if (f.signalSide === "SELL" && f.rsi.zone === "overbought") score += 25;
      if (f.signalSide === "BUY"  && f.rsi.value > 60)            score -= 15;
      if (f.signalSide === "SELL" && f.rsi.value < 40)            score -= 15;
    }

    if (f.macd) {
      if (f.signalSide === "BUY"  && f.macd.crossover === "bullish_cross") score += 25;
      if (f.signalSide === "SELL" && f.macd.crossover === "bearish_cross") score += 25;
      if (f.signalSide === "BUY"  && f.macd.bias === "bullish")  score += 10;
      if (f.signalSide === "SELL" && f.macd.bias === "bearish")  score += 10;
    }

    return Math.max(0, Math.min(100, score));
  }

  scoreVolatility(f: ConfluenceFactors): number {
    if (f.volatilityLevel === "MEDIUM")  return 100;
    if (f.volatilityLevel === "LOW")     return 70;
    if (f.volatilityLevel === "HIGH")    return 50;
    return 10; // EXTREME
  }

  scoreVolume(f: ConfluenceFactors): number {
    return f.volumeAboveAverage ? 100 : 40;
  }

  scoreMacro(f: ConfluenceFactors): number {
    return f.macroEventIn4h ? 0 : 100;
  }

  scoreSession(f: ConfluenceFactors): number {
    return sessionScoreForHour(f.sessionHour);
  }

  /** Neutral 50 when structure hasn't warmed up yet — never blocks a signal, only shapes its magnitude. */
  scoreStructure(f: ConfluenceFactors): number {
    return f.structure?.structureScore ?? 50;
  }

  /** Share of usable timeframes agreeing with signalSide, scaled to 0-100. Neutral 50 when not yet evaluated. */
  scoreMultiTimeframe(f: ConfluenceFactors): number {
    const mtf = f.multiTimeframe;
    if (!mtf) return 50;
    const usable = mtf.timeframes.filter((t) => t.dataQuality !== "INSUFFICIENT");
    if (!usable.length) return 50;
    const sideCount = usable.filter((t) => t.direction === f.signalSide).length;
    return Math.round((sideCount / usable.length) * 100);
  }

  /** Share of correlated peers/DXY confirming this candidate's side, scaled to 0-100. Neutral 50 when not yet evaluated. */
  scoreCorrelation(f: ConfluenceFactors): number {
    return f.correlation?.correlationScore ?? 50;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _mergeWeights(
    overrides?: Partial<Record<keyof ConfidenceBreakdown, number>> | null,
  ): Record<keyof ConfidenceBreakdown, number> {
    if (!overrides) return { ...DEFAULT_CONFIDENCE_WEIGHTS };
    const merged = { ...DEFAULT_CONFIDENCE_WEIGHTS };
    for (const key of Object.keys(DEFAULT_CONFIDENCE_WEIGHTS) as (keyof ConfidenceBreakdown)[]) {
      if (overrides[key] !== undefined && !isNaN(overrides[key]!)) {
        merged[key] = overrides[key]!;
      }
    }
    return merged;
  }
}

export default ConfidenceEngine;
