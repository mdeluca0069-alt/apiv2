/**
 * CalibrationService — measures how well OLOS confidence scores predict
 * actual trade outcomes.
 *
 * A perfectly calibrated model at confidence=80% would win exactly 80% of the
 * time. Calibration analysis answers: does stated confidence match reality?
 *
 * Metrics implemented:
 *
 *   Reliability Diagram — expected vs actual win rate per confidence band.
 *     Overconfident: actual < expected (model claims 80%, really wins 60%)
 *     Underconfident: actual > expected (model claims 65%, really wins 75%)
 *
 *   ECE (Expected Calibration Error) — weighted mean absolute calibration
 *     error across bands. Lower is better. < 0.05 = well calibrated.
 *
 *   MCE (Maximum Calibration Error) — worst-case band error.
 *
 *   Brier Score — mean squared error between confidence and binary outcome.
 *     Perfect = 0.0. Random = 0.25. Lower is better.
 *
 *   Sharpness — variance of confidence scores. High sharpness = the model
 *     is decisive (avoids 50/50 hedging). Must be paired with low ECE to
 *     be meaningful.
 *
 *   Resolution — covariance between confidence and outcome. A model with
 *     high resolution correctly separates wins from losses by confidence.
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";
import type { StressScenario } from "../risk-service/var.engine.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CalibrationBand = {
  bandLabel:       string;   // "60-70", "70-80", "80-90", "90-100"
  lowerBound:      number;
  upperBound:      number;
  count:           number;
  meanConfidence:  number;   // average stated confidence in this band
  actualWinRate:   number;   // observed win rate (0-1)
  expectedWinRate: number;   // meanConfidence / 100
  calibrationError: number;  // abs(actualWinRate - expectedWinRate)
  bias:            "overconfident" | "underconfident" | "calibrated";
};

export type CalibrationMetrics = {
  totalSignals:      number;
  closedSignals:     number;
  ece:               number;   // Expected Calibration Error (0-1)
  mce:               number;   // Maximum Calibration Error (0-1)
  brierScore:        number;   // mean squared error (0-1)
  sharpness:         number;   // variance of confidence scores (0-1 scale)
  resolution:        number;   // covariance(confidence, outcome) — positive = discriminative
  overallBias:       "overconfident" | "underconfident" | "calibrated";
  bands:             CalibrationBand[];
  dimensionAccuracy: DimensionAccuracy[];
  computedAt:        string;
};

export type DimensionAccuracy = {
  dimension:    string;
  higherWins:   boolean;   // true if higher sub-score correlates with wins
  correlation:  number;    // Pearson r between sub-score and win(1)/loss(0)
  meanWin:      number;    // avg sub-score for winning signals
  meanLoss:     number;    // avg sub-score for losing signals
  lift:         number;    // meanWin - meanLoss (positive = dimension is predictive)
};

export type ConfidenceAccuracyBucket = {
  bucket:           string;       // "50-59", "60-69", "70-79", "80-89", "90-100"
  lo:               number;
  hi:               number;
  count:            number;
  actualWinRate:    number;       // 0-1 observed win rate
  targetWinRate:    number;       // bucket midpoint / 100 (e.g. 0.75 for 70-79)
  calibrationGap:   number;       // actualWinRate - targetWinRate
  calibrationError: number;       // abs(calibrationGap)
  status:           "well_calibrated" | "overconfident" | "underconfident" | "insufficient_data";
  recommendation:   string;
  avgPnl:           number;
  totalPnl:         number;
};

export type ConfidenceAccuracyReport = {
  buckets:          ConfidenceAccuracyBucket[];
  ece:              number;   // Expected Calibration Error across full range
  mce:              number;   // Maximum Calibration Error
  brierScore:       number;
  overallStatus:    "well_calibrated" | "overconfident" | "underconfident";
  recommendation:   string;
  totalSignals:     number;
  closedSignals:    number;
  computedAt:       string;
};

export type ProbabilisticForecast = {
  confidence:      number;
  regime:          string;
  pTp1:            number;   // 0-1, empirical probability MFE reached the target1 distance
  pTp2:            number;   // 0-1, empirical probability MFE reached the target2 distance
  pFailure:        number;   // 0-1, empirical probability of a stop-out (outcome === LOSS)
  sampleSize:      number;
  basis:           "regime_confidence_band" | "confidence_band_only" | "uninformed_prior";
  dimensionSignal: number;   // -1..+1, historical lift of the supplied breakdown's sub-scores
  status:          "calibrated" | "insufficient_data";
};

const PROB_MIN_SAMPLE = 10; // mirrors getConfidenceAccuracyReport's resolved<10 threshold
const PROB_CONFIDENCE_BUCKETS: [number, number][] = [[50, 59], [60, 69], [70, 79], [80, 89], [90, 100]];

// Phase 7 — Beta-Binomial conjugate update (textbook): posterior Beta(alpha+wins, beta+losses).
// 95% credible interval uses the normal approximation to the Beta distribution
// (mean +- 1.96*sd), the simplest standard approximation — exact Beta quantiles
// would need numerical inversion of the incomplete beta function, unwarranted here.
const CREDIBLE_INTERVAL_Z = 1.96;

export type BayesianPosterior = {
  priorMean:     number;
  priorStrength: number;       // alpha+beta — the prior's pseudo-sample-size
  observedWins:  number;
  observedLosses: number;
  posteriorAlpha: number;
  posteriorBeta:  number;
  posteriorMean:  number;
  credibleInterval95: [number, number];
};

// Phase 7 — scenario-conditioned forecast: reuses VarEngine's existing named
// stress scenarios (no new scenario taxonomy) and applies a simple, explicitly
// heuristic linear severity haircut to the base forecast — not a new
// probability model, just a transparent worst-case discount.
const STRESS_SEVERITY_HAIRCUT: Record<StressScenario["severity"], number> = {
  mild:     0.10,
  moderate: 0.25,
  severe:   0.50,
  extreme:  0.80,
};

export type ScenarioConditionedForecast = {
  scenario:        string;
  severity:        StressScenario["severity"];
  basePFailure:    number;
  stressedPFailure: number;
  basePTp1:        number;
  stressedPTp1:    number;
  basePTp2:        number;
  stressedPTp2:    number;
};

type ProbRow = {
  entryPrice: unknown;
  target1:    unknown;
  target2:    unknown;
  outcome:    string;
  maxFavorableExcursion: unknown;
};

// ─── Service ─────────────────────────────────────────────────────────────────

class CalibrationService {

  async getMetrics(): Promise<CalibrationMetrics> {
    const empty = this._empty();
    if (!IS_PERSISTENT || !prisma) return empty;

    const db = prisma as NonNullable<typeof prisma>;

    // Pull all closed signals with confidence + outcome
    const rows = await db.signalTelemetry.findMany({
      where:  { outcome: { in: ["WIN", "LOSS", "BREAKEVEN"] } },
      select: {
        confidence:         true,
        outcome:            true,
        indicatorsSnapshot: true,
      },
    }).catch(() => []);

    if (rows.length === 0) return empty;

    const total = await db.signalTelemetry.count().catch(() => 0);

    // Binary outcome: WIN = 1, LOSS/BREAKEVEN = 0
    const pairs: Array<{ conf: number; win: number }> = rows.map((r) => ({
      conf: r.confidence,
      win:  r.outcome === "WIN" ? 1 : 0,
    }));

    const bands     = this._buildBands(pairs);
    const ece       = this._computeECE(bands, pairs.length);
    const mce       = Math.max(0, ...bands.map((b) => b.calibrationError));
    const brier     = this._brierScore(pairs);
    const sharpness = this._sharpness(pairs);
    const resolution = this._resolution(pairs);
    const overallBias = this._overallBias(bands);

    // Per-dimension accuracy from stored breakdown in indicatorsSnapshot
    const dimensionAccuracy = this._dimensionAccuracy(rows as Array<{
      confidence: number;
      outcome:    string;
      indicatorsSnapshot: unknown;
    }>);

    return {
      totalSignals:   total,
      closedSignals:  rows.length,
      ece,
      mce,
      brierScore:     brier,
      sharpness,
      resolution,
      overallBias,
      bands,
      dimensionAccuracy,
      computedAt: new Date().toISOString(),
    };
  }

  // ── Private: band construction ──────────────────────────────────────────────

  private _buildBands(pairs: Array<{ conf: number; win: number }>): CalibrationBand[] {
    const bandDefs = [
      { label: "60-70",  lo: 60, hi: 70  },
      { label: "70-80",  lo: 70, hi: 80  },
      { label: "80-90",  lo: 80, hi: 90  },
      { label: "90-100", lo: 90, hi: 101 },
    ];

    return bandDefs.map(({ label, lo, hi }) => {
      const inBand = pairs.filter((p) => p.conf >= lo && p.conf < hi);
      if (inBand.length === 0) {
        return {
          bandLabel: label, lowerBound: lo, upperBound: hi === 101 ? 100 : hi,
          count: 0, meanConfidence: (lo + hi) / 2, actualWinRate: 0,
          expectedWinRate: ((lo + hi) / 2) / 100, calibrationError: 0,
          bias: "calibrated" as const,
        };
      }
      const meanConf  = inBand.reduce((s, p) => s + p.conf, 0) / inBand.length;
      const winRate   = inBand.reduce((s, p) => s + p.win, 0) / inBand.length;
      const expected  = meanConf / 100;
      const error     = Math.abs(winRate - expected);
      const bias: CalibrationBand["bias"] =
        error < 0.05 ? "calibrated" :
        winRate < expected ? "overconfident" : "underconfident";

      return {
        bandLabel:        label,
        lowerBound:       lo,
        upperBound:       hi === 101 ? 100 : hi,
        count:            inBand.length,
        meanConfidence:   Math.round(meanConf * 10) / 10,
        actualWinRate:    Math.round(winRate * 1000) / 1000,
        expectedWinRate:  Math.round(expected * 1000) / 1000,
        calibrationError: Math.round(error * 1000) / 1000,
        bias,
      };
    });
  }

  // ── Private: scalar metrics ──────────────────────────────────────────────────

  private _computeECE(bands: CalibrationBand[], total: number): number {
    if (total === 0) return 0;
    return bands.reduce((acc, b) => acc + (b.count / total) * b.calibrationError, 0);
  }

  private _brierScore(pairs: Array<{ conf: number; win: number }>): number {
    if (pairs.length === 0) return 0;
    const sum = pairs.reduce((acc, { conf, win }) => {
      const p = conf / 100;
      return acc + (p - win) ** 2;
    }, 0);
    return Math.round((sum / pairs.length) * 10_000) / 10_000;
  }

  private _sharpness(pairs: Array<{ conf: number; win: number }>): number {
    if (pairs.length === 0) return 0;
    const confs = pairs.map((p) => p.conf / 100);
    const mean  = confs.reduce((a, b) => a + b, 0) / confs.length;
    const variance = confs.reduce((a, c) => a + (c - mean) ** 2, 0) / confs.length;
    return Math.round(variance * 10_000) / 10_000;
  }

  private _resolution(pairs: Array<{ conf: number; win: number }>): number {
    if (pairs.length < 2) return 0;
    const n    = pairs.length;
    const confs = pairs.map((p) => p.conf / 100);
    const wins  = pairs.map((p) => p.win);
    const mc   = confs.reduce((a, b) => a + b, 0) / n;
    const mw   = wins.reduce((a, b) => a + b, 0) / n;
    const cov  = pairs.reduce((acc, _, i) => acc + (confs[i]! - mc) * (wins[i]! - mw), 0) / n;
    return Math.round(cov * 10_000) / 10_000;
  }

  private _overallBias(bands: CalibrationBand[]): CalibrationBand["bias"] {
    const withData = bands.filter((b) => b.count > 0);
    if (withData.length === 0) return "calibrated";
    const over  = withData.filter((b) => b.bias === "overconfident").length;
    const under = withData.filter((b) => b.bias === "underconfident").length;
    if (over > under) return "overconfident";
    if (under > over) return "underconfident";
    return "calibrated";
  }

  // ── Private: per-dimension accuracy ─────────────────────────────────────────

  private _dimensionAccuracy(rows: Array<{
    confidence: number;
    outcome:    string;
    indicatorsSnapshot: unknown;
  }>): DimensionAccuracy[] {
    const dims = [
      "trendAlignment",
      "momentumStrength",
      "volatilityContext",
      "volumeConfirmation",
      "macroAlignment",
      "sessionTiming",
      "structureAlignment",
      "multiTimeframeAlignment",
      "correlationContext",
    ];

    return dims.map((dim) => {
      const pairs: Array<{ score: number; win: number }> = [];

      for (const row of rows) {
        const snap = row.indicatorsSnapshot as Record<string, unknown> | null;
        if (!snap) continue;
        const breakdown = snap["breakdown"] as Record<string, unknown> | undefined;
        if (!breakdown) continue;
        const score = Number(breakdown[dim]);
        if (isNaN(score)) continue;
        pairs.push({ score, win: row.outcome === "WIN" ? 1 : 0 });
      }

      if (pairs.length < 5) {
        return { dimension: dim, higherWins: true, correlation: 0, meanWin: 0, meanLoss: 0, lift: 0 };
      }

      const wins   = pairs.filter((p) => p.win === 1).map((p) => p.score);
      const losses = pairs.filter((p) => p.win === 0).map((p) => p.score);
      const meanWin  = wins.length  > 0 ? wins.reduce((a, b) => a + b, 0)  / wins.length  : 0;
      const meanLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
      const lift     = meanWin - meanLoss;

      // Pearson r between score and binary outcome
      const n    = pairs.length;
      const ms   = pairs.reduce((a, p) => a + p.score, 0) / n;
      const mo   = pairs.reduce((a, p) => a + p.win,   0) / n;
      const num  = pairs.reduce((a, p) => a + (p.score - ms) * (p.win - mo), 0);
      const denS = Math.sqrt(pairs.reduce((a, p) => a + (p.score - ms) ** 2, 0));
      const denO = Math.sqrt(pairs.reduce((a, p) => a + (p.win - mo) ** 2, 0));
      const corr = (denS > 0 && denO > 0) ? num / (denS * denO) : 0;

      return {
        dimension:   dim,
        higherWins:  lift > 0,
        correlation: Math.round(corr * 1000) / 1000,
        meanWin:     Math.round(meanWin * 10) / 10,
        meanLoss:    Math.round(meanLoss * 10) / 10,
        lift:        Math.round(lift * 10) / 10,
      };
    });
  }

  async getConfidenceAccuracyReport(): Promise<ConfidenceAccuracyReport> {
    const emptyReport = (): ConfidenceAccuracyReport => ({
      buckets: [], ece: 0, mce: 0, brierScore: 0,
      overallStatus: "well_calibrated", recommendation: "Insufficient data",
      totalSignals: 0, closedSignals: 0, computedAt: new Date().toISOString(),
    });

    if (!IS_PERSISTENT || !prisma) return emptyReport();
    const db = prisma as NonNullable<typeof prisma>;

    const rows = await db.signalTelemetry.findMany({
      where:  { outcome: { in: ["WIN", "LOSS", "BREAKEVEN"] } },
      select: { confidence: true, outcome: true, pnl: true },
    }).catch(() => [] as Array<{ confidence: number; outcome: string; pnl: unknown }>);

    if (rows.length === 0) return emptyReport();

    const total = await db.signalTelemetry.count().catch(() => 0);

    const BUCKETS: [number, number][] = [[50, 59], [60, 69], [70, 79], [80, 89], [90, 100]];
    const buckets: ConfidenceAccuracyBucket[] = [];

    for (const [lo, hi] of BUCKETS) {
      const inBucket  = rows.filter((r) => r.confidence >= lo && r.confidence <= hi);
      const wins      = inBucket.filter((r) => r.outcome === "WIN");
      const resolved  = inBucket.length;
      const targetWR  = ((lo + hi) / 2) / 100;
      const actualWR  = resolved > 0 ? wins.length / resolved : 0;
      const gap       = actualWR - targetWR;
      const error     = Math.abs(gap);
      const totalPnl  = inBucket.reduce((s, r) => s + (r.pnl ? Number(r.pnl) : 0), 0);
      const avgPnl    = resolved > 0 ? totalPnl / resolved : 0;

      let status: ConfidenceAccuracyBucket["status"];
      let recommendation: string;

      if (resolved < 10) {
        status = "insufficient_data";
        recommendation = `Collect at least 10 closed trades in the ${lo}-${hi} confidence range for reliable calibration.`;
      } else if (error < 0.05) {
        status = "well_calibrated";
        recommendation = `Confidence ${lo}-${hi} is accurately calibrated (gap: ${(gap * 100).toFixed(1)}pp). No adjustment needed.`;
      } else if (gap < 0) {
        status = "overconfident";
        recommendation = `Model is overconfident at ${lo}-${hi}: signals win ${(actualWR * 100).toFixed(1)}% but claim ${((lo + hi) / 2).toFixed(0)}%. Consider raising the entry gate by ${Math.round(error * 100)}pp or penalizing this confidence tier.`;
      } else {
        status = "underconfident";
        recommendation = `Model is underconfident at ${lo}-${hi}: signals win ${(actualWR * 100).toFixed(1)}% but only claim ${((lo + hi) / 2).toFixed(0)}%. Confidence scoring may be too conservative in this range.`;
      }

      buckets.push({
        bucket: `${lo}-${hi}`, lo, hi,
        count: resolved, actualWinRate: Math.round(actualWR * 1000) / 1000,
        targetWinRate: targetWR, calibrationGap: Math.round(gap * 1000) / 1000,
        calibrationError: Math.round(error * 1000) / 1000,
        status, recommendation, avgPnl: Math.round(avgPnl * 100) / 100, totalPnl: Math.round(totalPnl * 100) / 100,
      });
    }

    // Aggregate ECE, MCE, Brier
    const pairs = rows.map((r) => ({ conf: r.confidence, win: r.outcome === "WIN" ? 1 : 0 }));
    const ece   = buckets.reduce((acc, b) => acc + (b.count / rows.length) * b.calibrationError, 0);
    const mce   = Math.max(0, ...buckets.filter((b) => b.count >= 10).map((b) => b.calibrationError));
    const brier = this._brierScore(pairs);

    const overconfidentBuckets   = buckets.filter((b) => b.status === "overconfident");
    const underconfidentBuckets  = buckets.filter((b) => b.status === "underconfident");
    let overallStatus: ConfidenceAccuracyReport["overallStatus"] = "well_calibrated";
    let recommendation: string;

    if (overconfidentBuckets.length > underconfidentBuckets.length) {
      overallStatus = "overconfident";
      recommendation = `OLOS is systematically overconfident. ECE=${(ece * 100).toFixed(2)}%. Focus on confidence bands: ${overconfidentBuckets.map((b) => b.bucket).join(", ")}. Run SelfOptimizer to recalibrate weights.`;
    } else if (underconfidentBuckets.length > overconfidentBuckets.length) {
      overallStatus = "underconfident";
      recommendation = `OLOS is systematically underconfident. ECE=${(ece * 100).toFixed(2)}%. Signals in bands ${underconfidentBuckets.map((b) => b.bucket).join(", ")} are better than stated confidence.`;
    } else {
      recommendation = `OLOS confidence is well calibrated overall. ECE=${(ece * 100).toFixed(2)}%, Brier=${brier.toFixed(4)}. Continue monitoring.`;
    }

    return {
      buckets, ece: Math.round(ece * 10000) / 10000, mce: Math.round(mce * 10000) / 10000,
      brierScore: brier, overallStatus, recommendation,
      totalSignals: total, closedSignals: rows.length,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Empirical-frequency probability forecast for a candidate signal — "given
   * signals at this confidence level and regime historically, what share
   * actually reached target1/target2 (by max favorable excursion), and what
   * share were stopped out?" Deterministic lookup over closed SignalTelemetry
   * rows — no ML, consistent with the rest of this service's hand-rolled math.
   *
   * Falls back from (regime, confidence band) → (confidence band only) →
   * an uninformed prior derived from the stated confidence itself, each
   * explicitly marked via `basis`/`status` so callers never mistake a thin
   * sample for a real measurement.
   */
  async predictProbabilities(
    confidence: number,
    regime: string,
    breakdown: Partial<Record<string, number>> = {},
  ): Promise<ProbabilisticForecast> {
    const dimensionSignal = await this._dimensionSignal(breakdown);

    const uninformedPrior = (basis: ProbabilisticForecast["basis"]): ProbabilisticForecast => ({
      confidence, regime,
      // TP1/TP2 require reaching a specific price distance, not just a net-positive
      // close — strictly less likely than the raw stated win-confidence, hence the discount.
      pTp1:     Math.round((confidence / 100) * 0.70 * 1000) / 1000,
      pTp2:     Math.round((confidence / 100) * 0.40 * 1000) / 1000,
      pFailure: Math.round((1 - confidence / 100) * 1000) / 1000,
      sampleSize: 0,
      basis,
      dimensionSignal,
      status: "insufficient_data",
    });

    if (!IS_PERSISTENT || !prisma) return uninformedPrior("uninformed_prior");
    const db = prisma as NonNullable<typeof prisma>;

    const [lo, hi] = PROB_CONFIDENCE_BUCKETS.find(([l, h]) => confidence >= l && confidence <= h)
      ?? [Math.max(0, confidence - 5), confidence + 5];

    const select = { entryPrice: true, target1: true, target2: true, outcome: true, maxFavorableExcursion: true };

    const regimeRows: ProbRow[] = await db.signalTelemetry.findMany({
      where:  { outcome: { in: ["WIN", "LOSS", "BREAKEVEN"] }, marketRegime: regime, confidence: { gte: lo, lte: hi } },
      select,
    }).catch(() => []);

    let computed = this._computeProbRow(regimeRows);
    let basis: ProbabilisticForecast["basis"] = "regime_confidence_band";

    if (!computed || computed.n < PROB_MIN_SAMPLE) {
      const bandRows: ProbRow[] = await db.signalTelemetry.findMany({
        where:  { outcome: { in: ["WIN", "LOSS", "BREAKEVEN"] }, confidence: { gte: lo, lte: hi } },
        select,
      }).catch(() => []);
      const bandComputed = this._computeProbRow(bandRows);
      if (bandComputed && bandComputed.n >= PROB_MIN_SAMPLE) {
        computed = bandComputed;
        basis = "confidence_band_only";
      }
    }

    if (!computed) return uninformedPrior("uninformed_prior");

    return {
      confidence, regime,
      pTp1:       Math.round(computed.pTp1 * 1000) / 1000,
      pTp2:       Math.round(computed.pTp2 * 1000) / 1000,
      pFailure:   Math.round(computed.pFailure * 1000) / 1000,
      sampleSize: computed.n,
      basis,
      dimensionSignal,
      status: computed.n >= PROB_MIN_SAMPLE ? "calibrated" : "insufficient_data",
    };
  }

  private _computeProbRow(rows: ProbRow[]): { pTp1: number; pTp2: number; pFailure: number; n: number } | null {
    const n = rows.length;
    if (n === 0) return null;

    let tp1 = 0, tp2 = 0, fail = 0;
    for (const r of rows) {
      const entry = Number(r.entryPrice);
      const t1Dist = Math.abs(Number(r.target1) - entry);
      const t2Dist = Math.abs(Number(r.target2) - entry);
      const mfe = r.maxFavorableExcursion !== null && r.maxFavorableExcursion !== undefined
        ? Number(r.maxFavorableExcursion) : 0;

      if (mfe >= t1Dist) tp1++;
      if (mfe >= t2Dist) tp2++;
      if (r.outcome === "LOSS") fail++;
    }

    return { pTp1: tp1 / n, pTp2: tp2 / n, pFailure: fail / n, n };
  }

  /**
   * Weighted historical lift (-1..+1) of the sub-scores supplied in `breakdown`,
   * using getMetrics()'s dimensionAccuracy — reused rather than recomputed.
   * Returns 0 (no signal) when breakdown is empty or no dimension has data yet.
   */
  private async _dimensionSignal(breakdown: Partial<Record<string, number>>): Promise<number> {
    const keys = Object.keys(breakdown);
    if (keys.length === 0) return 0;

    const metrics = await this.getMetrics();
    let weightedSum = 0, weightTotal = 0;

    for (const dimAcc of metrics.dimensionAccuracy) {
      const score = breakdown[dimAcc.dimension];
      if (score === undefined || isNaN(score) || dimAcc.lift === 0) continue;
      const normalizedScore = (score - 50) / 50; // -1..+1
      weightedSum += normalizedScore * dimAcc.lift;
      weightTotal += Math.abs(dimAcc.lift);
    }

    if (weightTotal === 0) return 0;
    return Math.round((weightedSum / weightTotal) * 1000) / 1000;
  }

  private _empty(): CalibrationMetrics {
    return {
      totalSignals: 0, closedSignals: 0, ece: 0, mce: 0,
      brierScore: 0, sharpness: 0, resolution: 0,
      overallBias: "calibrated", bands: [], dimensionAccuracy: [],
      computedAt: new Date().toISOString(),
    };
  }

  // ── Phase 7: Bayesian update ─────────────────────────────────────────────────

  /**
   * Pure Beta-Binomial conjugate update — no DB access, fully deterministic.
   * `priorMean`/`priorStrength` describe a Beta(alpha, beta) prior where
   * alpha = priorMean*priorStrength and beta = (1-priorMean)*priorStrength;
   * the posterior is Beta(alpha+observedWins, beta+observedLosses).
   */
  bayesianUpdate(priorMean: number, priorStrength: number, observedWins: number, observedLosses: number): BayesianPosterior {
    const alpha = priorMean * priorStrength;
    const beta  = (1 - priorMean) * priorStrength;

    const posteriorAlpha = alpha + observedWins;
    const posteriorBeta  = beta + observedLosses;
    const posteriorTotal = posteriorAlpha + posteriorBeta;
    const posteriorMean  = posteriorTotal > 0 ? posteriorAlpha / posteriorTotal : 0;

    // Beta distribution variance: alpha*beta / ((alpha+beta)^2 * (alpha+beta+1)).
    const variance = posteriorTotal > 0
      ? (posteriorAlpha * posteriorBeta) / (posteriorTotal ** 2 * (posteriorTotal + 1))
      : 0;
    const sd = Math.sqrt(variance);
    const lo = Math.max(0, posteriorMean - CREDIBLE_INTERVAL_Z * sd);
    const hi = Math.min(1, posteriorMean + CREDIBLE_INTERVAL_Z * sd);

    return {
      priorMean, priorStrength, observedWins, observedLosses,
      posteriorAlpha: Math.round(posteriorAlpha * 1000) / 1000,
      posteriorBeta:  Math.round(posteriorBeta * 1000) / 1000,
      posteriorMean:  Math.round(posteriorMean * 1000) / 1000,
      credibleInterval95: [Math.round(lo * 1000) / 1000, Math.round(hi * 1000) / 1000],
    };
  }

  /**
   * Seeds the Beta-Binomial prior from predictProbabilities()'s existing
   * empirical (regime, confidence-band) win rate — reused, not recomputed —
   * then folds in newly observed outcomes (e.g. trades closed since that
   * historical sample was taken) via bayesianUpdate().
   */
  async bayesianWinProbability(confidence: number, regime: string, observedWins: number, observedLosses: number): Promise<BayesianPosterior> {
    const base = await this.predictProbabilities(confidence, regime);
    const priorMean = 1 - base.pFailure;
    const priorStrength = Math.max(base.sampleSize, 1); // a zero-sample prior is uninformative, not zero-strength
    return this.bayesianUpdate(priorMean, priorStrength, observedWins, observedLosses);
  }

  // ── Phase 7: scenario-conditioned forecast ───────────────────────────────────

  /**
   * For each of VarEngine's already-named stress scenarios, applies a simple
   * linear severity haircut to a base ProbabilisticForecast — "if this
   * scenario hit during the signal's life, how would the odds shift?" An
   * explicitly labeled heuristic discount, not a new probability model.
   */
  scenarioConditionedForecasts(base: ProbabilisticForecast, stressScenarios: StressScenario[]): ScenarioConditionedForecast[] {
    return stressScenarios.map((scenario) => {
      const haircut = STRESS_SEVERITY_HAIRCUT[scenario.severity];
      const stressedPFailure = Math.min(1, base.pFailure + (1 - base.pFailure) * haircut);
      const stressedPTp1 = Math.max(0, base.pTp1 * (1 - haircut));
      const stressedPTp2 = Math.max(0, base.pTp2 * (1 - haircut));

      return {
        scenario: scenario.name,
        severity: scenario.severity,
        basePFailure: base.pFailure,
        stressedPFailure: Math.round(stressedPFailure * 1000) / 1000,
        basePTp1: base.pTp1,
        stressedPTp1: Math.round(stressedPTp1 * 1000) / 1000,
        basePTp2: base.pTp2,
        stressedPTp2: Math.round(stressedPTp2 * 1000) / 1000,
      };
    });
  }

  // ── Phase 7: Monte-Carlo-readiness accessor (no simulator built) ────────────

  /**
   * Exposes the empirical closed-trade PnL distribution in a flat,
   * resampling-ready array — infrastructure for a future Monte Carlo
   * simulator, not a simulator itself. No new methodology: the same
   * `pnl` field already read by getConfidenceAccuracyReport().
   */
  async historicalReturnSeries(filters: { regime?: string; minConfidence?: number } = {}): Promise<number[]> {
    if (!IS_PERSISTENT || !prisma) return [];
    const db = prisma as NonNullable<typeof prisma>;

    const where: Record<string, unknown> = { outcome: { in: ["WIN", "LOSS", "BREAKEVEN"] } };
    if (filters.regime !== undefined) where.marketRegime = filters.regime;
    if (filters.minConfidence !== undefined) where.confidence = { gte: filters.minConfidence };

    const rows = await db.signalTelemetry.findMany({ where, select: { pnl: true } }).catch(() => [] as Array<{ pnl: unknown }>);
    return rows.map((r) => Number(r.pnl ?? 0));
  }
}

export const calibrationService = new CalibrationService();
