/**
 * volatility.leverage.guard.spec.ts
 *
 * RISK_ENGINE_FREEZE.md §5.5 — dynamic.spread.engine.ts already measures
 * live volatility (+ event) intensity per symbol via getMultiplier(), but
 * it only ever fed spread widening (a cost), never fed back into how much
 * leverage a client is allowed on a new position. Proves
 * VolatilityLeverageGuard derates leverage in tiers as the multiplier
 * rises, never increases it, never drops below 1x, and leaves leverage
 * untouched for a calm symbol.
 */
import { describe, it, expect, vi } from "vitest";

const { mockGetMultiplier } = vi.hoisted(() => ({ mockGetMultiplier: vi.fn() }));
vi.mock("../liquidity-engine/dynamic.spread.engine.js", () => ({
  dynamicSpreadEngine: { getMultiplier: mockGetMultiplier },
}));

const { volatilityLeverageGuard } = await import("../risk-service/volatility.leverage.guard.js");

describe("VolatilityLeverageGuard", () => {
  it("does not reduce leverage for a calm symbol (multiplier at baseline 1.0)", () => {
    mockGetMultiplier.mockReturnValue(1.0);
    expect(volatilityLeverageGuard.apply("EURUSD", 30)).toBe(30);
  });

  it("does not reduce leverage just under the first tier's threshold", () => {
    mockGetMultiplier.mockReturnValue(1.49);
    expect(volatilityLeverageGuard.apply("EURUSD", 30)).toBe(30);
  });

  it("applies a 25% reduction at the moderate volatility tier (>= 1.5x)", () => {
    mockGetMultiplier.mockReturnValue(1.5);
    expect(volatilityLeverageGuard.apply("EURUSD", 30)).toBe(22); // floor(30 * 0.75)
  });

  it("applies a 50% reduction at the high volatility tier (>= 2.0x)", () => {
    mockGetMultiplier.mockReturnValue(2.2);
    expect(volatilityLeverageGuard.apply("EURUSD", 30)).toBe(15); // floor(30 * 0.5)
  });

  it("applies a 75% reduction at the extreme volatility tier (>= 3.0x)", () => {
    mockGetMultiplier.mockReturnValue(4.0);
    expect(volatilityLeverageGuard.apply("EURUSD", 30)).toBe(7); // floor(30 * 0.25)
  });

  it("never reduces leverage below 1x even for a very low input leverage", () => {
    mockGetMultiplier.mockReturnValue(4.0);
    expect(volatilityLeverageGuard.apply("EURUSD", 2)).toBe(1); // floor(2 * 0.25) = 0 -> clamped to 1
  });

  it("factorFor() exposes the raw derating factor independent of a leverage value", () => {
    mockGetMultiplier.mockReturnValue(2.5);
    expect(volatilityLeverageGuard.factorFor("EURUSD")).toBe(0.5);
  });
});
