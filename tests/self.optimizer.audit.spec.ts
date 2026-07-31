/**
 * self.optimizer.audit.spec.ts
 *
 * PHASE2_REMEDIATION (H16) — the admin route audit found that
 * POST /admin/olos/optimizer/run (SelfOptimizerService.run()) had zero call
 * into the permanent, hash-chained AuditLog. A manual optimizer run
 * publishes a new live ConfidenceWeights version affecting every signal
 * generated afterward.
 *
 * run()'s new `actor` param is only supplied by the admin route -- proven
 * here by mocking immutable.audit.js (self.optimizer.test.ts, the
 * pre-existing coverage, never supplies an actor and is unaffected).
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

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("audit-id-1") }));
vi.mock("../security/immutable.audit.js", () => ({
  immutableAudit: { write: mockAuditWrite },
}));

const { selfOptimizer } = await import("../signals-engine/self.optimizer.js");
const { adaptiveWeights } = await import("../signals-engine/adaptive.weights.js");

function telemetryRow(regime: string, outcome: "WIN" | "LOSS", pnl: number) {
  return { signalId: "x", symbol: "EURUSD", confidence: 75, outcome, pnl, marketRegime: regime, indicatorsSnapshot: null };
}

function thirtyRows() {
  return [
    ...Array.from({ length: 15 }, () => telemetryRow("RANGING", "WIN", 5)),
    ...Array.from({ length: 15 }, () => telemetryRow("RANGING", "LOSS", -5)),
  ];
}

beforeEach(() => {
  adaptiveWeights.invalidate();
  mockSignalTelemetryFindMany.mockReset().mockResolvedValue([]);
  mockConfidenceWeightsFindFirst.mockReset().mockResolvedValue(null);
  mockConfidenceWeightsFindUnique.mockReset().mockResolvedValue(null);
  mockConfidenceWeightsCreate.mockReset().mockResolvedValue({});
  mockOptimizationLogCreate.mockReset().mockResolvedValue({});
  mockAuditWrite.mockClear().mockResolvedValue("audit-id-1");
});

describe("SelfOptimizerService.run() — PHASE2_REMEDIATION (H16): immutable audit trail", () => {
  it("writes an immutable audit entry when an actor is supplied (the admin route path)", async () => {
    mockSignalTelemetryFindMany.mockResolvedValueOnce(thirtyRows());

    const result = await selfOptimizer.run("admin-1");

    expect(result.ran).toBe(true);
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    const [entry] = mockAuditWrite.mock.calls[0]!;
    expect(entry).toMatchObject({
      actor:  "admin-1",
      action: "olos.optimizer_run",
      entity: String(result.newVersion),
    });
  });

  it("does not write an audit entry when no actor is supplied", async () => {
    mockSignalTelemetryFindMany.mockResolvedValueOnce(thirtyRows());

    const result = await selfOptimizer.run();

    expect(result.ran).toBe(true);
    expect(mockAuditWrite).not.toHaveBeenCalled();
  });

  it("does not write an audit entry when the run is skipped (insufficient samples), even with an actor", async () => {
    mockSignalTelemetryFindMany.mockResolvedValueOnce([telemetryRow("RANGING", "WIN", 1)]); // below MIN_SAMPLES

    const result = await selfOptimizer.run("admin-1");

    expect(result.ran).toBe(false);
    expect(mockAuditWrite).not.toHaveBeenCalled();
  });
});
