/**
 * adaptive.weights.test.ts
 *
 * Regression coverage for the structureAlignment dimension added to the
 * adaptive weights contract — DEFAULT_WEIGHTS/DIMENSION_KEYS must stay in
 * sync with ConfidenceEngine's DEFAULT_CONFIDENCE_WEIGHTS, and the merged
 * weight set must still sum to 100. No DB involved (DEFAULT_WEIGHTS is a
 * pure constant — getWeights()'s DB path is out of scope here).
 *
 * Plus (Task 13, Phase 8) explicit DEFAULT_REGIME_GATES entries for the 4
 * regimes RegimeEngine gained in Phase 2.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_WEIGHTS, DIMENSION_KEYS, DEFAULT_REGIME_GATES } from "../signals-engine/adaptive.weights.js";
import { DEFAULT_CONFIDENCE_WEIGHTS } from "../ai-core/confidence.engine.js";

describe("adaptive.weights defaults — structureAlignment / multiTimeframeAlignment / correlationContext", () => {
  it("includes structureAlignment, multiTimeframeAlignment and correlationContext in DIMENSION_KEYS", () => {
    expect(DIMENSION_KEYS).toContain("structureAlignment");
    expect(DIMENSION_KEYS).toContain("multiTimeframeAlignment");
    expect(DIMENSION_KEYS).toContain("correlationContext");
  });

  it("DEFAULT_WEIGHTS sums to 100 and matches ConfidenceEngine's defaults", () => {
    const total = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
    expect(DEFAULT_WEIGHTS).toEqual(DEFAULT_CONFIDENCE_WEIGHTS);
  });

  it("every DIMENSION_KEYS entry has a corresponding DEFAULT_WEIGHTS value", () => {
    for (const key of DIMENSION_KEYS) {
      expect(typeof DEFAULT_WEIGHTS[key]).toBe("number");
    }
  });
});

describe("adaptive.weights defaults — Phase 8: regime gates for PANIC/RECOVERY/ACCUMULATION/DISTRIBUTION", () => {
  it("defines an explicit starting gate for each of RegimeEngine's 4 new regimes (no longer relying on the generic ?? 60 fallback)", () => {
    for (const regime of ["PANIC", "RECOVERY", "ACCUMULATION", "DISTRIBUTION"]) {
      expect(typeof DEFAULT_REGIME_GATES[regime]).toBe("number");
    }
  });

  it("gates PANIC at least as strictly as every other non-blocked regime, reflecting its historically unreliable character", () => {
    const nonBlocked = Object.entries(DEFAULT_REGIME_GATES).filter(([regime]) => regime !== "RISK_OFF");
    const maxOtherGate = Math.max(...nonBlocked.filter(([regime]) => regime !== "PANIC").map(([, gate]) => gate));
    expect(DEFAULT_REGIME_GATES.PANIC).toBeGreaterThanOrEqual(maxOtherGate);
  });
});
