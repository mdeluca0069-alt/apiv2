/**
 * live.trading.flag.resolution.spec.ts
 *
 * PRODUCTION_DEPLOYMENT_SAFETY_DECISION.md §D — regression guard for the
 * confirmed live-trading feature-flag bug (see broker-state.feature-flags.
 * live-trading.spec.ts for the getFeatureFlags()-level guard). This file
 * covers the environment-variable-to-boolean resolution itself
 * (security/live-trading.guard.ts's resolveLiveTradingEnabled()), which
 * main.ts calls to derive the value it passes into BrokerState.
 *
 * Required cases: LIVE_TRADING_ENABLED=false -> false,
 * LIVE_TRADING_ENABLED=true -> true, missing -> false, invalid -> false.
 */
import { describe, it, expect } from "vitest";
import { resolveLiveTradingEnabled } from "../security/live-trading.guard.js";

describe("resolveLiveTradingEnabled — safe-by-default environment resolution", () => {
  it("LIVE_TRADING_ENABLED=false -> false", () => {
    expect(resolveLiveTradingEnabled({ LIVE_TRADING_ENABLED: "false" })).toBe(false);
  });

  it("LIVE_TRADING_ENABLED=true -> true", () => {
    expect(resolveLiveTradingEnabled({ LIVE_TRADING_ENABLED: "true" })).toBe(true);
  });

  it("REGRESSION GUARD: missing variable -> false", () => {
    expect(resolveLiveTradingEnabled({})).toBe(false);
  });

  it("REGRESSION GUARD: invalid/unexpected values -> false, never true", () => {
    const invalidValues = ["TRUE", "True", "1", "yes", "on", "  true", "true ", "truex", ""];
    for (const v of invalidValues) {
      expect(resolveLiveTradingEnabled({ LIVE_TRADING_ENABLED: v })).toBe(false);
    }
  });

  it("defaults to reading the real process.env when called with no argument", () => {
    const original = process.env.LIVE_TRADING_ENABLED;
    try {
      delete process.env.LIVE_TRADING_ENABLED;
      expect(resolveLiveTradingEnabled()).toBe(false);
      process.env.LIVE_TRADING_ENABLED = "not-a-real-value";
      expect(resolveLiveTradingEnabled()).toBe(false);
      process.env.LIVE_TRADING_ENABLED = "true";
      expect(resolveLiveTradingEnabled()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.LIVE_TRADING_ENABLED;
      else process.env.LIVE_TRADING_ENABLED = original;
    }
  });
});
