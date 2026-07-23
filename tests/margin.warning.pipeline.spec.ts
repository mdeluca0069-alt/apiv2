/**
 * margin.warning.pipeline.spec.ts
 *
 * REALTIME_FREEZE.md Critical #1 — the margin pre-warning pipeline was dead
 * end-to-end. `stopout.engine.ts` emitted `"risk.margin_call"` for
 * MARGIN_CALL (zero listeners anywhere) and nothing at all for WARNING
 * (only a direct, hand-rolled `db.notification.create()` bypassing eventBus
 * entirely); `main.ts`/`notification.router.ts` both listened for
 * `"margin.warning"` (zero producers anywhere). Two broken halves of two
 * different pipelines that looked wired at a glance.
 *
 * Fix: a single canonical `"margin.warning"` event, disambiguated by its
 * own `threshold` field ("WARNING" | "MARGIN_CALL" | "STOP_OUT"), emitted
 * by stopout.engine.ts for all three ESMA thresholds and consumed by both
 * main.ts's WS bridge (unchanged — already listened for this exact name)
 * and notification.router.ts's own listener (updated to produce
 * threshold-aware copy/priority).
 *
 * This uses the REAL eventBus (not mocked, same pattern as
 * notification.router.autopilot.spec.ts) so the producer
 * (stopout.engine.ts) and consumer (notification.router.ts) are proven
 * wired to each other end-to-end, not just each independently correct
 * against a mock. WARNING and MARGIN_CALL were previously completely
 * unproven by any test, since the event never fired for them; STOP_OUT's
 * emission is separately covered by stopout.engine.observability.spec.ts.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { eventBus } from "../events-bus/event.bus.js";
import { notificationRouter } from "../notification-service/notification.router.js";

function makePosition(id: string, symbol: string, entryPrice: number, marginUsed: number) {
  return {
    id, symbol, side: "BUY" as const,
    quantity: decimalLike(100_000), entryPrice: decimalLike(entryPrice),
    marginUsed: decimalLike(marginUsed), leverage: 10, openedAt: new Date(),
  };
}

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    walletAccount:  { findUnique: vi.fn() },
    position:       { findMany: vi.fn() },
    // findFirst backs immutableAudit.write()'s chain-head lookup;
    // $executeRaw backs its advisory-lock acquisition (pg_advisory_xact_lock
    // returns void, which $queryRaw cannot deserialize); $transaction lets
    // it run standalone (no tx passed) by invoking the callback against
    // this same mock object, which also satisfies the `Db` shape it expects.
    auditLog:       { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
    marginSnapshot: { create: vi.fn().mockResolvedValue({}) },
    $executeRaw:    vi.fn().mockResolvedValue(0),
    $transaction:   vi.fn((cb: (tx: unknown) => unknown) => cb(mockDb)),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sendAllSpy: any;

beforeAll(() => {
  sendAllSpy = vi.spyOn(notificationRouter, "sendAll").mockResolvedValue(undefined);
  notificationRouter.subscribe();
});

beforeEach(() => {
  sendAllSpy.mockClear();
  mockIsStale.mockReturnValue(false);
});

describe("stopout.engine.ts -> real eventBus -> notification.router.ts, per threshold", () => {
  it("WARNING (150% floor): emits margin.warning(threshold=WARNING), router dispatches with HIGH priority", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(700), locked: decimalLike(500) });
    mockDb.position.findMany.mockResolvedValue([makePosition("pos-1", "EURUSD", 1.1000, 500)]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001 });
    mockIsStale.mockReturnValue(true); // pnl falls back to 0 -- isolates the margin-level arithmetic
    // equity=balance=700 (pnl=0), marginLevel = 700/500*100 = 140% -> WARNING band (100-150)

    const result = await stopOutEngine.checkUser("user-warning");

    expect(result.action).toBe("WARNING");
    expect(sendAllSpy).toHaveBeenCalledWith(
      "user-warning", "margin", "HIGH",
      "Margin Warning",
      expect.stringContaining("140%"),
      expect.objectContaining({ threshold: "WARNING" }),
    );
  });

  it("MARGIN_CALL (100% floor): emits margin.warning(threshold=MARGIN_CALL), router dispatches with CRITICAL priority", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(490), locked: decimalLike(500) });
    mockDb.position.findMany.mockResolvedValue([makePosition("pos-1", "EURUSD", 1.1000, 500)]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001 });
    mockIsStale.mockReturnValue(true);
    // marginLevel = 490/500*100 = 98% -> MARGIN_CALL band (50-100)

    const result = await stopOutEngine.checkUser("user-margincall");

    expect(result.action).toBe("MARGIN_CALL");
    expect(sendAllSpy).toHaveBeenCalledWith(
      "user-margincall", "margin", "CRITICAL",
      "Margin Call",
      expect.stringContaining("98%"),
      expect.objectContaining({ threshold: "MARGIN_CALL" }),
    );
  });

  it("never fires margin.warning above the 150% WARNING floor", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: decimalLike(1_000), locked: decimalLike(500) });
    mockDb.position.findMany.mockResolvedValue([]);
    // marginLevel = 200% -> NONE

    const result = await stopOutEngine.checkUser("user-healthy");

    expect(result.action).toBe("NONE");
    expect(sendAllSpy).not.toHaveBeenCalled();
  });
});

describe("notification.router.ts — margin.warning listener, direct eventBus.emit coverage", () => {
  it("STOP_OUT payload -> CRITICAL priority, body mentions positions closed and net P&L", () => {
    eventBus.emit("margin.warning", {
      userId: "u3", marginLevelPct: 33, freeMargin: 0, equity: 330, marginUsed: 1000,
      threshold: "STOP_OUT", timestamp: new Date().toISOString(),
      positionsClosed: 2, totalPnl: -670,
    });

    expect(sendAllSpy).toHaveBeenCalledWith(
      "u3", "margin", "CRITICAL",
      "Stop-Out Triggered",
      expect.stringMatching(/2 position\(s\).*-670\.00/),
      expect.objectContaining({ threshold: "STOP_OUT" }),
    );
  });
});
