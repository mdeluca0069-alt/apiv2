/**
 * stopout.engine.circuit.breaker.spec.ts
 *
 * FASE 4.2 (Risk Engine, Bug #3) — StopOutEngine.checkUser() used to force-
 * close EVERY position once triggered, including ones whose symbol is
 * currently halted by the circuit breaker (or an admin) — liquidating a
 * client's position at exactly the anomalous price the halt exists to flag
 * as untrustworthy. Fix: skip a halted symbol's position within the same
 * liquidation sweep; other positions on non-halted symbols still close
 * normally, and the skip is reported back (skippedHalted).
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

const { mockIsEnabled } = vi.hoisted(() => ({ mockIsEnabled: vi.fn() }));
vi.mock("../liquidity-engine/broker.spread.config.js", () => ({
  brokerSpreadConfig: { isEnabled: mockIsEnabled },
}));

const { mockSettle, PositionAlreadyClosedError } = vi.hoisted(() => {
  class PositionAlreadyClosedError extends Error {}
  return { mockSettle: vi.fn(), PositionAlreadyClosedError };
});
vi.mock("../settlement/settlement.engine.js", () => ({
  settlementEngine: { settle: mockSettle },
  PositionAlreadyClosedError,
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

function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: "pos-1", symbol: "EURUSD", side: "BUY",
    quantity: decimalLike(100_000), entryPrice: decimalLike(1.2000),
    marginUsed: decimalLike(1_000), leverage: 10, openedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsEnabled.mockReturnValue(true);
  mockSettle.mockResolvedValue({ cappedPnl: -1_000 });
});

describe("StopOutEngine.checkUser() — circuit breaker position protection", () => {
  it("skips closing a position whose symbol is currently halted, even though margin level is below the stop-out floor", async () => {
    // balance=1,000, locked=1,000 → equity depends on unrealized pnl below
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(1_000), locked: decimalLike(1_000) });
    mockDb.position.findMany.mockResolvedValue([makePosition()]);
    // deep loss: (1.0000-1.2000)*100000 = -20,000 → equity deeply negative → well below 50%
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 });
    mockIsEnabled.mockReturnValue(false); // EURUSD halted

    const result = await stopOutEngine.checkUser("user-1");

    expect(result.action).toBe("STOP_OUT");
    expect(result.liquidated).toBe(0);
    expect(result.skippedHalted).toBe(1);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("still closes positions on non-halted symbols normally when triggered", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(1_000), locked: decimalLike(1_000) });
    mockDb.position.findMany.mockResolvedValue([makePosition()]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 });
    mockIsEnabled.mockReturnValue(true); // not halted

    const result = await stopOutEngine.checkUser("user-1");

    expect(result.action).toBe("STOP_OUT");
    expect(result.liquidated).toBe(1);
    expect(result.skippedHalted).toBe(0);
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  it("closes the non-halted position while skipping the halted one, for a user holding both", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(1_000), locked: decimalLike(2_000) });
    mockDb.position.findMany.mockResolvedValue([
      makePosition({ id: "pos-eur", symbol: "EURUSD", marginUsed: decimalLike(1_000) }),
      makePosition({ id: "pos-gbp", symbol: "GBPUSD", marginUsed: decimalLike(1_000) }),
    ]);
    mockQuoteGet.mockImplementation((symbol: string) =>
      symbol === "EURUSD"
        ? { symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 }
        : { symbol: "GBPUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 },
    );
    // Halt only EURUSD.
    mockIsEnabled.mockImplementation((symbol: string) => symbol !== "EURUSD");

    const result = await stopOutEngine.checkUser("user-1");

    expect(result.liquidated).toBe(1);
    expect(result.skippedHalted).toBe(1);
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockSettle.mock.calls[0][0].symbol).toBe("GBPUSD");
  });

  it("does not evaluate the halt at all when margin level is healthy (no stop-out triggered)", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(500) });
    mockDb.position.findMany.mockResolvedValue([makePosition({ marginUsed: decimalLike(500) })]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.2000, ask: 1.2002, mid: 1.2001 }); // no loss

    const result = await stopOutEngine.checkUser("user-1");

    expect(result.action).toBe("NONE");
    expect(mockIsEnabled).not.toHaveBeenCalled();
  });
});
