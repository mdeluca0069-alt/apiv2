/**
 * stopout.engine.minimal.liquidation.spec.ts
 *
 * FASE 4.2 (Risk Engine, Bug #4) — StopOutEngine.checkUser() used to
 * unconditionally close EVERY open position once triggered. ESMA's actual
 * rule (Product Intervention Decision 2018/796) is to close "one or more...
 * on terms most favourable to the client" -- i.e. the minimal necessary
 * closure, largest loss first, stopping once margin level recovers to the
 * 50% floor. Needlessly closing profitable/small-loss positions the client
 * didn't choose to exit crystallises P&L and charges avoidable commission.
 *
 * Fix: re-check margin level after each closure (tracked incrementally from
 * the settlement result, no extra DB round trip) and stop as soon as it has
 * recovered to STOP_OUT_PCT.
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

const { mockQuoteGet } = vi.hoisted(() => ({ mockQuoteGet: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({ quoteCache: { get: mockQuoteGet } }));

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

/** Settles at a capped P&L equal to the position's own margin (NBP), and
 *  reports newBalance as balance-so-far minus that closure's capped loss --
 *  mirrors what settlement.engine.ts's settle() actually returns. */
function makeSettleMock(startingBalance: number, marginByPositionId: Record<string, number>) {
  let runningBalance = startingBalance;
  return vi.fn(async (input: { positionId: string }) => {
    const margin = marginByPositionId[input.positionId];
    const cappedPnl = -margin; // full loss of margin, NBP-capped
    runningBalance += cappedPnl;
    return { cappedPnl, newBalance: decimalLike(runningBalance) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StopOutEngine.checkUser() — minimal necessary liquidation", () => {
  it("stops after closing only the largest-loss position once margin level recovers, sparing a small-loss position", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(6_000) });
    mockDb.position.findMany.mockResolvedValue([
      makePosition("pos-A", "EURUSD", 1.9000, 3_000), // will show a huge loss
      makePosition("pos-B", "GBPUSD", 1.1001, 3_000),  // will show a tiny loss
    ]);
    mockQuoteGet.mockImplementation((symbol: string) =>
      symbol === "EURUSD"
        ? { symbol: "EURUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001 } // (1.1000-1.9000)*100000 = -80,000 (huge)
        : { symbol: "GBPUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001 }, // (1.1000-1.1001)*100000 = -10 (tiny)
    );
    mockSettle.mockImplementation(makeSettleMock(10_000, { "pos-A": 3_000, "pos-B": 3_000 }));

    const result = await stopOutEngine.checkUser("user-1");

    expect(result.action).toBe("STOP_OUT");
    expect(result.liquidated).toBe(1);
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockSettle.mock.calls[0][0].positionId).toBe("pos-A"); // largest loss closed first
  });

  it("closes a second position when the first alone doesn't recover margin level above the floor", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(9_000) });
    mockDb.position.findMany.mockResolvedValue([
      makePosition("pos-A", "EURUSD", 1.1600, 3_000), // (1.1000-1.1600)*100000 = -6,000
      makePosition("pos-B", "GBPUSD", 1.1500, 3_000), // (1.1000-1.1500)*100000 = -5,000
      makePosition("pos-C", "AUDUSD", 1.1001, 3_000), // (1.1000-1.1001)*100000 = -10 (tiny)
    ]);
    mockQuoteGet.mockImplementation((symbol: string) => ({ symbol, bid: 1.1000, ask: 1.1002, mid: 1.1001 }));
    mockSettle.mockImplementation(makeSettleMock(10_000, { "pos-A": 3_000, "pos-B": 3_000, "pos-C": 3_000 }));

    const result = await stopOutEngine.checkUser("user-1");

    expect(result.action).toBe("STOP_OUT");
    expect(result.liquidated).toBe(2);
    expect(mockSettle).toHaveBeenCalledTimes(2);
    const closedIds = mockSettle.mock.calls.map((c) => c[0].positionId);
    expect(closedIds).toEqual(["pos-A", "pos-B"]); // largest two losses, C spared
  });

  it("closes every position when even full liquidation doesn't recover above the floor (deeply negative equity)", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(1_000), locked: decimalLike(9_000) });
    mockDb.position.findMany.mockResolvedValue([
      makePosition("pos-A", "EURUSD", 1.1600, 3_000),
      makePosition("pos-B", "GBPUSD", 1.1500, 3_000),
      makePosition("pos-C", "AUDUSD", 1.1400, 3_000),
    ]);
    mockQuoteGet.mockImplementation((symbol: string) => ({ symbol, bid: 1.1000, ask: 1.1002, mid: 1.1001 }));
    mockSettle.mockImplementation(makeSettleMock(1_000, { "pos-A": 3_000, "pos-B": 3_000, "pos-C": 3_000 }));

    const result = await stopOutEngine.checkUser("user-1");

    expect(result.action).toBe("STOP_OUT");
    expect(result.liquidated).toBe(3);
    expect(mockSettle).toHaveBeenCalledTimes(3);
  });
});
