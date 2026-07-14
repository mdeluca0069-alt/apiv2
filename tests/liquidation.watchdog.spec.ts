/**
 * liquidation.watchdog.spec.ts
 *
 * FASE 2.5 — Core Trading Certification (frozen constraint #2).
 *
 * Proves LiquidationEngine.scanForMissedSlTp() behaves as a periodic
 * recovery watchdog, not a second real-time engine: it only acts on
 * positions with a stopLoss/takeProfit set, only evaluates them against a
 * fresh (non-stale) quote, correctly detects SL/TP hits for both BUY and
 * SELL, and a PositionAlreadyClosedError from a race with the tick-level
 * monitor is a silent no-op, not a thrown error that would abort the sweep.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    position: { findMany: vi.fn() },
  };
  return { mockDb };
});
vi.mock("../shared/db.js", () => ({ prisma: mockDb, IS_PERSISTENT: true }));

const { mockQuoteCache } = vi.hoisted(() => ({
  mockQuoteCache: { get: vi.fn(), isStale: vi.fn() },
}));
vi.mock("../market-data/quote.cache.js", () => ({ quoteCache: mockQuoteCache }));

const { mockIsEnabled } = vi.hoisted(() => ({ mockIsEnabled: vi.fn() }));
vi.mock("../liquidity-engine/broker.spread.config.js", () => ({
  brokerSpreadConfig: { isEnabled: mockIsEnabled },
}));

const { mockSettle, PositionAlreadyClosedError } = vi.hoisted(() => {
  class PositionAlreadyClosedError extends Error {
    constructor(public readonly positionId: string, public readonly status: string) {
      super(`POSITION_NOT_OPEN:${positionId}:${status}`);
      this.name = "PositionAlreadyClosedError";
    }
  }
  return { mockSettle: vi.fn(), PositionAlreadyClosedError };
});
vi.mock("../settlement/settlement.engine.js", () => ({
  settlementEngine: { settle: mockSettle },
  PositionAlreadyClosedError,
}));

vi.mock("../liquidity-engine/liquidity.provider.js", () => ({
  LiquidityProvider: {
    buildBook: vi.fn().mockReturnValue({}),
    calculateFillFromBook: vi.fn().mockReturnValue({ averagePrice: 1.0870, slippage: 0, fees: 0 }),
  },
}));

const { liquidationEngine } = await import("../risk-service/liquidation.engine.js");

const QUOTE = { symbol: "EURUSD", bid: 1.0850, ask: 1.0852, mid: 1.0851, spread: 0.0002, changePct: 0.1, ts: new Date().toISOString() };

function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: "pos-1", userId: "user-1", symbol: "EURUSD", side: "BUY",
    quantity: new Decimal(10_000), entryPrice: new Decimal(1.0900),
    marginUsed: new Decimal(100), leverage: 10, openedAt: new Date(),
    stopLoss: new Decimal(1.0860), takeProfit: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuoteCache.get.mockReturnValue(QUOTE);
  mockQuoteCache.isStale.mockReturnValue(false);
  mockIsEnabled.mockReturnValue(true);
  mockSettle.mockResolvedValue({ cappedPnl: -40 });
});

describe("LiquidationEngine.scanForMissedSlTp()", () => {
  it("does nothing when no open position has a stopLoss/takeProfit set", async () => {
    mockDb.position.findMany.mockResolvedValue([]);

    const report = await liquidationEngine.scanForMissedSlTp();

    expect(report).toEqual({ scanned: 0, closed: 0, skippedStale: 0, skippedHalted: 0 });
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("only queries positions with stopLoss or takeProfit set", async () => {
    mockDb.position.findMany.mockResolvedValue([]);

    await liquidationEngine.scanForMissedSlTp();

    const call = mockDb.position.findMany.mock.calls[0][0];
    expect(call.where.status).toBe("OPEN");
    expect(call.where.OR).toEqual([
      { stopLoss: { not: null } }, { takeProfit: { not: null } },
    ]);
  });

  it("BUY position: closes as STOP_LOSS when bid has dropped to or below the stop-loss price", async () => {
    mockDb.position.findMany.mockResolvedValue([makePosition({ stopLoss: new Decimal(1.0860) })]);
    // QUOTE.bid = 1.0850 <= stopLoss 1.0860 → hit

    const report = await liquidationEngine.scanForMissedSlTp();

    expect(report).toEqual({ scanned: 1, closed: 1, skippedStale: 0, skippedHalted: 0 });
    expect(mockSettle).toHaveBeenCalledTimes(1);
    const settleArg = mockSettle.mock.calls[0][0];
    expect(settleArg.reason).toBe("STOP_LOSS");
    expect(settleArg.detail).toMatch(/Watchdog recovery/);
  });

  it("SELL position: closes as TAKE_PROFIT when ask has dropped to or below the take-profit price", async () => {
    mockDb.position.findMany.mockResolvedValue([
      makePosition({ side: "SELL", stopLoss: null, takeProfit: new Decimal(1.0855) }),
    ]);
    // QUOTE.ask = 1.0852 <= takeProfit 1.0855 → hit

    const report = await liquidationEngine.scanForMissedSlTp();

    expect(report).toEqual({ scanned: 1, closed: 1, skippedStale: 0, skippedHalted: 0 });
    expect(mockSettle.mock.calls[0][0].reason).toBe("TAKE_PROFIT");
  });

  it("does not close a position whose SL/TP has not been reached", async () => {
    mockDb.position.findMany.mockResolvedValue([
      makePosition({ stopLoss: new Decimal(1.0500), takeProfit: new Decimal(1.2000) }),
    ]);
    // bid 1.0850 is between SL 1.0500 and TP 1.2000 — neither hit

    const report = await liquidationEngine.scanForMissedSlTp();

    expect(report).toEqual({ scanned: 1, closed: 0, skippedStale: 0, skippedHalted: 0 });
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("skips a position whose symbol has no quote or a stale quote — never evaluates SL/TP against a stale price", async () => {
    mockDb.position.findMany.mockResolvedValue([makePosition()]);
    mockQuoteCache.isStale.mockReturnValue(true);

    const report = await liquidationEngine.scanForMissedSlTp();

    expect(report).toEqual({ scanned: 1, closed: 0, skippedStale: 1, skippedHalted: 0 });
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("FASE 4.2 Bug #3: skips a position whose symbol is currently halted, even with a fresh quote and a hit SL", async () => {
    mockDb.position.findMany.mockResolvedValue([makePosition({ stopLoss: new Decimal(1.0860) })]);
    // QUOTE.bid = 1.0850 <= stopLoss 1.0860 → would hit, but the symbol is halted
    mockIsEnabled.mockReturnValue(false);

    const report = await liquidationEngine.scanForMissedSlTp();

    expect(report).toEqual({ scanned: 1, closed: 0, skippedStale: 0, skippedHalted: 1 });
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("a PositionAlreadyClosedError (race with the tick-level monitor) is a silent no-op, not a thrown error", async () => {
    mockDb.position.findMany.mockResolvedValue([
      makePosition({ id: "pos-1" }),
      makePosition({ id: "pos-2", stopLoss: new Decimal(1.0500), takeProfit: new Decimal(1.2000) }),
    ]);
    mockSettle.mockRejectedValueOnce(new PositionAlreadyClosedError("pos-1", "STOP_LOSS"));

    const report = await liquidationEngine.scanForMissedSlTp();

    // Does not throw, and the second (unrelated, not-hit) position is still scanned.
    expect(report.scanned).toBe(2);
    expect(mockSettle).toHaveBeenCalledTimes(1); // second position's SL/TP wasn't hit, never called
  });
});
