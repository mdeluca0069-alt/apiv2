/**
 * broker-state.feature-flags.live-trading.spec.ts
 *
 * PRODUCTION_DEPLOYMENT_SAFETY_DECISION.md §D — regression guard for the
 * confirmed bug: BrokerState.getFeatureFlags() used to compute
 * `liveTrading: this._liveTradingEnabled || true`, which is
 * unconditionally `true` in JavaScript no matter what
 * `_liveTradingEnabled` actually is. Both GET /config/feature-flags and
 * GET /api/license/validate (public, no auth) are backed by this method,
 * and the frontend's only client-side pre-submission trading guard
 * (TradingPage.tsx) trusts its `liveTrading` value -- so the bug silently
 * defeated that guard regardless of how LIVE_TRADING_ENABLED was actually
 * configured.
 *
 * Required cases: constructed with liveTradingEnabled: false -> reports
 * false; constructed with liveTradingEnabled: true -> reports true.
 */
import { describe, it, expect } from "vitest";
import { BrokerState } from "../shared/state.js";

describe("BrokerState.getFeatureFlags().liveTrading — reflects the real configured value", () => {
  it("LIVE_TRADING_ENABLED=false (constructed with liveTradingEnabled: false) -> liveTrading: false", () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });
    expect(state.getFeatureFlags().liveTrading).toBe(false);
  });

  it("LIVE_TRADING_ENABLED=true (constructed with liveTradingEnabled: true) -> liveTrading: true", () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: true });
    expect(state.getFeatureFlags().liveTrading).toBe(true);
  });

  it("REGRESSION GUARD: a false-configured instance never reports true regardless of other flags present", () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });
    const flags = state.getFeatureFlags();
    expect(flags.liveTrading).toBe(false);
    // Sanity: other flags are unaffected by this fix, still present and boolean.
    expect(typeof flags.aiTrading).toBe("boolean");
    expect(typeof flags.kycRequiredBeforeLive).toBe("boolean");
  });

  it("an admin override still wins over the base env-derived value either direction", () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });
    state.updateFeatureFlags({ liveTrading: true }, "admin-1");
    expect(state.getFeatureFlags().liveTrading).toBe(true);

    const state2 = new BrokerState({ secret: "test", liveTradingEnabled: true });
    state2.updateFeatureFlags({ liveTrading: false }, "admin-1");
    expect(state2.getFeatureFlags().liveTrading).toBe(false);
  });
});
