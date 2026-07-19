/**
 * liquidity.provider.limit.order.spec.ts
 *
 * RISK_ENGINE_FREEZE.md §1.6 — InternalLiquidityProvider.executeLimitOrder()
 * built a synthetic quote pinning the relevant side to limitPrice, then ran
 * it through the SAME calculateFill() used for MARKET orders -- which
 * always adds the same deterministic, notional-tiered slippage on top.
 * For large enough notional (nonzero slippage tiers), that pushed a BUY
 * LIMIT fill ABOVE its own limit and a SELL LIMIT fill BELOW it, breaking
 * this interface's own documented contract (i.liquidity.provider.ts:
 * "executeLimitOrder returns a fill at limitPrice or better, or throws if
 * no fill possible").
 *
 * Fix: the resulting averagePrice is clamped back onto the client's limit
 * -- never worse, price improvement only when slippage happens to help.
 */
import { describe, it, expect } from "vitest";
import { LiquidityProvider } from "../liquidity-engine/liquidity.provider.js";

const QUOTE = { symbol: "EURUSD", bid: 1.0998, ask: 1.1000, mid: 1.0999 };

describe("LiquidityProvider.executeLimitOrder() — never worse than the limit price", () => {
  it("a BUY LIMIT large enough to incur slippage still fills at or below the limit, never above", () => {
    const limitPrice = 1.1000;
    const quantity    = 200_000; // notional 220,000 -> FX_MAJOR nonzero slip tier

    const fill = LiquidityProvider.executeLimitOrder("EURUSD", "BUY", quantity, limitPrice, QUOTE);

    expect(fill.averagePrice).toBeLessThanOrEqual(limitPrice);
  });

  it("a SELL LIMIT large enough to incur slippage still fills at or above the limit, never below", () => {
    const limitPrice = 1.0998;
    const quantity    = 200_000;

    const fill = LiquidityProvider.executeLimitOrder("EURUSD", "SELL", quantity, limitPrice, QUOTE);

    expect(fill.averagePrice).toBeGreaterThanOrEqual(limitPrice);
  });

  it("a small BUY LIMIT (zero-slippage tier) fills exactly at the limit price, unaffected by clamping", () => {
    const limitPrice = 1.1000;
    const quantity    = 1_000; // notional 1,100 -> zero slip tier

    const fill = LiquidityProvider.executeLimitOrder("EURUSD", "BUY", quantity, limitPrice, QUOTE);

    expect(fill.averagePrice).toBe(limitPrice);
  });

  it("reproduces the exact pre-fix defect: confirms nonzero slippage was really being computed for this size, and the clamp is what prevents the violation", () => {
    const limitPrice = 1.1000;
    const quantity    = 200_000;
    const notional    = quantity * limitPrice;

    const rawSlippage = LiquidityProvider.estimateSlippage("EURUSD", notional);
    expect(rawSlippage).toBeGreaterThan(0); // this scenario really would have broken the guarantee pre-fix

    const fill = LiquidityProvider.executeLimitOrder("EURUSD", "BUY", quantity, limitPrice, QUOTE);
    expect(fill.averagePrice).toBeLessThanOrEqual(limitPrice);
    // The pre-fix, unclamped price would have been limitPrice + rawSlippage --
    // strictly worse for the client. Confirm the clamp actually engaged.
    expect(fill.averagePrice).toBeLessThan(limitPrice + rawSlippage);
  });
});
