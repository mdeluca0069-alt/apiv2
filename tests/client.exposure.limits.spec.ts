/**
 * client.exposure.limits.spec.ts
 *
 * RISK_ENGINE_FREEZE.md §3.1 — no cap previously existed on a single
 * client's total open notional or concurrent position count. Proves
 * ClientExposureLimitsChecker.check() rejects once a client's projected
 * notional or position count would exceed their tier's limit, accepts
 * when under it, and falls back to STANDARD limits for an unrecognized
 * tier string.
 */
import { describe, it, expect, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { position: { findMany: vi.fn() } },
}));
vi.mock("../shared/db.js", () => ({ prisma: mockDb, IS_PERSISTENT: true }));

const { clientExposureLimits, CLIENT_EXPOSURE_LIMITS } = await import("../risk-service/client.exposure.limits.js");

function pos(quantity: number, entryPrice: number, markPrice = 0) {
  return {
    quantity:   new Decimal(quantity),
    entryPrice: new Decimal(entryPrice),
    markPrice:  new Decimal(markPrice),
  };
}

describe("ClientExposureLimitsChecker.check()", () => {
  it("accepts when the client has no open positions and the order is well under the tier cap", async () => {
    mockDb.position.findMany.mockResolvedValue([]);

    const result = await clientExposureLimits.check("user-1", "STANDARD", 10_000);
    expect(result.ok).toBe(true);
  });

  it("rejects when projected notional would exceed the tier's cap", async () => {
    mockDb.position.findMany.mockResolvedValue([pos(100_000, 1.1, 1.1)]); // 110,000 notional open

    const limit = CLIENT_EXPOSURE_LIMITS.STANDARD.maxNotionalUsd; // 250,000
    const incoming = limit - 110_000 + 1; // pushes 1 USD over the cap

    const result = await clientExposureLimits.check("user-1", "STANDARD", incoming);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CLIENT_EXPOSURE_LIMIT_EXCEEDED");
      expect(result.detail).toMatch(/STANDARD/);
    }
  });

  it("accepts when projected notional is exactly at the cap", async () => {
    mockDb.position.findMany.mockResolvedValue([pos(100_000, 1.0, 1.0)]);

    const limit = CLIENT_EXPOSURE_LIMITS.STANDARD.maxNotionalUsd;
    const incoming = limit - 100_000;

    const result = await clientExposureLimits.check("user-1", "STANDARD", incoming);
    expect(result.ok).toBe(true);
  });

  it("rejects when opening the position would exceed the tier's max open position count", async () => {
    const limit = CLIENT_EXPOSURE_LIMITS.STANDARD.maxOpenPositions;
    const openPositions = Array.from({ length: limit }, () => pos(10, 1.0, 1.0));
    mockDb.position.findMany.mockResolvedValue(openPositions);

    const result = await clientExposureLimits.check("user-1", "STANDARD", 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/concurrent open positions/);
  });

  it("uses markPrice over entryPrice when computing current notional", async () => {
    mockDb.position.findMany.mockResolvedValue([pos(1_000, 1.0, 2.0)]); // markPrice doubles notional to 2,000

    const limit = CLIENT_EXPOSURE_LIMITS.STANDARD.maxNotionalUsd;
    // If entryPrice (1,000 notional) were used instead of markPrice (2,000), this would pass.
    const incoming = limit - 1_500;

    const result = await clientExposureLimits.check("user-1", "STANDARD", incoming);
    expect(result.ok).toBe(false);
  });

  it("falls back to STANDARD limits for an unrecognized tier string", async () => {
    mockDb.position.findMany.mockResolvedValue([]);

    const standardLimit = CLIENT_EXPOSURE_LIMITS.STANDARD.maxNotionalUsd;
    const result = await clientExposureLimits.check("user-1", "NOT_A_REAL_TIER", standardLimit + 1);

    expect(result.ok).toBe(false);
  });

  it("applies a higher cap for higher tiers", async () => {
    mockDb.position.findMany.mockResolvedValue([]);

    const betweenStandardAndVip = CLIENT_EXPOSURE_LIMITS.STANDARD.maxNotionalUsd + 1;

    const standardResult = await clientExposureLimits.check("user-1", "STANDARD", betweenStandardAndVip);
    const vipResult      = await clientExposureLimits.check("user-2", "VIP", betweenStandardAndVip);

    expect(standardResult.ok).toBe(false);
    expect(vipResult.ok).toBe(true);
  });
});
