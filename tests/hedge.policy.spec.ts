/**
 * hedge.policy.spec.ts
 *
 * FASE 3.8 — Internal Liquidity Engine (Group D: hedge scaffold).
 *
 * Pure function tests for evaluateHedgeNeed() — no recommendation below
 * HEDGE_THRESHOLD_PCT, correct side/notional above it (house hedges the
 * OPPOSITE side of client net exposure, since the house is the client's
 * counterparty), and the netNotional=0 edge case (fully offset, nothing to
 * hedge even in principle).
 */
import { describe, it, expect } from "vitest";
import { evaluateHedgeNeed, HEDGE_THRESHOLD_PCT } from "../hedge-service/hedge.policy.js";
import type { ExposureSnapshot } from "../risk-service/exposure.limits.js";

function makeSnapshot(overrides: Partial<ExposureSnapshot> = {}): ExposureSnapshot {
  return {
    symbol: "EURUSD",
    longNotional: 0, shortNotional: 0,
    grossNotional: 0, netNotional: 0, offsetNotional: 0,
    limitGross: 10_000_000, limitNet: 2_000_000,
    grossPct: 0, netPct: 0,
    ...overrides,
  };
}

describe("evaluateHedgeNeed()", () => {
  it("returns null when net exposure is below the threshold", () => {
    const snap = makeSnapshot({ netNotional: 1_000_000, netPct: HEDGE_THRESHOLD_PCT - 1 });
    expect(evaluateHedgeNeed(snap)).toBeNull();
  });

  it("recommends BUY when clients are net long (house is net short)", () => {
    const snap = makeSnapshot({ netNotional: 1_400_000, netPct: 70 });
    const rec = evaluateHedgeNeed(snap);
    expect(rec).not.toBeNull();
    expect(rec!.side).toBe("BUY");
    expect(rec!.notional).toBe(1_400_000);
    expect(rec!.symbol).toBe("EURUSD");
  });

  it("recommends SELL when clients are net short (house is net long)", () => {
    const snap = makeSnapshot({ netNotional: -900_000, netPct: 90 });
    const rec = evaluateHedgeNeed(snap);
    expect(rec).not.toBeNull();
    expect(rec!.side).toBe("SELL");
    expect(rec!.notional).toBe(900_000); // absolute value
  });

  it("triggers exactly at the threshold (netPct === HEDGE_THRESHOLD_PCT)", () => {
    const snap = makeSnapshot({ netNotional: 1_200_000, netPct: HEDGE_THRESHOLD_PCT });
    expect(evaluateHedgeNeed(snap)).not.toBeNull();
  });

  it("returns null when netNotional is exactly 0, even if netPct were somehow non-zero", () => {
    const snap = makeSnapshot({ netNotional: 0, netPct: 80 });
    expect(evaluateHedgeNeed(snap)).toBeNull();
  });

  it("includes a human-readable reason referencing the % and threshold", () => {
    const snap = makeSnapshot({ netNotional: 1_500_000, netPct: 75 });
    const rec = evaluateHedgeNeed(snap);
    expect(rec!.reason).toContain("75.0%");
    expect(rec!.reason).toContain(`${HEDGE_THRESHOLD_PCT}%`);
  });
});
