/**
 * SignalExplainer — read-only assembly layer for "why did OLOS generate this
 * signal?" Performs no new scoring math: every number it surfaces was already
 * computed by ConfidenceEngine/MarketStructureEngine/MultiTimeframeEngine/
 * CorrelationEngine (Phases 1-4) and stored in SignalTelemetry.indicatorsSnapshot,
 * or comes from CalibrationService.predictProbabilities() (Phase 5). This file
 * only fetches, ranks, and narrates what already exists.
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { DEFAULT_CONFIDENCE_WEIGHTS } from "../ai-core/confidence.engine.js";
import { calibrationService, type ProbabilisticForecast } from "./calibration.service.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExplanationDimension = {
  dimension:    string;
  score:        number;   // 0-100, the sub-score actually used at generation time
  weight:       number;   // share of 100 this dimension was assigned
  contribution: number;   // (score/100) * weight — this dimension's share of the final confidence
};

export type SignalExplanation = {
  signalId:          string;
  symbol:            string;
  signalType:        "BUY" | "SELL";
  confidence:        number;
  marketRegime:      string;
  volatilityLevel:   string;
  confluenceFactors: string[];
  generatedAt:        string;
  weightsVersion:     number;
  dimensions:         ExplanationDimension[]; // sorted by contribution, descending
  topDrivers:         string[];               // top 3 dimension names by contribution
  topDetractors:      string[];               // bottom 3 weighted dimensions by contribution
  structurePhase:     string | null;
  structureEvents:    unknown[];
  multiTimeframe:     Record<string, unknown> | null;
  correlation:        Record<string, unknown> | null;
  entryRationale:     string | null;
  slRationale:        string | null;
  probability:        ProbabilisticForecast | null;
  narrative:          string;
};

// ─── Service ─────────────────────────────────────────────────────────────────

export class SignalExplainer {
  async explainSignal(signalId: string): Promise<SignalExplanation | null> {
    if (!IS_PERSISTENT || !prisma) return null;
    const db = prisma as NonNullable<typeof prisma>;

    const telemetry = await db.signalTelemetry.findUnique({
      where:  { signalId },
      select: {
        signalId: true, symbol: true, signalType: true, confidence: true,
        marketRegime: true, volatilityLevel: true, confluenceFactors: true,
        indicatorsSnapshot: true, generatedAt: true,
      },
    }).catch(() => null);

    if (!telemetry) return null;

    const snapshot   = (telemetry.indicatorsSnapshot ?? {}) as Record<string, unknown>;
    const breakdown  = (snapshot["breakdown"] ?? {}) as Record<string, number>;
    const weightsVersion = Number(snapshot["weightsVersion"] ?? 0) || 0;

    const weights = await this._resolveWeights(weightsVersion);

    const dimensions: ExplanationDimension[] = Object.keys(weights)
      .filter((dim) => breakdown[dim] !== undefined && !isNaN(breakdown[dim]))
      .map((dim) => {
        const score  = breakdown[dim]!;
        const weight = weights[dim] ?? 0;
        return { dimension: dim, score, weight, contribution: Math.round((score / 100) * weight * 100) / 100 };
      })
      .sort((a, b) => b.contribution - a.contribution);

    const topDrivers = dimensions.slice(0, 3).map((d) => d.dimension);
    const topDetractors = dimensions
      .filter((d) => d.weight > 0)
      .slice(-3)
      .map((d) => d.dimension)
      .reverse();

    const olosSignal = await db.olosSignal.findUnique({
      where:  { id: signalId },
      select: { entryRationale: true, slRationale: true },
    }).catch(() => null);

    const probability = await calibrationService
      .predictProbabilities(telemetry.confidence, telemetry.marketRegime, breakdown)
      .catch(() => null);

    const narrative = this._buildNarrative({
      symbol:           telemetry.symbol,
      signalType:        telemetry.signalType as "BUY" | "SELL",
      confidence:        telemetry.confidence,
      marketRegime:      telemetry.marketRegime,
      topDrivers,
      topDetractors,
      structurePhase:    (snapshot["structurePhase"] as string | undefined) ?? null,
      probability,
    });

    return {
      signalId:          telemetry.signalId,
      symbol:             telemetry.symbol,
      signalType:         telemetry.signalType as "BUY" | "SELL",
      confidence:         telemetry.confidence,
      marketRegime:       telemetry.marketRegime,
      volatilityLevel:    telemetry.volatilityLevel,
      confluenceFactors: (telemetry.confluenceFactors as unknown as string[]) ?? [],
      generatedAt:        telemetry.generatedAt.toISOString(),
      weightsVersion,
      dimensions,
      topDrivers,
      topDetractors,
      structurePhase:    (snapshot["structurePhase"] as string | undefined) ?? null,
      structureEvents:   (snapshot["structureEvents"] as unknown[] | undefined) ?? [],
      multiTimeframe:    (snapshot["multiTimeframe"] as Record<string, unknown> | undefined) ?? null,
      correlation:       (snapshot["correlation"] as Record<string, unknown> | undefined) ?? null,
      entryRationale:    olosSignal?.entryRationale ?? null,
      slRationale:       olosSignal?.slRationale ?? null,
      probability,
      narrative,
    };
  }

  /** Reconstructs the weight set actually in effect at generation time, falling back to current defaults. */
  private async _resolveWeights(version: number): Promise<Record<string, number>> {
    if (version > 0 && prisma) {
      const db  = prisma as NonNullable<typeof prisma>;
      const row = await db.confidenceWeights.findUnique({ where: { version } }).catch(() => null);
      if (row?.weights) return row.weights as Record<string, number>;
    }
    return { ...DEFAULT_CONFIDENCE_WEIGHTS };
  }

  private _buildNarrative(opts: {
    symbol:         string;
    signalType:     "BUY" | "SELL";
    confidence:     number;
    marketRegime:   string;
    topDrivers:     string[];
    topDetractors:  string[];
    structurePhase: string | null;
    probability:    ProbabilisticForecast | null;
  }): string {
    const dirWord = opts.signalType === "BUY" ? "bullish" : "bearish";
    const drivers = opts.topDrivers.length ? opts.topDrivers.join(", ") : "no single dominant dimension";

    let text = `${opts.symbol} ${opts.signalType} signal at ${opts.confidence}% confidence ` +
      `(${dirWord} bias, ${opts.marketRegime} regime). Primarily driven by: ${drivers}.`;

    if (opts.topDetractors.length) {
      text += ` Weakest contributing factors: ${opts.topDetractors.join(", ")}.`;
    }
    if (opts.structurePhase) {
      text += ` Market structure phase: ${opts.structurePhase}.`;
    }
    if (opts.probability) {
      const p = opts.probability;
      text += ` Historically, similar signals reached target1 ${Math.round(p.pTp1 * 100)}% of the time ` +
        `and target2 ${Math.round(p.pTp2 * 100)}% of the time, with a ${Math.round(p.pFailure * 100)}% stop-out rate` +
        (p.status === "insufficient_data" ? " (thin historical sample — indicative only)." : ".");
    }

    return text;
  }
}

export const signalExplainer = new SignalExplainer();
export default SignalExplainer;
