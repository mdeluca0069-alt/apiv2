/**
 * leverage.guard.spec.ts
 *
 * PHASE D (execution-safety gate certification): LeverageGuard.check() --
 * the ESMA retail leverage cap -- had ZERO direct test coverage anywhere
 * in the suite (confirmed by grep before writing this file). It's a
 * simple, pure function, but it's also the gate a bug in
 * ESMA_LEVERAGE_CAPS (shared/contracts.ts) or the capping arithmetic
 * itself would silently defeat with no regression test to catch it --
 * worth closing given every other pre-trade gate already has coverage.
 *
 * check() deliberately never rejects (its own docstring: "capping is the
 * compliant behaviour") -- these tests prove it correctly CAPS instead.
 */
import { describe, it, expect } from "vitest";
import { LeverageGuard } from "../risk-service/leverage.guard.js";

const guard = new LeverageGuard();

describe("LeverageGuard.check() — PHASE D: ESMA leverage cap", () => {
  it("caps FX_MAJOR at 30x when the client requests more", () => {
    const result = guard.check("FX_MAJOR", 100);
    expect(result).toEqual({ effectiveLeverage: 30, capped: true, requestedLeverage: 100, cap: 30 });
  });

  it("caps CRYPTO at 2x (the tightest ESMA tier)", () => {
    const result = guard.check("CRYPTO", 50);
    expect(result.effectiveLeverage).toBe(2);
    expect(result.capped).toBe(true);
  });

  it.each([
    ["FX_MAJOR", 30], ["FX_MINOR", 20], ["INDEX", 20],
    ["COMMODITY", 10], ["EQUITY", 5], ["CRYPTO", 2],
  ])("does NOT cap a request already at or below the %s limit (%dx)", (assetClass, cap) => {
    const result = guard.check(assetClass, cap);
    expect(result.effectiveLeverage).toBe(cap);
    expect(result.capped).toBe(false);
  });

  it("passes through a request below the cap unchanged", () => {
    const result = guard.check("FX_MAJOR", 10);
    expect(result).toEqual({ effectiveLeverage: 10, capped: false, requestedLeverage: 10, cap: 30 });
  });

  it("fails SAFE (defaults to the tightest cap, 2x) for an unrecognized asset class", () => {
    const result = guard.check("SOME_NEW_ASSET_CLASS", 100);
    expect(result.cap).toBe(2);
    expect(result.effectiveLeverage).toBe(2);
    expect(result.capped).toBe(true);
  });

  it("computeNotional() multiplies quantity by price", () => {
    expect(guard.computeNotional(1000, 1.085)).toBeCloseTo(1085, 6);
  });

  it("computeMarginRequired() divides notional by effective leverage", () => {
    expect(guard.computeMarginRequired(10_000, 20)).toBe(500);
  });

  it("computeMarginRequired() throws on non-positive leverage (would otherwise divide by zero or invert margin)", () => {
    expect(() => guard.computeMarginRequired(10_000, 0)).toThrow("Invalid leverage");
    expect(() => guard.computeMarginRequired(10_000, -5)).toThrow("Invalid leverage");
  });
});
