/**
 * signal.telemetry.exit.reason.spec.ts
 *
 * FASE 7 CLOSURE, Phase C — re-verifying REALTIME_FREEZE.md M.4's fix
 * (exitReason was permanently stuck at "MANUAL" because `reason` arrived
 * on a "trade.closed" event nothing ever emitted) surfaced a second, more
 * subtle bug in the same code path: the `position.closed` listener
 * pre-mapped `ev.reason` through a local `_mapReason()` helper before
 * calling updateOutcome(), which ALSO maps `data.exitReason` via its own
 * `exitReasonMap`. Feeding an already-mapped value ("SL_HIT") back through
 * a lookup table keyed by the raw enum ("STOP_LOSS") missed on every
 * entry and silently fell through to `?? data.exitReason` -- happened to
 * be a no-op for all 6 real values only because the map is a fixed point
 * of itself, not because the double call was correct. Fixed by removing
 * the redundant pre-mapping and passing `ev.reason` straight through, so
 * updateOutcome()'s own exitReasonMap is the ONLY place this translation
 * happens.
 *
 * This uses the REAL eventBus (not mocked, same pattern as
 * margin.warning.pipeline.spec.ts) so the producer (settlement.engine.ts's
 * position.closed emit, simulated here directly) and the consumer
 * (signal.telemetry.ts, a singleton that subscribes in its constructor)
 * are proven wired end-to-end, not just independently correct against a
 * mock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockFindUnique, mockUpdate } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate:     vi.fn().mockResolvedValue({}),
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    signalTelemetry: {
      findUnique: mockFindUnique,
      update:     mockUpdate,
    },
  },
}));

const { eventBus } = await import("../events-bus/event.bus.js");
// Importing the module instantiates the `signalTelemetry` singleton, whose
// constructor subscribes to `position.closed` -- exactly what proves the
// real wiring, not just the mapping function in isolation.
await import("../signals-engine/signal.telemetry.js");

function baseRow() {
  return {
    id: "telem-1", signalId: "sig-1", entryPrice: new Decimal(1.1000),
    executedAt: new Date("2026-07-20T08:00:00.000Z"), stopLoss: new Decimal(1.0950), target1: new Decimal(1.1100),
  };
}

async function emitClose(reason: "MANUAL" | "STOP_LOSS" | "TAKE_PROFIT" | "STOP_OUT" | "LIQUIDATION" | "ADMIN") {
  mockFindUnique.mockResolvedValue(baseRow());
  eventBus.emit("position.closed", {
    positionId: "pos-1", userId: "user-1", symbol: "EURUSD",
    pnl: 10, exitPrice: 1.1010, entryPrice: 1.1000, side: "BUY", quantity: 1,
    timestamp: new Date("2026-07-20T09:00:00.000Z").toISOString(),
    reason,
  });
  // updateOutcome() is async and awaited internally by the listener, but
  // eventBus.emit() itself is fire-and-forget (EventEmitter semantics) --
  // flush microtasks so the DB call has actually landed before asserting.
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("signal.telemetry.ts — position.closed -> updateOutcome, exitReason mapped exactly once (M.4 re-verification)", () => {
  it.each([
    ["STOP_LOSS",   "SL_HIT"],
    ["TAKE_PROFIT", "TP_HIT"],
    ["STOP_OUT",    "STOP_OUT"],
    ["LIQUIDATION", "STOP_OUT"],
    ["ADMIN",       "MANUAL"],
    ["MANUAL",      "MANUAL"],
  ] as const)("raw reason %s is stored as exitReason %s", async (raw, expected) => {
    await emitClose(raw);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const data = mockUpdate.mock.calls[0][0].data as { exitReason: string };
    expect(data.exitReason).toBe(expected);
  });

  it("never stores the raw, unmapped enum value for a non-MANUAL reason (the original M.4 symptom)", async () => {
    await emitClose("STOP_LOSS");

    const data = mockUpdate.mock.calls[0][0].data as { exitReason: string };
    expect(data.exitReason).not.toBe("MANUAL");
    expect(data.exitReason).not.toBe("STOP_LOSS");
  });
});
