/**
 * stopout.engine.observability.spec.ts
 *
 * FASE 5.2 (Ledger, Bug #11, LEDGER_FREEZE.md §0.11) — three distinct
 * observability defects in StopOutEngine.checkUser()'s STOP_OUT branch:
 *
 *   1. stop_out_events_total was incremented once per user-scan HERE, and
 *      separately once per POSITION in settlement.engine.ts -- same name,
 *      two different units. Renamed this file's counter to
 *      stop_out_episodes_total.
 *   2. The stop_out.triggered AuditLog summary write was unguarded; a
 *      failure vanished into scanAll()'s errors array, which its only
 *      caller (main.ts) never read. Now wrapped in try/catch with a
 *      dedicated failure metric and a CRITICAL alert.
 *   3. _notify() never fired for the STOP_OUT branch itself -- the client
 *      got only the generic per-position "Position closed" notice, never a
 *      dedicated "you were stopped out" message. Now fires when liquidated > 0.
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

const { mockEmit } = vi.hoisted(() => ({ mockEmit: vi.fn() }));
vi.mock("../events-bus/event.bus.js", () => ({ eventBus: { emit: mockEmit } }));

const { mockMetricsInc } = vi.hoisted(() => ({ mockMetricsInc: vi.fn() }));
vi.mock("../gateway/metrics.js", () => ({ metrics: { inc: mockMetricsInc } }));

const { mockAlertSend } = vi.hoisted(() => ({ mockAlertSend: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { send: mockAlertSend, stopOutWave: vi.fn().mockResolvedValue(undefined) },
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

function makeSettleMock(startingBalance: number, marginByPositionId: Record<string, number>) {
  let runningBalance = startingBalance;
  return vi.fn(async (input: { positionId: string }) => {
    const margin = marginByPositionId[input.positionId];
    const cappedPnl = -margin;
    runningBalance += cappedPnl;
    return { cappedPnl, newBalance: decimalLike(runningBalance) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsStale.mockReturnValue(false);
});

describe("StopOutEngine.checkUser() — metric disambiguation (Bug #11)", () => {
  it("increments stop_out_episodes_total exactly once regardless of how many positions were closed", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(9_000) });
    mockDb.position.findMany.mockResolvedValue([
      makePosition("pos-A", "EURUSD", 1.1600, 3_000),
      makePosition("pos-B", "GBPUSD", 1.1500, 3_000),
      makePosition("pos-C", "AUDUSD", 1.1001, 3_000),
    ]);
    mockQuoteGet.mockImplementation((symbol: string) => ({ symbol, bid: 1.1000, ask: 1.1002, mid: 1.1001 }));
    mockSettle.mockImplementation(makeSettleMock(10_000, { "pos-A": 3_000, "pos-B": 3_000, "pos-C": 3_000 }));

    const result = await stopOutEngine.checkUser("user-1");

    expect(result.liquidated).toBe(2); // two positions closed, one episode
    const episodeCalls = mockMetricsInc.mock.calls.filter((c) => c[0] === "stop_out_episodes_total");
    expect(episodeCalls).toHaveLength(1);
    // The old ambiguous name must never be incremented from this file again.
    expect(mockMetricsInc).not.toHaveBeenCalledWith("stop_out_events_total");
  });
});

describe("StopOutEngine.checkUser() — audit write failure is visible, not silently swallowed (Bug #11)", () => {
  it("does not throw, increments a dedicated failure metric, and sends a CRITICAL alert when the summary AuditLog write fails", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(6_000) });
    mockDb.position.findMany.mockResolvedValue([makePosition("pos-A", "EURUSD", 1.9000, 3_000)]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001 });
    mockSettle.mockImplementation(makeSettleMock(10_000, { "pos-A": 3_000 }));
    mockDb.auditLog.create.mockRejectedValueOnce(new Error("transient DB error"));

    const result = await stopOutEngine.checkUser("user-1"); // must not throw

    expect(result.action).toBe("STOP_OUT");
    expect(result.liquidated).toBe(1); // the liquidation itself still succeeded
    expect(mockMetricsInc).toHaveBeenCalledWith("stop_out_audit_write_failures_total");
    expect(mockAlertSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "STOP_OUT", severity: "CRITICAL",
    }));
  });
});

describe("StopOutEngine.checkUser() — dedicated stop-out notification (Bug #11)", () => {
  it("creates a dedicated STOP_OUT notification when at least one position was liquidated", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(10_000), locked: decimalLike(6_000) });
    mockDb.position.findMany.mockResolvedValue([makePosition("pos-A", "EURUSD", 1.9000, 3_000)]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001 });
    mockSettle.mockImplementation(makeSettleMock(10_000, { "pos-A": 3_000 }));

    await stopOutEngine.checkUser("user-1");

    expect(mockDb.notification.create).toHaveBeenCalledTimes(1);
    const call = mockDb.notification.create.mock.calls[0][0].data as { title: string; body: string; priority: string };
    expect(call.title).toBe("Stop-Out Triggered");
    expect(call.body).toContain("1 position(s)");
    expect(call.priority).toBe("CRITICAL");
  });

  it("does NOT create a notification when nothing was actually closed (e.g. all positions skipped)", async () => {
    // balance/locked chosen so margin level is below the STOP_OUT floor even
    // with pnl=0 (the staleness fallback) -- otherwise the STOP_OUT branch
    // is never entered at all and this test would prove nothing.
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(1_000), locked: decimalLike(3_000) });
    mockDb.position.findMany.mockResolvedValue([makePosition("pos-A", "EURUSD", 1.9000, 3_000)]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001 });
    mockIsStale.mockReturnValue(true); // skipped for staleness -> liquidated stays 0

    const result = await stopOutEngine.checkUser("user-1");

    expect(result.action).toBe("STOP_OUT");
    expect(result.liquidated).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });
});
