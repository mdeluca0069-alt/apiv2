/**
 * client.exposure.limits.spec.ts
 *
 * RISK_ENGINE_FREEZE.md §3.1 — no cap previously existed on a single
 * client's total open notional or concurrent position count. Proves
 * ClientExposureLimitsChecker.check() rejects once a client's projected
 * notional or position count would exceed their tier's limit, accepts
 * when under it, and falls back to STANDARD limits for an unrecognized
 * tier string.
 *
 * MARKET_DATA_FREEZE.md §0.3 — updated to mock quoteCache instead of a
 * Position.markPrice DB field: this module now values open positions via
 * market-data/position.valuation.ts's liveNotional(), never the DB column.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { position: { findMany: vi.fn() } },
}));
vi.mock("../shared/db.js", () => ({ prisma: mockDb, IS_PERSISTENT: true }));

const { mockQuoteCacheGet } = vi.hoisted(() => ({ mockQuoteCacheGet: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({ quoteCache: { get: mockQuoteCacheGet } }));

const { clientExposureLimits, CLIENT_EXPOSURE_LIMITS } = await import("../risk-service/client.exposure.limits.js");

function pos(symbol: string, quantity: number, entryPrice: number) {
  return {
    symbol,
    quantity:   new Decimal(quantity),
    entryPrice: new Decimal(entryPrice),
  };
}

beforeEach(() => {
  mockQuoteCacheGet.mockReturnValue(undefined); // no live quote by default -> falls back to entryPrice
});

describe("ClientExposureLimitsChecker.check()", () => {
  it("accepts when the client has no open positions and the order is well under the tier cap", async () => {
    mockDb.position.findMany.mockResolvedValue([]);

    const result = await clientExposureLimits.check("user-1", "STANDARD", 10_000);
    expect(result.ok).toBe(true);
  });

  it("rejects when projected notional would exceed the tier's cap", async () => {
    mockDb.position.findMany.mockResolvedValue([pos("EURUSD", 100_000, 1.1)]); // 110,000 notional open

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
    mockDb.position.findMany.mockResolvedValue([pos("EURUSD", 100_000, 1.0)]);

    const limit = CLIENT_EXPOSURE_LIMITS.STANDARD.maxNotionalUsd;
    const incoming = limit - 100_000;

    const result = await clientExposureLimits.check("user-1", "STANDARD", incoming);
    expect(result.ok).toBe(true);
  });

  it("rejects when opening the position would exceed the tier's max open position count", async () => {
    const limit = CLIENT_EXPOSURE_LIMITS.STANDARD.maxOpenPositions;
    const openPositions = Array.from({ length: limit }, () => pos("EURUSD", 10, 1.0));
    mockDb.position.findMany.mockResolvedValue(openPositions);

    const result = await clientExposureLimits.check("user-1", "STANDARD", 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/concurrent open positions/);
  });

  it("uses the live quoteCache price over entryPrice when computing current notional (MARKET_DATA_FREEZE.md §0.3)", async () => {
    mockDb.position.findMany.mockResolvedValue([pos("EURUSD", 1_000, 1.0)]);
    mockQuoteCacheGet.mockReturnValue({ symbol: "EURUSD", bid: 1.999, ask: 2.001, mid: 2.0, spread: 0.002, changePct: 0, ts: new Date().toISOString() });

    const limit = CLIENT_EXPOSURE_LIMITS.STANDARD.maxNotionalUsd;
    // If entryPrice (1,000 notional) were used instead of the live mid (2,000), this would pass.
    const incoming = limit - 1_500;

    const result = await clientExposureLimits.check("user-1", "STANDARD", incoming);
    expect(result.ok).toBe(false);
  });

  it("falls back to entryPrice when quoteCache has no live quote for the symbol", async () => {
    mockDb.position.findMany.mockResolvedValue([pos("EURUSD", 1_000, 1.0)]); // 1,000 notional via entryPrice fallback
    mockQuoteCacheGet.mockReturnValue(undefined);

    const limit = CLIENT_EXPOSURE_LIMITS.STANDARD.maxNotionalUsd;
    const incoming = limit - 1_000; // exactly at cap if entryPrice (not some other value) is used

    const result = await clientExposureLimits.check("user-1", "STANDARD", incoming);
    expect(result.ok).toBe(true);
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

describe("ClientExposureLimitsChecker.checkAtomic() — PHASE2_REMEDIATION (H6)", () => {
  // check() (above) reads Position rows live but takes no lock -- this
  // class's own doc comment already flagged that as a same-instant
  // double-submit race that could admit one order slightly over cap.
  // checkAtomic() closes that gap: called inside execution.engine.ts's
  // transaction, under a pg_advisory_xact_lock(hashtext(userId)).
  function rawRow(symbol: string, quantity: number, entryPrice: number) {
    return { symbol, quantity: String(quantity), entryPrice: String(entryPrice) };
  }

  function makeTx(rows: ReturnType<typeof rawRow>[]) {
    return { $queryRaw: vi.fn().mockResolvedValue(rows) };
  }

  it("accepts when the client has no open positions and the order is well under the tier cap", async () => {
    const tx = makeTx([]);

    const result = await clientExposureLimits.checkAtomic(tx as never, "user-1", "STANDARD", 10_000);
    expect(result.ok).toBe(true);
  });

  it("rejects when projected notional would exceed the tier's cap, computed from the SAME live-queried rows checkAtomic() itself fetched", async () => {
    const tx = makeTx([rawRow("EURUSD", 100_000, 1.1)]); // 110,000 notional open

    const limit = CLIENT_EXPOSURE_LIMITS.STANDARD.maxNotionalUsd;
    const incoming = limit - 110_000 + 1;

    const result = await clientExposureLimits.checkAtomic(tx as never, "user-1", "STANDARD", incoming);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("CLIENT_EXPOSURE_LIMIT_EXCEEDED");
  });

  it("rejects when opening the position would exceed the tier's max open position count", async () => {
    const limit = CLIENT_EXPOSURE_LIMITS.STANDARD.maxOpenPositions;
    const tx = makeTx(Array.from({ length: limit }, () => rawRow("EURUSD", 10, 1.0)));

    const result = await clientExposureLimits.checkAtomic(tx as never, "user-1", "STANDARD", 100);
    expect(result.ok).toBe(false);
  });

  it("acquires the advisory lock scoped to userId, inside the caller's own transaction (no separate transaction opened)", async () => {
    const tx = makeTx([]);

    await clientExposureLimits.checkAtomic(tx as never, "user-42", "STANDARD", 1_000);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = (tx.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join("");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("Position");
    // userId is a bound param, not string-interpolated into the SQL text.
    const params = tx.$queryRaw.mock.calls[0]!.slice(1);
    expect(params).toContain("user-42");
  });
});
