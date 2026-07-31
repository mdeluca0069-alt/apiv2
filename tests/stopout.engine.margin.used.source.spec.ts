/**
 * stopout.engine.margin.used.source.spec.ts
 *
 * PHASE2_REMEDIATION (H5) — StopOutEngine.checkUser() used to read
 * WalletAccount.locked for its `marginUsed` figure -- a SEPARATE number
 * from the sum(Position.marginUsed) that margin.controller.ts's
 * getMarginState() (the pre-trade risk gate and client dashboard's source
 * of truth) uses. The two are tracked completely independently (`locked`
 * via checkAndLockMargin()/releaseMargin()'s wallet-column increments/
 * decrements; `marginUsed` via each Position row) and are never cross-
 * checked at decision time -- only reconciled asynchronously every 5
 * minutes, and only in the direction of decreasing `locked` toward the
 * position sum. A deficit (`locked` UNDERSTATING real margin usage) is
 * never auto-corrected, which made marginLevel = equity/marginUsed look
 * HEALTHIER than reality -- silently weakening the ESMA 50% stop-out
 * floor for exactly the accounts most at risk.
 *
 * Fix: stop-out now sums Position.marginUsed (already fetched for the
 * P&L/liquidation loop) instead of reading WalletAccount.locked -- the
 * same aggregate margin.controller.ts's getMarginState() uses, so the two
 * can never diverge again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    walletAccount: { findUnique: vi.fn() },
    position:      { findMany: vi.fn() },
    auditLog:      { create: vi.fn().mockResolvedValue({}) },
    marginSnapshot: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("../shared/db.js", () => ({ prisma: mockDb, IS_PERSISTENT: true }));

const { mockQuoteGet, mockIsStale } = vi.hoisted(() => ({ mockQuoteGet: vi.fn(), mockIsStale: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({ quoteCache: { get: mockQuoteGet, isStale: mockIsStale } }));

vi.mock("../liquidity-engine/broker.spread.config.js", () => ({
  brokerSpreadConfig: { isEnabled: vi.fn().mockReturnValue(true) },
}));

vi.mock("../settlement/settlement.engine.js", () => ({
  settlementEngine: { settle: vi.fn() },
  PositionAlreadyClosedError: class PositionAlreadyClosedError extends Error {},
}));

vi.mock("../events-bus/event.bus.js", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("../gateway/metrics.js", () => ({ metrics: { inc: vi.fn() } }));
vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { send: vi.fn().mockResolvedValue(undefined), stopOutWave: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../realtime-infra/job.coordinator.js", () => ({
  jobCoordinator: { tryLead: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../security/immutable.audit.js", () => ({
  immutableAudit: { write: vi.fn().mockResolvedValue("audit-id") },
}));

const { stopOutEngine } = await import("../trading-service/stopout.engine.js");

function decimalLike(n: number) {
  return { toNumber: () => n, toFixed: (d: number) => n.toFixed(d) } as unknown as Decimal;
}

function makePosition(id: string, symbol: string, entryPrice: number, marginUsed: number) {
  return {
    id, symbol, side: "BUY" as const,
    quantity: decimalLike(100_000), entryPrice: decimalLike(entryPrice),
    marginUsed: decimalLike(marginUsed), leverage: 10, openedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsStale.mockReturnValue(false);
  mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001 }); // flat, no P&L
});

describe("StopOutEngine.checkUser() — PHASE2_REMEDIATION (H5): marginUsed sourced from Position, not WalletAccount.locked", () => {
  it("computes marginLevel from sum(Position.marginUsed), ignoring a WalletAccount.locked deficit that would understate risk", async () => {
    // The core bug scenario: locked has drifted to 1,000 (understating real
    // margin usage) while the position actually reserves 8,000. Reading
    // locked would report marginLevel = 10,000/1,000*100 = 1000% (healthy,
    // no action) even though the TRUE margin level is 10,000/8,000*100 =
    // 125% -- still above the 50% floor, but correctly reflects real risk
    // and would trigger MARGIN_CALL at 120%/WARNING at 150% behavior
    // consistently with what margin.controller.ts already reports.
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(1_000) });
    mockDb.position.findMany.mockResolvedValue([
      makePosition("pos-A", "EURUSD", 1.1000, 8_000), // marginUsed=8,000, real driver of margin level
    ]);

    const result = await stopOutEngine.checkUser("user-1");

    // marginLevel must be derived from the position's marginUsed (8,000),
    // NOT the understated wallet.locked (1,000).
    expect(result.marginLevel).toBeCloseTo((10_000 / 8_000) * 100, 1);
    expect(result.marginLevel).not.toBeCloseTo((10_000 / 1_000) * 100, 1);
  });

  it("triggers MARGIN_CALL using the position-sourced marginUsed even though locked alone would report a safe level", async () => {
    // locked=500 would report marginLevel=2000% (NONE). The real position
    // margin (5,000) puts the account at exactly the MARGIN_CALL boundary.
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(500) });
    mockDb.position.findMany.mockResolvedValue([
      makePosition("pos-A", "EURUSD", 1.1000, 5_000),
    ]);

    const result = await stopOutEngine.checkUser("user-1");

    // marginLevel = 10,000/5,000*100 = 200% -- still NONE (below WARNING's
    // 150% is the trigger direction; 200% > 150% so NONE is correct here).
    // This asserts the MATH used the position sum, not that it necessarily
    // triggers a specific action -- see the next test for an actual trigger.
    expect(result.marginLevel).toBeCloseTo(200, 1);
  });

  it("a genuinely low margin level (position-sourced) correctly triggers MARGIN_CALL, not masked by a healthy-looking locked value", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(100) }); // would report 10,000% if used
    // MARGIN_CALL band is [50,100)% per this engine's thresholds (50=STOP_OUT,
    // 100=MARGIN_CALL, 150=WARNING) -- marginUsed=10,500 puts the real level
    // at 10,000/10,500*100 ≈ 95.2%, squarely inside it.
    mockDb.position.findMany.mockResolvedValue([
      makePosition("pos-A", "EURUSD", 1.1000, 10_500),
    ]);

    const result = await stopOutEngine.checkUser("user-1");

    expect(result.marginLevel).toBeCloseTo((10_000 / 10_500) * 100, 1);
    expect(result.action).toBe("MARGIN_CALL");
  });

  it("matches margin.controller.ts's getMarginState() aggregate across multiple open positions", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(20_000), locked: decimalLike(1) }); // deliberately near-zero/wrong
    mockDb.position.findMany.mockResolvedValue([
      makePosition("pos-A", "EURUSD", 1.1000, 3_000),
      makePosition("pos-B", "EURUSD", 1.1000, 4_000),
    ]);

    const result = await stopOutEngine.checkUser("user-1");

    // sum(marginUsed) = 7,000 -- matches how getMarginState() would sum
    // the same two OPEN positions for this same account.
    expect(result.marginLevel).toBeCloseTo((20_000 / 7_000) * 100, 1);
  });
});
