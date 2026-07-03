/**
 * self.optimizer.test.ts
 *
 * Task 13, Phase 8: confirms SelfOptimizerService.run()'s regime-gate
 * computation actually picks up the new PANIC/ACCUMULATION defaults added to
 * DEFAULT_REGIME_GATES (adaptive.weights.ts), instead of falling through to
 * the generic `?? 60` used for any regime with no explicit default. This is
 * the first test file for self.optimizer.ts — scoped tightly to the Phase 8
 * change itself, not a full backfill of pre-existing coverage.
 *
 * Isolation strategy: IS_PERSISTENT = true, every prisma model this run()
 * touches mocked. adaptiveWeights.invalidate() in beforeEach clears its
 * module-level cache so each test starts from a fresh DB read.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockSignalTelemetryFindMany,
  mockConfidenceWeightsFindFirst,
  mockConfidenceWeightsFindUnique,
  mockConfidenceWeightsCreate,
  mockOptimizationLogCreate,
} = vi.hoisted(() => ({
  mockSignalTelemetryFindMany:    vi.fn().mockResolvedValue([]),
  mockConfidenceWeightsFindFirst: vi.fn().mockResolvedValue(null),
  mockConfidenceWeightsFindUnique: vi.fn().mockResolvedValue(null),
  mockConfidenceWeightsCreate:    vi.fn().mockResolvedValue({}),
  mockOptimizationLogCreate:      vi.fn().mockResolvedValue({}),
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    signalTelemetry: { findMany: mockSignalTelemetryFindMany },
    confidenceWeights: {
      findFirst:  mockConfidenceWeightsFindFirst,
      findUnique: mockConfidenceWeightsFindUnique,
      create:     mockConfidenceWeightsCreate,
    },
    optimizationLog: { create: mockOptimizationLogCreate },
  },
}));

import { selfOptimizer } from "../signals-engine/self.optimizer.js";
import { adaptiveWeights } from "../signals-engine/adaptive.weights.js";

function telemetryRow(regime: string, outcome: "WIN" | "LOSS", pnl: number) {
  return { signalId: "x", symbol: "EURUSD", confidence: 75, outcome, pnl, marketRegime: regime, indicatorsSnapshot: null };
}

beforeEach(() => {
  adaptiveWeights.invalidate();
  mockSignalTelemetryFindMany.mockReset().mockResolvedValue([]);
  mockConfidenceWeightsFindFirst.mockReset().mockResolvedValue(null);
  mockConfidenceWeightsFindUnique.mockReset().mockResolvedValue(null);
  mockConfidenceWeightsCreate.mockReset().mockResolvedValue({});
  mockOptimizationLogCreate.mockReset().mockResolvedValue({});
});

describe("SelfOptimizerService.run() — Phase 8 regime-gate defaults", () => {
  it("raises PANIC's gate from its new default of 80 (not the generic 60) when PANIC underperforms", async () => {
    const rows = [
      ...Array.from({ length: 1 }, () => telemetryRow("PANIC", "WIN", 10)),
      ...Array.from({ length: 5 }, () => telemetryRow("PANIC", "LOSS", -10)),
      ...Array.from({ length: 9 }, () => telemetryRow("RANGING", "WIN", 5)),
      ...Array.from({ length: 9 }, () => telemetryRow("RANGING", "LOSS", -5)),
      ...Array.from({ length: 6 }, () => telemetryRow("RANGING", "WIN", 5)),
    ];
    mockSignalTelemetryFindMany.mockResolvedValueOnce(rows); // 30 rows total, clears MIN_SAMPLES

    const result = await selfOptimizer.run();

    expect(result.ran).toBe(true);
    expect(result.regimeChanges.PANIC).toBeDefined();
    expect(result.regimeChanges.PANIC!.before).toBe(80); // new explicit default, not the old 60 fallback
    expect(result.regimeChanges.PANIC!.after).toBeGreaterThan(80);
  });

  it("lowers ACCUMULATION's gate from its new default of 70 when ACCUMULATION outperforms", async () => {
    const rows = [
      ...Array.from({ length: 5 }, () => telemetryRow("ACCUMULATION", "WIN", 10)),
      ...Array.from({ length: 1 }, () => telemetryRow("ACCUMULATION", "LOSS", -10)),
      ...Array.from({ length: 12 }, () => telemetryRow("RANGING", "WIN", 5)),
      ...Array.from({ length: 12 }, () => telemetryRow("RANGING", "LOSS", -5)),
    ];
    mockSignalTelemetryFindMany.mockResolvedValueOnce(rows); // 30 rows total

    const result = await selfOptimizer.run();

    expect(result.ran).toBe(true);
    expect(result.regimeChanges.ACCUMULATION).toBeDefined();
    expect(result.regimeChanges.ACCUMULATION!.before).toBe(70); // new explicit default
    expect(result.regimeChanges.ACCUMULATION!.after).toBeLessThan(70);
  });
});
