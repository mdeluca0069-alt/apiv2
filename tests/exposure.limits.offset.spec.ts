/**
 * exposure.limits.offset.spec.ts
 *
 * FASE 3.8 — Internal Liquidity Engine (Group D: internal offset + dealer
 * inventory reporting).
 *
 * ExposureRegistry.getAll()/get() already computed house-wide gross/net
 * exposure per symbol (no userId anywhere in the model) — this just adds
 * offsetNotional (2 × min(long, short)): the notional that opposing client
 * positions already cancel out internally, and so never needs external
 * hedging. Proves the arithmetic and the invariant that ties it to the
 * pre-existing gross/net fields: grossNotional === offsetNotional + |netNotional|.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../shared/db.js", () => ({ prisma: null, IS_PERSISTENT: false }));

const { ExposureRegistry } = await import("../risk-service/exposure.limits.js");

describe("ExposureRegistry — offsetNotional (internal offset)", () => {
  let registry: InstanceType<typeof ExposureRegistry>;

  beforeEach(() => {
    registry = new ExposureRegistry();
  });

  it("is zero when exposure is entirely one-sided (no offset possible)", () => {
    registry.openPosition("EURUSD", "BUY", 500_000);

    const snap = registry.get("EURUSD")!;
    expect(snap.offsetNotional).toBe(0);
    expect(snap.netNotional).toBe(500_000);
  });

  it("equals the smaller side's notional × 2 when both sides are open", () => {
    registry.openPosition("EURUSD", "BUY", 700_000);
    registry.openPosition("EURUSD", "SELL", 300_000);

    const snap = registry.get("EURUSD")!;
    expect(snap.offsetNotional).toBe(600_000); // 2 × min(700k, 300k)
    expect(snap.netNotional).toBe(400_000);    // 700k - 300k
  });

  it("is at its maximum (fully offset, netNotional=0) when both sides are equal", () => {
    registry.openPosition("EURUSD", "BUY", 400_000);
    registry.openPosition("EURUSD", "SELL", 400_000);

    const snap = registry.get("EURUSD")!;
    expect(snap.offsetNotional).toBe(800_000);
    expect(snap.netNotional).toBe(0);
  });

  it("invariant: grossNotional === offsetNotional + |netNotional|, across getAll() too", () => {
    registry.openPosition("EURUSD", "BUY", 900_000);
    registry.openPosition("EURUSD", "SELL", 350_000);
    registry.openPosition("XAUUSD", "SELL", 200_000);

    for (const snap of registry.getAll()) {
      expect(snap.grossNotional).toBeCloseTo(snap.offsetNotional + Math.abs(snap.netNotional), 6);
    }
  });

  it("closing part of a position reduces offsetNotional accordingly", () => {
    registry.openPosition("EURUSD", "BUY", 500_000);
    registry.openPosition("EURUSD", "SELL", 500_000);
    expect(registry.get("EURUSD")!.offsetNotional).toBe(1_000_000);

    registry.closePosition("EURUSD", "SELL", 300_000); // short side shrinks to 200k
    const snap = registry.get("EURUSD")!;
    expect(snap.offsetNotional).toBe(400_000); // 2 × min(500k, 200k)
    expect(snap.netNotional).toBe(300_000);
  });
});
