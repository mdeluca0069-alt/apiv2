/**
 * requote.policy.spec.ts
 *
 * FASE 3.3 — Internal Liquidity Engine.
 *
 * Proves checkRequote() compares the correct side-relevant price (ask for
 * BUY, bid for SELL — the side that actually determines what the client
 * pays/receives), uses an asset-class-aware tolerance, and never flags a
 * requote for moves within tolerance.
 */
import { describe, it, expect } from "vitest";
import { checkRequote } from "../execution-service/requote.policy.js";

describe("checkRequote()", () => {
  it("does not requote a BUY when the ask barely moved", () => {
    const result = checkRequote(
      "EURUSD", "BUY",
      { bid: 1.0868, ask: 1.0870 },
      { bid: 1.0869, ask: 1.0871 }, // ask moved ~0.009%
    );
    expect(result.requoted).toBe(false);
  });

  it("requotes a BUY when the ask moved beyond the FX_MAJOR tolerance (0.25%)", () => {
    const result = checkRequote(
      "EURUSD", "BUY",
      { bid: 1.0868, ask: 1.0870 },
      { bid: 1.0898, ask: 1.0900 }, // ask moved ~0.276%
    );
    expect(result.requoted).toBe(true);
    expect(result.threshold).toBe(0.25);
  });

  it("compares BID for a SELL, not ask — a moved ask alone must not trigger a SELL requote", () => {
    const result = checkRequote(
      "EURUSD", "SELL",
      { bid: 1.0868, ask: 1.0870 },
      { bid: 1.0868, ask: 1.0950 }, // ask jumped, bid unchanged
    );
    expect(result.requoted).toBe(false);
  });

  it("requotes a SELL when the bid itself moved beyond tolerance", () => {
    const result = checkRequote(
      "EURUSD", "SELL",
      { bid: 1.0868, ask: 1.0870 },
      { bid: 1.0838, ask: 1.0870 }, // bid dropped ~0.276%
    );
    expect(result.requoted).toBe(true);
  });

  it("uses a wider tolerance for CRYPTO than FX_MAJOR", () => {
    const move = checkRequote(
      "BTCUSD", "BUY",
      { bid: 67_000, ask: 67_010 },
      { bid: 67_600, ask: 67_610 }, // ~0.89% move
    );
    // Under the 1.5% crypto tolerance — would have tripped FX_MAJOR's 0.25%.
    expect(move.requoted).toBe(false);
    expect(move.threshold).toBe(1.5);
  });

  it("uses the EQUITY tolerance for a symbol assetClassOf() can't classify more specifically", () => {
    // assetClassOf() falls back to "EQUITY" for anything that isn't a known
    // FX/commodity/index/crypto symbol or a 6-letter FX_MINOR-shaped code —
    // every value it can ever return is covered in REQUOTE_TOLERANCE_PCT, so
    // this exercises that fallback path end to end rather than an unmapped one.
    const result = checkRequote(
      "AAPL", "BUY",
      { bid: 214.90, ask: 215.00 },
      { bid: 217.10, ask: 217.20 }, // ~1.02% move, clearly past the 1.0% threshold
    );
    expect(result.threshold).toBe(1.0);
    expect(result.requoted).toBe(true);
  });
});
