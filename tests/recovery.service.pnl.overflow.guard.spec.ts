/**
 * recovery.service.pnl.overflow.guard.spec.ts
 *
 * PRODUCTION CUTOVER Stage 3 — found live in the Stage 3 shadow deployment:
 * RecoveryService.run()'s step 1 (recompute floating P&L for every open
 * position) looped over db.position.update() with no per-row try/catch. A
 * single position with a corrupted/stale entryPrice (in this case, a
 * shadow-environment seed-data bug: an FX-shaped entry price of 1.1002 on a
 * BTCUSD position) produces a pnlPercent of several million percent once
 * priced against a real market quote, which overflows the pnlPercent
 * column (Decimal(10,4), max abs ~999999.9999) and threw a Prisma error --
 * confirmed live via "[recovery] startup recovery failed: ... numeric field
 * overflow" in container logs. Because the loop had no per-row guard, that
 * one bad position aborted P&L recompute for every OTHER open position too,
 * and (since the whole step-1 loop precedes steps 2-5 in the same function)
 * silently skipped orphan-margin release, stuck-order rejection, orphan
 * detection, and the reconciliation sweep for the server's entire uptime
 * until the next restart -- for every user, not just the one with bad data.
 *
 * Fix: (1) each position update is now individually try/caught so one bad
 * row is skipped and logged, not fatal to the loop; (2) the computed
 * percentage is clamped to the column's real range before being persisted,
 * matching the same defensive pattern margin.controller.ts's
 * snapshotMargin() already uses for marginLevelPct.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockQuoteGet } = vi.hoisted(() => ({ mockQuoteGet: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({ quoteCache: { get: mockQuoteGet } }));

const { mockRunFull } = vi.hoisted(() => ({ mockRunFull: vi.fn().mockResolvedValue({ summary: "ok" }) }));
vi.mock("../settlement/reconciliation.engine.js", () => ({
  reconciliationEngine: { runFull: mockRunFull },
}));

vi.mock("../shared/trading.suspension.js", () => ({
  tradingSuspension: { suspend: vi.fn(), getSuspendedUsers: vi.fn().mockReturnValue([]) },
}));

const { mockPositionFindMany, mockPositionUpdate } = vi.hoisted(() => ({
  mockPositionFindMany: vi.fn(),
  mockPositionUpdate:   vi.fn(),
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    position:      { findMany: mockPositionFindMany, update: mockPositionUpdate, aggregate: vi.fn().mockResolvedValue({ _sum: { marginUsed: null } }) },
    walletAccount: { findMany: vi.fn().mockResolvedValue([]) },
    order:         { findMany: vi.fn().mockResolvedValue([]) },
    auditLog:      { create: vi.fn().mockResolvedValue({}) },
    $executeRaw:   vi.fn().mockResolvedValue(0),
    $queryRaw:     vi.fn().mockResolvedValue([]),
    $transaction:  vi.fn(),
  },
}));

const { recoveryService } = await import("../settlement/recovery.service.js");

const BAD_POSITION = {
  id: "shadow-position-11", userId: "u1", symbol: "BTCUSD", side: "BUY" as const,
  quantity: new Decimal(0.01), entryPrice: new Decimal(1.1002),
};
const GOOD_POSITION = {
  id: "pos-good", userId: "u2", symbol: "EURUSD", side: "BUY" as const,
  quantity: new Decimal(1000), entryPrice: new Decimal(1.15),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockQuoteGet.mockImplementation((symbol: string) =>
    symbol === "BTCUSD" ? { bid: 64696, ask: 64701 } : { bid: 1.1509, ask: 1.151 },
  );
});

describe("RecoveryService.run() — P&L recompute overflow guard", () => {
  it("skips a position whose recomputed pnlPercent overflows the DB column instead of aborting the whole recovery run", async () => {
    mockPositionFindMany.mockResolvedValue([BAD_POSITION, GOOD_POSITION]);
    // Simulate Prisma's real behavior: an out-of-range Decimal throws.
    mockPositionUpdate.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === BAD_POSITION.id) {
        throw new Error(
          'numeric field overflow -- A field with precision 10, scale 4 must round to an absolute value less than 10^6.',
        );
      }
      return {};
    });

    const report = await recoveryService.run();

    expect(report).not.toBeNull();
    // The bad row failed and was skipped; the good row still got recomputed --
    // proves the loop no longer aborts on the first bad row.
    expect(report!.positionsRecomputed).toBe(1);
    expect(mockPositionUpdate).toHaveBeenCalledTimes(2);
    // Steps 2-5 still ran (reconciliation sweep reached) -- proves the
    // exception from step 1 no longer propagates out of run() at all.
    expect(mockRunFull).toHaveBeenCalledTimes(1);
  });

  it("clamps an extreme pnlPercent to the column's safe range instead of ever attempting to write an out-of-range Decimal", async () => {
    mockPositionFindMany.mockResolvedValue([BAD_POSITION]);
    mockPositionUpdate.mockResolvedValue({});

    await recoveryService.run();

    expect(mockPositionUpdate).toHaveBeenCalledTimes(1);
    const data = mockPositionUpdate.mock.calls[0][0].data as { pnlPercent: Decimal };
    expect(data.pnlPercent.toNumber()).toBeLessThanOrEqual(999_999);
    expect(data.pnlPercent.toNumber()).toBeGreaterThanOrEqual(-999_999);
  });

  it("still recomputes normally for realistic, in-range positions (no clamping applied)", async () => {
    mockPositionFindMany.mockResolvedValue([GOOD_POSITION]);
    mockPositionUpdate.mockResolvedValue({});

    const report = await recoveryService.run();

    expect(report!.positionsRecomputed).toBe(1);
    const data = mockPositionUpdate.mock.calls[0][0].data as { pnlPercent: Decimal };
    // (1.1509 - 1.15) / 1.15 * 100 ≈ 0.0783%
    expect(data.pnlPercent.toNumber()).toBeCloseTo(0.0783, 2);
  });
});
