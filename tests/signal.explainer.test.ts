/**
 * signal.explainer.test.ts
 *
 * Unit tests for SignalExplainer — a read-only assembly layer with no new
 * scoring math. Verifies: dimension ranking/contribution arithmetic, historical
 * weight reconstruction (vs. default fallback), graceful handling of missing
 * OlosSignal/probability data, and narrative assembly.
 *
 * Isolation: prisma is mocked (mirrors tests/pending.order.book.spec.ts);
 * CalibrationService.predictProbabilities is mocked too, since its own
 * behavior is already covered by tests/calibration.service.test.ts — here we
 * only verify the explainer correctly consumes whatever it returns.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockTelemetryFindUnique, mockOlosFindUnique, mockWeightsFindUnique, mockPredictProbabilities } = vi.hoisted(() => ({
  mockTelemetryFindUnique: vi.fn().mockResolvedValue(null),
  mockOlosFindUnique:      vi.fn().mockResolvedValue(null),
  mockWeightsFindUnique:   vi.fn().mockResolvedValue(null),
  mockPredictProbabilities: vi.fn().mockResolvedValue(null),
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    signalTelemetry:  { findUnique: mockTelemetryFindUnique },
    olosSignal:       { findUnique: mockOlosFindUnique },
    confidenceWeights: { findUnique: mockWeightsFindUnique },
  },
}));

vi.mock("../signals-engine/calibration.service.js", () => ({
  calibrationService: { predictProbabilities: mockPredictProbabilities },
}));

import { signalExplainer } from "../signals-engine/signal.explainer.js";
import { DEFAULT_CONFIDENCE_WEIGHTS } from "../ai-core/confidence.engine.js";

beforeEach(() => {
  mockTelemetryFindUnique.mockReset().mockResolvedValue(null);
  mockOlosFindUnique.mockReset().mockResolvedValue(null);
  mockWeightsFindUnique.mockReset().mockResolvedValue(null);
  mockPredictProbabilities.mockReset().mockResolvedValue(null);
});

const FULL_BREAKDOWN = {
  trendAlignment: 100, momentumStrength: 50, volatilityContext: 50,
  volumeConfirmation: 50, macroAlignment: 50, sessionTiming: 50,
  structureAlignment: 0, multiTimeframeAlignment: 50, correlationContext: 100,
};

function telemetryRow(overrides: Partial<{ indicatorsSnapshot: Record<string, unknown> }> = {}) {
  return {
    signalId: "sig-1", symbol: "XAUUSD", signalType: "BUY", confidence: 82,
    marketRegime: "RANGING", volatilityLevel: "MEDIUM",
    confluenceFactors: ["RSI_OVERSOLD_28.0"],
    indicatorsSnapshot: { breakdown: FULL_BREAKDOWN, weightsVersion: 0 },
    generatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("SignalExplainer.explainSignal — not found", () => {
  it("returns null when no telemetry row exists for the signalId", async () => {
    mockTelemetryFindUnique.mockResolvedValueOnce(null);
    const result = await signalExplainer.explainSignal("missing-id");
    expect(result).toBeNull();
  });
});

describe("SignalExplainer.explainSignal — dimension ranking with default weights", () => {
  it("ranks dimensions by contribution and picks correct top drivers/detractors", async () => {
    mockTelemetryFindUnique.mockResolvedValueOnce(telemetryRow());
    mockOlosFindUnique.mockResolvedValueOnce({ entryRationale: "entry text", slRationale: "sl text" });

    const result = await signalExplainer.explainSignal("sig-1");

    expect(result).not.toBeNull();
    expect(result!.dimensions[0]!.dimension).toBe("trendAlignment");
    expect(result!.dimensions[0]!.contribution).toBe(18);
    expect(result!.topDrivers).toEqual(["trendAlignment", "correlationContext", "momentumStrength"]);
    expect(result!.topDetractors).toEqual(["structureAlignment", "sessionTiming", "multiTimeframeAlignment"]);
    expect(result!.entryRationale).toBe("entry text");
    expect(result!.slRationale).toBe("sl text");
  });

  it("uses the current DEFAULT_CONFIDENCE_WEIGHTS when weightsVersion is 0", async () => {
    mockTelemetryFindUnique.mockResolvedValueOnce(telemetryRow());

    const result = await signalExplainer.explainSignal("sig-1");

    const byDim = new Map(result!.dimensions.map((d) => [d.dimension, d.weight]));
    for (const [dim, w] of Object.entries(DEFAULT_CONFIDENCE_WEIGHTS)) {
      expect(byDim.get(dim)).toBe(w);
    }
    expect(mockWeightsFindUnique).not.toHaveBeenCalled();
  });
});

describe("SignalExplainer.explainSignal — historical weight reconstruction", () => {
  it("uses the versioned ConfidenceWeights row when weightsVersion > 0", async () => {
    const customWeights = { ...DEFAULT_CONFIDENCE_WEIGHTS, trendAlignment: 40, momentumStrength: 0 };
    mockTelemetryFindUnique.mockResolvedValueOnce(
      telemetryRow({ indicatorsSnapshot: { breakdown: FULL_BREAKDOWN, weightsVersion: 3 } }),
    );
    mockWeightsFindUnique.mockResolvedValueOnce({ version: 3, weights: customWeights });

    const result = await signalExplainer.explainSignal("sig-1");

    expect(mockWeightsFindUnique).toHaveBeenCalledWith({ where: { version: 3 } });
    const trend = result!.dimensions.find((d) => d.dimension === "trendAlignment")!;
    expect(trend.weight).toBe(40);
  });

  it("falls back to default weights when the versioned row is missing", async () => {
    mockTelemetryFindUnique.mockResolvedValueOnce(
      telemetryRow({ indicatorsSnapshot: { breakdown: FULL_BREAKDOWN, weightsVersion: 99 } }),
    );
    mockWeightsFindUnique.mockResolvedValueOnce(null);

    const result = await signalExplainer.explainSignal("sig-1");

    const trend = result!.dimensions.find((d) => d.dimension === "trendAlignment")!;
    expect(trend.weight).toBe(DEFAULT_CONFIDENCE_WEIGHTS.trendAlignment);
  });
});

describe("SignalExplainer.explainSignal — graceful degradation", () => {
  it("returns null entryRationale/slRationale when no matching OlosSignal row exists", async () => {
    mockTelemetryFindUnique.mockResolvedValueOnce(telemetryRow());
    mockOlosFindUnique.mockResolvedValueOnce(null);

    const result = await signalExplainer.explainSignal("sig-1");

    expect(result!.entryRationale).toBeNull();
    expect(result!.slRationale).toBeNull();
  });

  it("defaults structureEvents/multiTimeframe/correlation when absent from the snapshot", async () => {
    mockTelemetryFindUnique.mockResolvedValueOnce(
      telemetryRow({ indicatorsSnapshot: { breakdown: FULL_BREAKDOWN, weightsVersion: 0 } }),
    );

    const result = await signalExplainer.explainSignal("sig-1");

    expect(result!.structurePhase).toBeNull();
    expect(result!.structureEvents).toEqual([]);
    expect(result!.multiTimeframe).toBeNull();
    expect(result!.correlation).toBeNull();
  });

  it("returns a null probability without throwing when predictProbabilities rejects", async () => {
    mockTelemetryFindUnique.mockResolvedValueOnce(telemetryRow());
    mockPredictProbabilities.mockRejectedValueOnce(new Error("boom"));

    const result = await signalExplainer.explainSignal("sig-1");

    expect(result!.probability).toBeNull();
  });
});

describe("SignalExplainer.explainSignal — narrative assembly", () => {
  it("weaves symbol, side, confidence, drivers, structure phase and probability into one narrative", async () => {
    mockTelemetryFindUnique.mockResolvedValueOnce(
      telemetryRow({ indicatorsSnapshot: { breakdown: FULL_BREAKDOWN, weightsVersion: 0, structurePhase: "TRENDING_UP" } }),
    );
    mockPredictProbabilities.mockResolvedValueOnce({
      confidence: 82, regime: "RANGING", pTp1: 0.7, pTp2: 0.4, pFailure: 0.2,
      sampleSize: 50, basis: "regime_confidence_band", dimensionSignal: 0, status: "calibrated",
    });

    const result = await signalExplainer.explainSignal("sig-1");

    expect(result!.narrative).toContain("XAUUSD");
    expect(result!.narrative).toContain("BUY");
    expect(result!.narrative).toContain("82%");
    expect(result!.narrative).toContain("trendAlignment");
    expect(result!.narrative).toContain("TRENDING_UP");
    expect(result!.narrative).toContain("70%");
    expect(result!.narrative).toContain("40%");
    expect(result!.narrative).toContain("20%");
  });
});
