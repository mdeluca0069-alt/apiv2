/**
 * order.trigger.watcher.oco.spec.ts
 *
 * FASE 3.6 — Internal Liquidity Engine (Group C: order types).
 *
 * Proves OrderTriggerWatcher wires the OCO cascade correctly: right after a
 * pending order triggers (markTriggered() succeeds), it calls
 * pendingOrderBook.cancelOcoSiblingsOnTrigger(pending.id, pending.ocoGroupId)
 * — BEFORE dispatching the fill/arm — for both the direct-fill path (LIMIT/
 * STOP/TRAILING_STOP) and the two-phase STOP_LIMIT arm path. An order with
 * no ocoGroupId must still call through (cancelOcoSiblingsOnTrigger's own
 * no-op-when-undefined behavior is covered separately in
 * pending.order.book.spec.ts) — this file only proves the watcher calls it
 * at all, with the right arguments, at the right point in the flow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockMarkTriggered, mockCancelOcoSiblingsOnTrigger, mockUpdateTrailingStops, mockGetBySymbol, mockAdd } = vi.hoisted(() => ({
  mockMarkTriggered: vi.fn(),
  mockCancelOcoSiblingsOnTrigger: vi.fn().mockResolvedValue(undefined),
  mockUpdateTrailingStops: vi.fn(),
  mockGetBySymbol: vi.fn(),
  mockAdd: vi.fn().mockResolvedValue({}),
}));
vi.mock("../trading-service/pending.order.book.js", () => ({
  pendingOrderBook: {
    markTriggered: mockMarkTriggered,
    cancelOcoSiblingsOnTrigger: mockCancelOcoSiblingsOnTrigger,
    updateTrailingStops: mockUpdateTrailingStops,
    getBySymbol: mockGetBySymbol,
    add: mockAdd,
  },
}));

const { mockExecutePendingOrder } = vi.hoisted(() => ({ mockExecutePendingOrder: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../trading-service/order.controller.js", () => ({
  orderController: { executePendingOrder: mockExecutePendingOrder },
}));

vi.mock("../trading-service/order.lifecycle.js", () => ({
  orderLifecycle: { transition: vi.fn().mockResolvedValue(undefined) },
}));

const { mockEmit, mockOn } = vi.hoisted(() => ({ mockEmit: vi.fn(), mockOn: vi.fn() }));
vi.mock("../events-bus/event.bus.js", () => ({
  eventBus: { emit: mockEmit, on: mockOn },
}));

const { orderTriggerWatcher } = await import("../trading-service/order.trigger.watcher.js");

function makePending(overrides: Record<string, unknown> = {}) {
  return {
    id: "pending-1", orderId: "order-1", userId: "user-1", symbol: "EURUSD",
    side: "BUY", type: "LIMIT", quantity: 10_000, triggerPrice: 1.0900,
    leverage: 10, marginRequired: 100, notional: 10_900, status: "PENDING",
    createdAt: new Date(),
    ...overrides,
  };
}

let quoteTickHandler: ((q: { symbol: string; bid: number; ask: number }) => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mockOn.mockImplementation((event: string, cb: typeof quoteTickHandler) => {
    if (event === "market.quote") quoteTickHandler = cb;
  });
  orderTriggerWatcher.start();
});

async function fireTick(symbol: string, bid: number, ask: number) {
  quoteTickHandler?.({ symbol, bid, ask });
  // _evaluate() is fire-and-forget (`void this._evaluate(...)`) — flush microtasks.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("OrderTriggerWatcher — OCO cascade wiring", () => {
  it("calls cancelOcoSiblingsOnTrigger with the pending id + ocoGroupId right after a direct fill triggers", async () => {
    const pending = makePending({ type: "LIMIT", side: "BUY", triggerPrice: 1.0900, ocoGroupId: "group-1" });
    mockGetBySymbol.mockReturnValue([pending]);
    mockMarkTriggered.mockReturnValue(pending);

    await fireTick("EURUSD", 1.0890, 1.0895); // ask <= 1.0900 → triggers

    expect(mockCancelOcoSiblingsOnTrigger).toHaveBeenCalledWith("pending-1", "group-1");
    expect(mockExecutePendingOrder).toHaveBeenCalledTimes(1);
  });

  it("calls cancelOcoSiblingsOnTrigger BEFORE dispatching the fill", async () => {
    const pending = makePending({ type: "LIMIT", side: "BUY", triggerPrice: 1.0900, ocoGroupId: "group-1" });
    mockGetBySymbol.mockReturnValue([pending]);
    mockMarkTriggered.mockReturnValue(pending);

    const callOrder: string[] = [];
    mockCancelOcoSiblingsOnTrigger.mockImplementation(async () => { callOrder.push("cancelSiblings"); });
    mockExecutePendingOrder.mockImplementation(async () => { callOrder.push("executePendingOrder"); });

    await fireTick("EURUSD", 1.0890, 1.0895);

    expect(callOrder).toEqual(["cancelSiblings", "executePendingOrder"]);
  });

  it("calls cancelOcoSiblingsOnTrigger for a STOP_LIMIT arm trigger too, before arming the LIMIT leg", async () => {
    const pending = makePending({
      type: "STOP_LIMIT", side: "BUY", triggerPrice: 1.0900, limitPrice: 1.0910, ocoGroupId: "group-2",
    });
    mockGetBySymbol.mockReturnValue([pending]);
    mockMarkTriggered.mockReturnValue(pending);

    const callOrder: string[] = [];
    mockCancelOcoSiblingsOnTrigger.mockImplementation(async () => { callOrder.push("cancelSiblings"); });
    mockAdd.mockImplementation(async () => { callOrder.push("armLimit"); return {}; });

    await fireTick("EURUSD", 1.0890, 1.0905); // ask >= 1.0900 → STOP triggers

    expect(mockCancelOcoSiblingsOnTrigger).toHaveBeenCalledWith("pending-1", "group-2");
    expect(callOrder).toEqual(["cancelSiblings", "armLimit"]);
  });

  it("still calls through (with ocoGroupId undefined) for an order with no OCO link — no-op is the book's responsibility, not the watcher's", async () => {
    const pending = makePending({ type: "LIMIT", side: "BUY", triggerPrice: 1.0900 }); // no ocoGroupId
    mockGetBySymbol.mockReturnValue([pending]);
    mockMarkTriggered.mockReturnValue(pending);

    await fireTick("EURUSD", 1.0890, 1.0895);

    expect(mockCancelOcoSiblingsOnTrigger).toHaveBeenCalledWith("pending-1", undefined);
  });

  it("does not call cancelOcoSiblingsOnTrigger when nothing triggers", async () => {
    // LIMIT BUY triggers when ask <= triggerPrice — 1.0000 is well below the
    // current 1.0895 ask, so this order has not crossed yet.
    const pending = makePending({ type: "LIMIT", side: "BUY", triggerPrice: 1.0000, ocoGroupId: "group-3" });
    mockGetBySymbol.mockReturnValue([pending]);

    await fireTick("EURUSD", 1.0890, 1.0895); // nowhere near trigger price

    expect(mockMarkTriggered).not.toHaveBeenCalled();
    expect(mockCancelOcoSiblingsOnTrigger).not.toHaveBeenCalled();
  });
});
