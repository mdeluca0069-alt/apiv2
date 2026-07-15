/**
 * stopout.engine.stale.quote.spec.ts
 *
 * FASE 4.2 (Risk Engine, Bug #5) — StopOutEngine.checkUser() used
 * quoteCache.get() directly with no quoteCache.isStale() check at all
 * (unlike the SL/TP watchdog, which does check), and passed that same
 * potentially-stale price straight through as the exit price to
 * settlementEngine.settle() -- if the feed silently died, stop-out would
 * still force-liquidate at whatever price was last cached, however old.
 *
 * Fix: a stale (or entirely missing) quote is treated the same as the
 * pre-existing missing-quote fallback for the margin-level estimate
 * (pnl=0, markPrice=entryPrice -- unknown, not fabricated), and the
 * position is skipped entirely in the liquidation loop rather than closed
 * at an untrustworthy price.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    walletAccount: { findUnique: vi.fn() },
    position:      { findMany: vi.fn() },
    auditLog:      { create: vi.fn().mockResolvedValue({}) },
    marginSnapshot: { create: vi.fn().mockResolvedValue({}) },
    notification:  { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("../shared/db.js", () => ({ prisma: mockDb, IS_PERSISTENT: true }));

const { mockQuoteGet, mockIsStale } = vi.hoisted(() => ({ mockQuoteGet: vi.fn(), mockIsStale: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({ quoteCache: { get: mockQuoteGet, isStale: mockIsStale } }));

vi.mock("../liquidity-engine/broker.spread.config.js", () => ({
  brokerSpreadConfig: { isEnabled: vi.fn().mockReturnValue(true) },
}));

const { mockSettle } = vi.hoisted(() => ({ mockSettle: vi.fn() }));
vi.mock("../settlement/settlement.engine.js", () => ({
  settlementEngine: { settle: mockSettle },
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
  mockSettle.mockResolvedValue({ cappedPnl: 0, newBalance: decimalLike(0) });
});

describe("StopOutEngine.checkUser() — stale quote protection", () => {
  it("never settles a position whose quote is stale, even when margin level is deep below the floor", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(1_000), locked: decimalLike(3_000) });
    mockDb.position.findMany.mockResolvedValue([makePosition("pos-1", "EURUSD", 1.9000, 3_000)]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001 });
    mockIsStale.mockReturnValue(true); // feed died, last cached quote is stale

    const result = await stopOutEngine.checkUser("user-1");

    // Because the stale position's P&L falls back to 0 (unknown, not
    // fabricated), equity=balance=1000, marginLevel=1000/3000*100=33.3% <50%.
    expect(result.action).toBe("STOP_OUT");
    expect(result.liquidated).toBe(0);
    expect(result.skippedStale).toBe(1);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("treats a completely missing quote the same as a stale one", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(1_000), locked: decimalLike(3_000) });
    mockDb.position.findMany.mockResolvedValue([makePosition("pos-1", "EURUSD", 1.9000, 3_000)]);
    mockQuoteGet.mockReturnValue(undefined); // no quote at all

    const result = await stopOutEngine.checkUser("user-1");

    expect(result.liquidated).toBe(0);
    expect(result.skippedStale).toBe(1);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("still liquidates a position with a fresh quote while skipping a stale one for the same user", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(1_000), locked: decimalLike(6_000) });
    mockDb.position.findMany.mockResolvedValue([
      makePosition("pos-stale", "EURUSD", 1.9000, 3_000),
      makePosition("pos-fresh", "GBPUSD", 1.9000, 3_000),
    ]);
    mockQuoteGet.mockImplementation((symbol: string) =>
      symbol === "EURUSD"
        ? { symbol: "EURUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001 }
        : { symbol: "GBPUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001 },
    );
    mockIsStale.mockImplementation((symbol: string) => symbol === "EURUSD"); // only EURUSD's feed is dead
    mockSettle.mockResolvedValue({ cappedPnl: -3_000, newBalance: decimalLike(0) });

    const result = await stopOutEngine.checkUser("user-1");

    expect(result.skippedStale).toBe(1);
    expect(result.liquidated).toBe(1);
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockSettle.mock.calls[0][0].symbol).toBe("GBPUSD");
  });

  it("a stale position never contributes fabricated P&L to the margin-level computation", async () => {
    // Healthy balance/margin except for one stale position that WOULD show
    // a huge loss if its cached (stale) price were trusted -- it must not
    // push the account into stop-out based on an untrustworthy number.
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(1_000) });
    mockDb.position.findMany.mockResolvedValue([makePosition("pos-1", "EURUSD", 1.9000, 1_000)]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001 }); // would be -80,000 if trusted
    mockIsStale.mockReturnValue(true);

    const result = await stopOutEngine.checkUser("user-1");

    // equity falls back to balance alone (10,000), marginLevel=10,000/1,000*100=1000% → healthy
    expect(result.action).toBe("NONE");
    expect(mockSettle).not.toHaveBeenCalled();
  });
});
