/**
 * var.engine.margin.used.source.spec.ts
 *
 * PHASE2_REMEDIATION (H5) — VarEngine.computeVaR() used to read
 * WalletAccount.locked for its `marginUsed` figure -- the same drift bug
 * as stopout.engine.ts (see stopout.engine.margin.used.source.spec.ts's
 * docstring for the full root-cause explanation): `locked` and
 * sum(Position.marginUsed) are tracked independently and never cross-
 * checked at decision time, so VaR's margin-level projections could
 * diverge from what margin.controller.ts's getMarginState() (the pre-
 * trade risk gate and client dashboard) reports for the same account.
 *
 * Fix: marginUsed is now sum(Position.marginUsed) -- the same aggregate
 * getMarginState() uses -- instead of WalletAccount.locked.
 *
 * This is the first test file for var.engine.ts; scoped tightly to the H5
 * marginUsed sourcing (via marginForecast[0], which directly reflects
 * equity/marginUsed*100 with no projected loss at daysAhead=0), not a full
 * backfill of VaR math coverage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWalletFindUnique, mockPositionFindMany, mockTradeAuditFindMany } = vi.hoisted(() => ({
  mockWalletFindUnique:   vi.fn(),
  mockPositionFindMany:   vi.fn().mockResolvedValue([]),
  mockTradeAuditFindMany: vi.fn().mockResolvedValue([]),
}));
vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    walletAccount: { findUnique: mockWalletFindUnique },
    position:      { findMany: mockPositionFindMany },
    tradeAudit:    { findMany: mockTradeAuditFindMany },
  },
}));

vi.mock("../market-data/position.valuation.js", () => ({
  liveNotional: vi.fn().mockReturnValue(0),
}));

const { varEngine } = await import("../risk-service/var.engine.js");

function decimalLike(n: number) {
  // var.engine.ts uses both `Number(wallet.balance)` (needs valueOf/
  // toString coercion, like real Prisma Decimal) and `.marginUsed.toNumber()`
  // (explicit call) -- support both.
  return { toNumber: () => n, valueOf: () => n, toString: () => String(n) };
}

function openPosition(marginUsed: number, pnl = 0) {
  return {
    pnl: decimalLike(pnl), marginUsed: decimalLike(marginUsed),
    quantity: decimalLike(100_000), entryPrice: decimalLike(1.1000), symbol: "EURUSD",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPositionFindMany.mockResolvedValue([]);
  mockTradeAuditFindMany.mockResolvedValue([]);
});

describe("VarEngine.computeVaR() — PHASE2_REMEDIATION (H5): marginUsed sourced from Position, not WalletAccount.locked", () => {
  it("computes marginLevel (day-0 forecast) from sum(Position.marginUsed), ignoring a WalletAccount.locked deficit", async () => {
    // locked=1,000 would understate real margin usage; the position's own
    // marginUsed (8,000) is the real driver, matching margin.controller.ts.
    mockWalletFindUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(1_000) });
    mockPositionFindMany.mockResolvedValue([openPosition(8_000)]);

    const report = await varEngine.computeVaR("user-1");

    const day0 = report.marginForecast.find((p) => p.daysAhead === 0)!;
    expect(day0.marginLevel).toBeCloseTo((10_000 / 8_000) * 100, 0);
    expect(day0.marginLevel).not.toBeCloseTo((10_000 / 1_000) * 100, 0);
  });

  it("matches margin.controller.ts's getMarginState() aggregate across multiple open positions", async () => {
    mockWalletFindUnique.mockResolvedValue({ balance: decimalLike(20_000), locked: decimalLike(1) }); // deliberately wrong
    mockPositionFindMany.mockResolvedValue([openPosition(3_000), openPosition(4_000)]);

    const report = await varEngine.computeVaR("user-1");

    const day0 = report.marginForecast.find((p) => p.daysAhead === 0)!;
    // sum(marginUsed) = 7,000
    expect(day0.marginLevel).toBeCloseTo((20_000 / 7_000) * 100, 0);
  });

  it("reports a stop_out risk zone when the position-sourced margin level is genuinely below 50%, not masked by a healthy locked value", async () => {
    mockWalletFindUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(100) }); // would look ultra-safe if used
    mockPositionFindMany.mockResolvedValue([openPosition(30_000)]); // real level = 10,000/30,000*100 ≈ 33%

    const report = await varEngine.computeVaR("user-1");

    const day0 = report.marginForecast.find((p) => p.daysAhead === 0)!;
    expect(day0.riskZone).toBe("stop_out");
  });
});
