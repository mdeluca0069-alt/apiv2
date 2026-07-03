/**
 * calibration.service.test.ts
 *
 * Unit tests for the Phase 5 additions to CalibrationService:
 *   - _dimensionAccuracy() extended to the 3 sub-scores added in Phases 1/2/4
 *     (structureAlignment, multiTimeframeAlignment, correlationContext).
 *   - predictProbabilities() — deterministic empirical-frequency lookup of
 *     pTp1/pTp2/pFailure, with its (regime+confidence) → (confidence-band-only)
 *     → (uninformed prior) fallback chain.
 *
 * Plus (Task 13, Phase 7) the Probabilistic Engine extension:
 *   - bayesianUpdate() / bayesianWinProbability() — Beta-Binomial conjugate
 *     update, prior seeded from predictProbabilities()'s existing empirical
 *     win rate.
 *   - scenarioConditionedForecasts() — linear severity haircut applied to a
 *     base forecast, reusing VarEngine's StressScenario shape/vocabulary.
 *   - historicalReturnSeries() — Monte-Carlo-readiness accessor (no simulator).
 *
 * Isolation strategy (mirrors tests/pending.order.book.spec.ts):
 *   - IS_PERSISTENT = true so the DB-backed code paths execute (prisma mocked)
 *   - prisma.signalTelemetry.findMany / count are vi.fn() — fully controllable
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { StressScenario } from "../risk-service/var.engine.js";
import type { ProbabilisticForecast } from "../signals-engine/calibration.service.js";

const { mockFindMany, mockCount } = vi.hoisted(() => ({
  mockFindMany: vi.fn().mockResolvedValue([]),
  mockCount:    vi.fn().mockResolvedValue(0),
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    signalTelemetry: {
      findMany: mockFindMany,
      count:    mockCount,
    },
  },
}));

import { calibrationService } from "../signals-engine/calibration.service.js";

beforeEach(() => {
  mockFindMany.mockReset();
  mockCount.mockReset().mockResolvedValue(0);
});

// ── Fixture helpers ───────────────────────────────────────────────────────────

function probRow(opts: { entryPrice: number; target1: number; target2: number; outcome: string; mfe: number }) {
  return {
    entryPrice: opts.entryPrice,
    target1:    opts.target1,
    target2:    opts.target2,
    outcome:    opts.outcome,
    maxFavorableExcursion: opts.mfe,
  };
}

function telemetryRow(outcome: "WIN" | "LOSS", breakdown: Record<string, number>) {
  return { confidence: 75, outcome, indicatorsSnapshot: { breakdown } };
}

// ── _dimensionAccuracy — extended dimension list ──────────────────────────────

describe("CalibrationService.getMetrics — extended dimensionAccuracy list", () => {
  it("includes structureAlignment, multiTimeframeAlignment and correlationContext with correct lift sign", async () => {
    const rows = [
      ...Array.from({ length: 3 }, () => telemetryRow("WIN", { correlationContext: 80, structureAlignment: 85, multiTimeframeAlignment: 90 })),
      ...Array.from({ length: 3 }, () => telemetryRow("LOSS", { correlationContext: 20, structureAlignment: 15, multiTimeframeAlignment: 10 })),
    ];
    mockFindMany.mockResolvedValueOnce(rows);
    mockCount.mockResolvedValueOnce(6);

    const metrics = await calibrationService.getMetrics();
    const byDim = new Map(metrics.dimensionAccuracy.map((d) => [d.dimension, d]));

    expect(byDim.has("structureAlignment")).toBe(true);
    expect(byDim.has("multiTimeframeAlignment")).toBe(true);
    expect(byDim.has("correlationContext")).toBe(true);

    const corr = byDim.get("correlationContext")!;
    expect(corr.higherWins).toBe(true);
    expect(corr.lift).toBeCloseTo(60, 0); // meanWin 80 - meanLoss 20
  });
});

// ── predictProbabilities — fallback chain ─────────────────────────────────────

describe("CalibrationService.predictProbabilities — sufficient regime+confidence sample", () => {
  it("computes pTp1/pTp2/pFailure from the regime-specific bucket when sample size is sufficient", async () => {
    // entry=100, target1 dist=3, target2 dist=5.
    const rows = [
      ...Array.from({ length: 6 }, () => probRow({ entryPrice: 100, target1: 103, target2: 105, outcome: "WIN", mfe: 6 })),  // hits both
      ...Array.from({ length: 2 }, () => probRow({ entryPrice: 100, target1: 103, target2: 105, outcome: "WIN", mfe: 4 })),  // hits TP1 only
      ...Array.from({ length: 2 }, () => probRow({ entryPrice: 100, target1: 103, target2: 105, outcome: "LOSS", mfe: 1 })), // hits neither
    ];
    mockFindMany.mockResolvedValueOnce(rows);

    const result = await calibrationService.predictProbabilities(75, "RANGING", {});

    expect(result.basis).toBe("regime_confidence_band");
    expect(result.status).toBe("calibrated");
    expect(result.sampleSize).toBe(10);
    expect(result.pTp1).toBe(0.8);
    expect(result.pTp2).toBe(0.6);
    expect(result.pFailure).toBe(0.2);
    expect(mockFindMany).toHaveBeenCalledTimes(1); // never needed the fallback query
  });
});

describe("CalibrationService.predictProbabilities — falls back to the confidence band when the regime sample is thin", () => {
  it("uses the confidence-band-only bucket's numbers once it clears the sample-size floor", async () => {
    const thinRegimeSample = Array.from({ length: 3 }, () =>
      probRow({ entryPrice: 100, target1: 103, target2: 105, outcome: "LOSS", mfe: 0 }),
    );
    const sufficientBandSample = Array.from({ length: 12 }, () =>
      probRow({ entryPrice: 100, target1: 102, target2: 104, outcome: "WIN", mfe: 10 }), // hits both, every row
    );
    mockFindMany
      .mockResolvedValueOnce(thinRegimeSample)
      .mockResolvedValueOnce(sufficientBandSample);

    const result = await calibrationService.predictProbabilities(75, "RANGING", {});

    expect(result.basis).toBe("confidence_band_only");
    expect(result.status).toBe("calibrated");
    expect(result.sampleSize).toBe(12);
    expect(result.pTp1).toBe(1);
    expect(result.pTp2).toBe(1);
    expect(result.pFailure).toBe(0);
    expect(mockFindMany).toHaveBeenCalledTimes(2);
  });
});

describe("CalibrationService.predictProbabilities — thin-but-real regime sample wins over a context-free prior", () => {
  it("returns the regime bucket's actual (thin) numbers, marked insufficient_data, rather than discarding them", async () => {
    const thinRegimeSample = Array.from({ length: 3 }, () =>
      probRow({ entryPrice: 100, target1: 103, target2: 105, outcome: "WIN", mfe: 6 }),
    );
    const alsoThinBandSample = Array.from({ length: 2 }, () =>
      probRow({ entryPrice: 100, target1: 103, target2: 105, outcome: "LOSS", mfe: 0 }),
    );
    mockFindMany
      .mockResolvedValueOnce(thinRegimeSample)
      .mockResolvedValueOnce(alsoThinBandSample);

    const result = await calibrationService.predictProbabilities(75, "RANGING", {});

    expect(result.basis).toBe("regime_confidence_band");
    expect(result.status).toBe("insufficient_data");
    expect(result.sampleSize).toBe(3);
    expect(result.pTp1).toBe(1); // all 3 thin-sample rows hit both targets
  });
});

describe("CalibrationService.predictProbabilities — uninformed prior", () => {
  it("falls back to the stated-confidence-derived prior when both buckets are completely empty", async () => {
    mockFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await calibrationService.predictProbabilities(80, "RANGING", {});

    expect(result.basis).toBe("uninformed_prior");
    expect(result.status).toBe("insufficient_data");
    expect(result.sampleSize).toBe(0);
    expect(result.pTp1).toBe(0.56);   // round(0.80 * 0.70, 3)
    expect(result.pTp2).toBe(0.32);   // round(0.80 * 0.40, 3)
    expect(result.pFailure).toBe(0.2); // round(1 - 0.80, 3)
  });
});

// ── predictProbabilities — dimensionSignal ────────────────────────────────────

describe("CalibrationService.predictProbabilities — dimensionSignal", () => {
  it("returns 0 and makes no extra DB calls when no breakdown is supplied", async () => {
    mockFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await calibrationService.predictProbabilities(80, "RANGING", {});

    expect(result.dimensionSignal).toBe(0);
    expect(mockFindMany).toHaveBeenCalledTimes(2); // only the two probability-bucket queries, no getMetrics() call
  });

  it("derives a positive dimensionSignal when the supplied score sits on the historically-winning side", async () => {
    const dimRows = [
      ...Array.from({ length: 3 }, () => telemetryRow("WIN", { structureAlignment: 80 })),
      ...Array.from({ length: 3 }, () => telemetryRow("LOSS", { structureAlignment: 20 })),
    ];
    // Call order: predictProbabilities computes dimensionSignal FIRST (getMetrics —
    // findMany + count), then the regime bucket, then (if needed) the band bucket.
    mockFindMany
      .mockResolvedValueOnce(dimRows)  // getMetrics()'s closed-signal query
      .mockResolvedValueOnce([])       // regime bucket — empty
      .mockResolvedValueOnce([]);      // confidence-band bucket — empty
    mockCount.mockResolvedValueOnce(6);

    const result = await calibrationService.predictProbabilities(75, "RANGING", { structureAlignment: 90 });

    // meanWin=80, meanLoss=20 → lift=60; normalizedScore=(90-50)/50=0.8 → 0.8*60/60 = 0.8
    expect(result.dimensionSignal).toBe(0.8);
  });
});

// ── Phase 7: bayesianUpdate / bayesianWinProbability ──────────────────────────

function stressScenario(name: string, severity: StressScenario["severity"]): StressScenario {
  return { name, description: "", shockPct: -10, estimatedLoss: 0, marginImpact: 0, severity };
}

function forecast(overrides: Partial<ProbabilisticForecast> = {}): ProbabilisticForecast {
  return {
    confidence: 75, regime: "RANGING",
    pTp1: 0.6, pTp2: 0.3, pFailure: 0.2,
    sampleSize: 20, basis: "regime_confidence_band", dimensionSignal: 0, status: "calibrated",
    ...overrides,
  };
}

describe("CalibrationService.bayesianUpdate — pure Beta-Binomial conjugate update", () => {
  it("computes the exact textbook posterior: alpha=priorMean*strength+wins, beta=(1-priorMean)*strength+losses", () => {
    const posterior = calibrationService.bayesianUpdate(0.6, 20, 8, 2);
    expect(posterior.posteriorAlpha).toBeCloseTo(20, 3); // 0.6*20 + 8
    expect(posterior.posteriorBeta).toBeCloseTo(10, 3);  // 0.4*20 + 2
    expect(posterior.posteriorMean).toBeCloseTo(20 / 30, 3);
  });

  it("matches a hand-computed normal-approximation 95% credible interval", () => {
    const posterior = calibrationService.bayesianUpdate(0.6, 20, 8, 2);
    const total = 30;
    const variance = (20 * 10) / (total ** 2 * (total + 1));
    const sd = Math.sqrt(variance);
    const expectedLo = posterior.posteriorMean - 1.96 * sd;
    const expectedHi = posterior.posteriorMean + 1.96 * sd;
    expect(posterior.credibleInterval95[0]).toBeCloseTo(expectedLo, 2);
    expect(posterior.credibleInterval95[1]).toBeCloseTo(expectedHi, 2);
  });

  it("treats a zero-strength prior as fully uninformative — posterior is exactly the raw observed rate", () => {
    const posterior = calibrationService.bayesianUpdate(0.5, 0, 7, 3);
    expect(posterior.posteriorAlpha).toBeCloseTo(7, 3);
    expect(posterior.posteriorBeta).toBeCloseTo(3, 3);
    expect(posterior.posteriorMean).toBeCloseTo(0.7, 3);
  });

  it("is monotonic in observed wins, all else equal", () => {
    const fewerWins = calibrationService.bayesianUpdate(0.5, 10, 2, 8);
    const moreWins  = calibrationService.bayesianUpdate(0.5, 10, 8, 2);
    expect(moreWins.posteriorMean).toBeGreaterThan(fewerWins.posteriorMean);
  });

  it("keeps credibleInterval95 within [0, 1] even with a tiny posterior sample", () => {
    const posterior = calibrationService.bayesianUpdate(0.9, 1, 0, 0);
    expect(posterior.credibleInterval95[0]).toBeGreaterThanOrEqual(0);
    expect(posterior.credibleInterval95[1]).toBeLessThanOrEqual(1);
  });
});

describe("CalibrationService.bayesianWinProbability — seeds its prior from predictProbabilities()", () => {
  it("folds newly observed outcomes into the empirical regime/confidence-band prior, matching bayesianUpdate's own formula", async () => {
    mockFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]); // uninformed prior path

    const posterior = await calibrationService.bayesianWinProbability(80, "RANGING", 5, 1);

    // uninformed prior: pFailure = 1 - 0.80 = 0.2 -> priorMean = 0.8; sampleSize=0 -> priorStrength=max(0,1)=1
    const expected = calibrationService.bayesianUpdate(0.8, 1, 5, 1);
    expect(posterior).toEqual(expected);
  });
});

// ── Phase 7: scenarioConditionedForecasts ─────────────────────────────────────

describe("CalibrationService.scenarioConditionedForecasts — reuses VarEngine's StressScenario vocabulary", () => {
  it("passes scenario name/severity straight through (no new taxonomy invented)", () => {
    const base = forecast();
    const results = calibrationService.scenarioConditionedForecasts(base, [stressScenario("FX Flash Crash", "moderate")]);
    expect(results[0]!.scenario).toBe("FX Flash Crash");
    expect(results[0]!.severity).toBe("moderate");
  });

  it("applies a larger haircut for more severe scenarios — failure probability rises and TP odds fall with severity", () => {
    const base = forecast();
    const [mild, extreme] = calibrationService.scenarioConditionedForecasts(base, [
      stressScenario("Gold Spike", "mild"),
      stressScenario("Crypto Crash", "extreme"),
    ]);

    expect(extreme!.stressedPFailure).toBeGreaterThan(mild!.stressedPFailure);
    expect(extreme!.stressedPTp1).toBeLessThan(mild!.stressedPTp1);
    expect(extreme!.stressedPTp2).toBeLessThan(mild!.stressedPTp2);
  });

  it("keeps every stressed probability within [0, 1] regardless of severity", () => {
    const base = forecast({ pFailure: 0.9, pTp1: 0.95, pTp2: 0.9 });
    const results = calibrationService.scenarioConditionedForecasts(base, [stressScenario("Equity Black Monday", "extreme")]);
    for (const r of results) {
      expect(r.stressedPFailure).toBeGreaterThanOrEqual(0);
      expect(r.stressedPFailure).toBeLessThanOrEqual(1);
      expect(r.stressedPTp1).toBeGreaterThanOrEqual(0);
      expect(r.stressedPTp2).toBeGreaterThanOrEqual(0);
    }
  });

  it("leaves the base forecast's own fields untouched on the output rows", () => {
    const base = forecast({ pFailure: 0.2, pTp1: 0.6, pTp2: 0.3 });
    const [result] = calibrationService.scenarioConditionedForecasts(base, [stressScenario("Oil Supply Shock", "moderate")]);
    expect(result!.basePFailure).toBe(0.2);
    expect(result!.basePTp1).toBe(0.6);
    expect(result!.basePTp2).toBe(0.3);
  });
});

// ── Phase 7: historicalReturnSeries ────────────────────────────────────────────

describe("CalibrationService.historicalReturnSeries — Monte-Carlo-readiness accessor", () => {
  it("returns the closed-trade pnl values as a flat array, reusing the existing pnl field", async () => {
    mockFindMany.mockResolvedValueOnce([{ pnl: 50 }, { pnl: -20 }, { pnl: 0 }]);
    const series = await calibrationService.historicalReturnSeries();
    expect(series).toEqual([50, -20, 0]);
  });

  it("passes regime and minConfidence filters through to the where clause", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await calibrationService.historicalReturnSeries({ regime: "EXPANSION", minConfidence: 80 });

    const where = mockFindMany.mock.calls[0]![0].where;
    expect(where.marketRegime).toBe("EXPANSION");
    expect(where.confidence).toEqual({ gte: 80 });
  });

  it("returns an empty array when there are no closed trades", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    const series = await calibrationService.historicalReturnSeries();
    expect(series).toEqual([]);
  });
});
