/**
 * position.price.monitor.reconcile.spec.ts
 *
 * MARKET_DATA_FREEZE.md §0.3 — PositionPriceMonitor's _onPositionOpened()
 * used to wrap its DB read in a try/catch that swallowed ANY error
 * (network blip, pool exhaustion, timeout) with a comment claiming the
 * position "will be loaded on next full refresh" -- false, since the only
 * full refresh (_loadPositions()) runs once, at process start. A position
 * that failed to load this way never entered positionCache, so its
 * Position.markPrice/pnl DB columns (read by exposure.analytics.ts,
 * client.exposure.limits.ts, concentration.guard.ts, var.engine.ts,
 * portfolio.intelligence.ts) stayed frozen at creation-time values forever.
 *
 * Proves: (1) the awaited addPosition() path (order.controller.ts) now
 * lets a DB failure propagate instead of swallowing it, so the existing
 * CRITICAL/WARNING alert path in order.controller.ts actually fires; (2)
 * the fire-and-forget position.opened event listener still never throws
 * (would be an unhandled rejection); (3) the new reconcile() sweep finds
 * and loads any OPEN position missing from the cache, self-healing within
 * one sweep interval instead of "forever."
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockFindUnique, mockFindMany } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockFindMany:   vi.fn().mockResolvedValue([]),
}));
vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: { position: { findUnique: mockFindUnique, findMany: mockFindMany }, walletAccount: { findMany: vi.fn().mockResolvedValue([]) } },
}));

const { mockOn, mockEmit, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (evt: unknown) => void>();
  return {
    handlers,
    mockOn:   vi.fn((event: string, cb: (evt: unknown) => void) => { handlers.set(event, cb); }),
    mockEmit: vi.fn(),
  };
});
vi.mock("../events-bus/event.bus.js", () => ({ eventBus: { on: mockOn, emit: mockEmit } }));

vi.mock("../settlement/settlement.engine.js", () => ({
  settlementEngine: { settle: vi.fn() },
  PositionAlreadyClosedError: class PositionAlreadyClosedError extends Error {},
}));
vi.mock("../trading-service/stopout.engine.js", () => ({
  stopOutEngine: { checkUser: vi.fn().mockResolvedValue({ action: "NONE" }) },
}));
vi.mock("../gateway/metrics.js", () => ({ metrics: { inc: vi.fn() } }));
vi.mock("../liquidity-engine/broker.spread.config.js", () => ({
  brokerSpreadConfig: { isEnabled: vi.fn().mockReturnValue(true) },
}));

const { PositionPriceMonitor } = await import("../trading-service/position.price.monitor.js");

function decimalLike(n: number) {
  return { toNumber: () => n } as unknown as Decimal;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
});

function openPositionRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, userId: "user-1", symbol: "EURUSD", side: "BUY",
    quantity: decimalLike(100_000), entryPrice: decimalLike(1.1000), markPrice: decimalLike(1.1000),
    pnl: decimalLike(0), pnlPercent: decimalLike(0), marginUsed: decimalLike(1_000), leverage: 10,
    stopLoss: null, takeProfit: null, openedAt: new Date(), status: "OPEN",
    ...overrides,
  };
}

describe("PositionPriceMonitor.addPosition() — propagates a DB failure instead of swallowing it", () => {
  it("throws when the DB read fails, instead of silently no-op'ing", async () => {
    const monitor = new PositionPriceMonitor();
    await monitor.start();

    mockFindUnique.mockRejectedValueOnce(new Error("connection pool exhausted"));

    await expect(monitor.addPosition("pos-fail")).rejects.toThrow("connection pool exhausted");
    expect(monitor.getStats().trackedPositions).toBe(0);
  });

  it("still succeeds normally when the DB read works", async () => {
    const monitor = new PositionPriceMonitor();
    await monitor.start();
    mockFindUnique.mockResolvedValueOnce(openPositionRow("pos-ok"));

    await monitor.addPosition("pos-ok");
    expect(monitor.getStats().trackedPositions).toBe(1);
  });
});

describe("PositionPriceMonitor — fire-and-forget position.opened listener never throws", () => {
  it("logs but does not reject when the DB read fails on the event path", async () => {
    const monitor = new PositionPriceMonitor();
    await monitor.start();

    mockFindUnique.mockRejectedValueOnce(new Error("transient DB error"));

    const listener = handlers.get("position.opened")!;
    expect(listener).toBeDefined();
    // Must not throw synchronously and must not produce an unhandled rejection.
    expect(() => listener({ positionId: "pos-evt-fail", userId: "user-1" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget promise settle
    expect(monitor.getStats().trackedPositions).toBe(0);
  });
});

describe("PositionPriceMonitor.reconcile() — self-heals a dropped position", () => {
  it("loads an OPEN position that's missing from the cache", async () => {
    const monitor = new PositionPriceMonitor();
    await monitor.start();

    mockFindMany.mockResolvedValueOnce([{ id: "pos-missing" }]);
    mockFindUnique.mockResolvedValueOnce(openPositionRow("pos-missing"));

    const result = await monitor.reconcile();

    expect(result).toEqual({ scanned: 1, added: 1 });
    expect(monitor.getStats().trackedPositions).toBe(1);
  });

  it("skips a position already tracked in the cache", async () => {
    const monitor = new PositionPriceMonitor();
    await monitor.start();
    mockFindUnique.mockResolvedValueOnce(openPositionRow("pos-cached"));
    await monitor.addPosition("pos-cached");

    mockFindMany.mockResolvedValueOnce([{ id: "pos-cached" }]);
    const result = await monitor.reconcile();

    expect(result).toEqual({ scanned: 1, added: 0 });
    expect(mockFindUnique).toHaveBeenCalledTimes(1); // only the original addPosition() call
  });

  it("continues scanning after one position fails to load", async () => {
    const monitor = new PositionPriceMonitor();
    await monitor.start();

    mockFindMany.mockResolvedValueOnce([{ id: "pos-bad" }, { id: "pos-good" }]);
    mockFindUnique
      .mockRejectedValueOnce(new Error("still down"))
      .mockResolvedValueOnce(openPositionRow("pos-good"));

    const result = await monitor.reconcile();

    expect(result).toEqual({ scanned: 2, added: 1 });
    expect(monitor.getStats().trackedPositions).toBe(1);
  });
});
