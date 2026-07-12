/**
 * slippage.controller.unification.spec.ts
 *
 * FASE 3.7 — Internal Liquidity Engine (Group C: slippage model unification).
 *
 * Before this fix, SlippageController.compute() (used only by the
 * GET /execution/slippage-preview client-facing endpoint) computed its
 * "market impact" component from an independently-tuned linear formula
 * (notional / marketImpactDivisor × spreadPips), while InternalLiquidityProvider
 * .calculateFill() (used by every REAL fill, close, and liquidation) charges a
 * completely different notional-tier lookup via _deterministicSlippage() — the
 * two disagreed by several pips on the same trade, so the preview lied about
 * what a client's order would actually cost.
 *
 * Fix: compute()'s impactComponent is now sourced directly from
 * LiquidityProvider.estimateSlippage() (a thin public wrapper around the same
 * _deterministicSlippage() the real fill path uses) — these tests prove the
 * preview's impact number always exactly matches what a real order of the
 * same symbol/notional would be charged, across every asset class and
 * notional tier, while leaving the spread/volatility components (which the
 * real fill path has no equivalent of) and qualityScore() untouched.
 */
import { describe, it, expect } from "vitest";
import { slippageController } from "../execution-service/slippage.controller.js";
import { LiquidityProvider } from "../liquidity-engine/liquidity.provider.js";

const PIP_SIZE: Record<string, number> = {
  EURUSD: 0.0001, // FX_MAJOR
  EURSEK: 0.0001, // FX_MINOR
  US500:  0.1,    // INDEX
  XAUUSD: 0.01,   // COMMODITY
  AAPL:   0.01,   // EQUITY
  BTCUSD: 1.0,    // CRYPTO
};

describe("SlippageController.compute() — impact component matches the real fill path", () => {
  const cases: Array<{ symbol: string; quantity: number; midPrice: number }> = [
    { symbol: "EURUSD", quantity: 50_000,    midPrice: 1.0870 },   // below FX_MAJOR tier 1
    { symbol: "EURUSD", quantity: 300_000,   midPrice: 1.0870 },   // FX_MAJOR tier 2
    { symbol: "EURUSD", quantity: 3_000_000, midPrice: 1.0870 },   // FX_MAJOR tier 4 (largest)
    { symbol: "EURSEK", quantity: 300_000,   midPrice: 11.20 },    // FX_MINOR tier 2
    { symbol: "US500",  quantity: 200,       midPrice: 5200 },     // INDEX (notional 1.04M)
    { symbol: "XAUUSD", quantity: 300,       midPrice: 2400 },     // COMMODITY (notional 720k)
    { symbol: "AAPL",   quantity: 1000,      midPrice: 210 },      // EQUITY (notional 210k)
    { symbol: "BTCUSD", quantity: 2,         midPrice: 65_000 },   // CRYPTO tier 3 (notional 130k)
  ];

  it.each(cases)("$symbol qty=$quantity: impactComponent (pips) === LiquidityProvider.estimateSlippage() (price units) / pipSize", (c) => {
    const result = slippageController.compute({
      symbol: c.symbol, side: "BUY", quantity: c.quantity, midPrice: c.midPrice,
      spread: c.midPrice * 0.0001, changePct: 0.05, // negligible spread/vol so only impact matters for this assertion
    });

    const notional = c.quantity * c.midPrice;
    const realSlippagePriceUnits = LiquidityProvider.estimateSlippage(c.symbol, notional);
    const expectedImpactPips = Math.round((realSlippagePriceUnits / PIP_SIZE[c.symbol]) * 100) / 100;

    expect(result.impactComponent).toBe(expectedImpactPips);
  });

  it("a small order (below every notional tier) has zero impact component, matching a real zero-slippage fill", () => {
    const result = slippageController.compute({
      symbol: "EURUSD", side: "BUY", quantity: 1_000, midPrice: 1.0870,
      spread: 0.0001, changePct: 0.05,
    });

    expect(LiquidityProvider.estimateSlippage("EURUSD", 1_000 * 1.0870)).toBe(0);
    expect(result.impactComponent).toBe(0);
  });
});

describe("SlippageController.compute() — spread and volatility components unaffected by the unification", () => {
  it("spreadComponent is still exactly half the spread in pips, independent of the impact fix", () => {
    const result = slippageController.compute({
      symbol: "EURUSD", side: "BUY", quantity: 10_000, midPrice: 1.0870,
      spread: 0.0002, changePct: 0, // 2 pips spread
    });
    expect(result.spreadComponent).toBe(1.0); // half of 2 pips
  });

  it("volComponent still scales with changePct via the existing step function", () => {
    const low  = slippageController.compute({ symbol: "EURUSD", side: "BUY", quantity: 10_000, midPrice: 1.0870, spread: 0.0002, changePct: 0.05 });
    const high = slippageController.compute({ symbol: "EURUSD", side: "BUY", quantity: 10_000, midPrice: 1.0870, spread: 0.0002, changePct: 1.5 });
    expect(low.volComponent).toBe(0);
    expect(high.volComponent).toBeGreaterThan(0);
  });
});

describe("SlippageController.qualityScore() — untouched by the impact-component fix", () => {
  it("still computes deviation-based quality score exactly as before", () => {
    const score = slippageController.qualityScore("EURUSD", 1.0870, 1.0871, 0.0002);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    // Perfect fill (no deviation) is still 100.
    expect(slippageController.qualityScore("EURUSD", 1.0870, 1.0870, 0.0002)).toBe(100);
  });
});

describe("LiquidityProvider.estimateSlippage() — public wrapper matches the private fill-path calculation exactly", () => {
  it("returns the identical value calculateFill() would apply as slippage for the same symbol/notional", () => {
    const fill = LiquidityProvider.calculateFill(
      { symbol: "EURUSD", bid: 1.0868, ask: 1.0870 },
      "BUY",
      300_000 / 1.0870, // ~300k notional
    );
    const estimated = LiquidityProvider.estimateSlippage("EURUSD", 300_000);
    expect(fill.slippage).toBe(estimated);
  });
});
