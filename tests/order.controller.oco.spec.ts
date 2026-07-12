/**
 * order.controller.oco.spec.ts
 *
 * FASE 3.6 — Internal Liquidity Engine (Group C: order types).
 *
 * Proves OrderController.placeOcoPair():
 *   - rejects upfront if either leg is not a resting order type (MARKET/IOC/FOK
 *     execute immediately and can never be one side of a still-pending pair)
 *   - places both legs with a shared, generated ocoGroupId
 *   - rolls leg A back (cancels it) if leg B fails to place, so a caller
 *     never ends up with an orphaned unpaired "OCO" leg
 *   - rolls leg A back if leg B's placement throws outright (not just a
 *     REJECTED ack — e.g. feed circuit open / trading suspended)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetQuote, mockIsStale } = vi.hoisted(() => ({
  mockGetQuote: vi.fn(),
  mockIsStale:  vi.fn().mockReturnValue(false),
}));
vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockGetQuote, isStale: mockIsStale },
}));

vi.mock("../liquidity-engine/broker.spread.config.js", () => ({
  brokerSpreadConfig: { isEnabled: vi.fn().mockReturnValue(true) },
}));

vi.mock("../shared/feed.circuit.js", () => ({
  feedCircuit: { isOpen: vi.fn().mockReturnValue(false) },
}));

vi.mock("../shared/trading.suspension.js", () => ({
  tradingSuspension: { isSuspended: vi.fn().mockReturnValue(false), getSuspension: vi.fn() },
}));

vi.mock("../trading-service/order.dedup.guard.js", () => ({
  buildSubmissionKey: vi.fn().mockReturnValue("dedup-key"),
  isDuplicateSubmission: vi.fn().mockReturnValue(false),
}));

const { mockPreTradeCheck } = vi.hoisted(() => ({ mockPreTradeCheck: vi.fn() }));
vi.mock("../risk-service/risk.engine.js", () => ({
  riskEngine: { preTradeCheck: mockPreTradeCheck },
}));

vi.mock("../execution-service/execution.queue.js", () => ({
  executionQueue: { enqueue: vi.fn() },
}));

vi.mock("../execution-service/execution.engine.js", () => ({
  executionEngine: { execute: vi.fn() },
}));

const { mockOrderLifecycleCreate, mockTransition, mockRejectOrder } = vi.hoisted(() => ({
  mockOrderLifecycleCreate: vi.fn(),
  mockTransition: vi.fn().mockResolvedValue(undefined),
  mockRejectOrder: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../trading-service/order.lifecycle.js", () => ({
  orderLifecycle: { create: mockOrderLifecycleCreate, transition: mockTransition, rejectOrder: mockRejectOrder },
  DuplicateOrderError: class DuplicateOrderError extends Error {},
}));

const { mockPendingAdd, mockPendingCancel, mockGetForUser } = vi.hoisted(() => ({
  mockPendingAdd: vi.fn(),
  mockPendingCancel: vi.fn().mockResolvedValue(true),
  mockGetForUser: vi.fn().mockReturnValue([]),
}));
vi.mock("../trading-service/pending.order.book.js", () => ({
  pendingOrderBook: { add: mockPendingAdd, cancel: mockPendingCancel, getForUser: mockGetForUser },
}));

vi.mock("../trading-service/position.price.monitor.js", () => ({
  positionPriceMonitor: { isAtCapacity: vi.fn().mockReturnValue(false), addPosition: vi.fn() },
  PositionMonitorCapacityError: class PositionMonitorCapacityError extends Error {},
}));

const { orderController } = await import("../trading-service/order.controller.js");

const CTX = { userId: "user-1", tenantId: "tenant-1" };
const FRESH_QUOTE = { bid: 1.0868, ask: 1.0870, mid: 1.0869, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 };

const RESTING_LEG_A = { symbol: "EURUSD", side: "BUY" as const, type: "STOP" as const, quantity: 10_000, leverage: 10, price: 1.0950 };
const RESTING_LEG_B = { symbol: "EURUSD", side: "SELL" as const, type: "STOP" as const, quantity: 10_000, leverage: 10, price: 1.0800 };
const MARKET_LEG    = { symbol: "EURUSD", side: "BUY" as const, type: "MARKET" as const, quantity: 10_000, leverage: 10 };

let orderCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  orderCounter = 0;
  mockGetQuote.mockReturnValue(FRESH_QUOTE);
  mockIsStale.mockReturnValue(false);
  mockPreTradeCheck.mockResolvedValue({
    pass: true, effectiveLeverage: 10, marginRequired: 100, notional: 10_870,
  });
  mockOrderLifecycleCreate.mockImplementation(async () => {
    orderCounter += 1;
    return { id: `order-${orderCounter}`, createdAt: new Date() };
  });
  mockPendingAdd.mockImplementation(async (order: Record<string, unknown>) => ({
    ...order, id: `pending-${orderCounter}`, status: "PENDING", createdAt: new Date(),
  }));
  mockGetForUser.mockReturnValue([]);
});

describe("OrderController.placeOcoPair()", () => {
  it("rejects upfront if leg A is not a resting order type", async () => {
    const result = await orderController.placeOcoPair(MARKET_LEG, RESTING_LEG_B, CTX);

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("OCO_INVALID_TYPE");
    expect(mockOrderLifecycleCreate).not.toHaveBeenCalled();
  });

  it("rejects upfront if leg B is not a resting order type", async () => {
    const result = await orderController.placeOcoPair(RESTING_LEG_A, MARKET_LEG, CTX);

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("OCO_INVALID_TYPE");
    expect(mockOrderLifecycleCreate).not.toHaveBeenCalled();
  });

  it("places both legs with a shared, generated ocoGroupId when both succeed", async () => {
    const result = await orderController.placeOcoPair(RESTING_LEG_A, RESTING_LEG_B, CTX);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.legA.status).toBe("ACCEPTED");
    expect(result.legB.status).toBe("ACCEPTED");
    expect(mockPendingAdd).toHaveBeenCalledTimes(2);

    const [callA, callB] = mockPendingAdd.mock.calls.map((c) => c[0] as { ocoGroupId?: string });
    expect(callA.ocoGroupId).toBeTruthy();
    expect(callA.ocoGroupId).toBe(callB.ocoGroupId);
    expect(callA.ocoGroupId).toBe(result.ocoGroupId);
  });

  it("does not attempt leg B if leg A is rejected", async () => {
    mockPreTradeCheck.mockResolvedValueOnce({ pass: false, reason: "INSUFFICIENT_MARGIN", detail: "test" });

    const result = await orderController.placeOcoPair(RESTING_LEG_A, RESTING_LEG_B, CTX);

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("OCO_LEG_A_REJECTED");
    expect(mockPendingAdd).not.toHaveBeenCalled();
  });

  it("rolls leg A back (cancels it) when leg B is rejected", async () => {
    mockPreTradeCheck
      .mockResolvedValueOnce({ pass: true, effectiveLeverage: 10, marginRequired: 100, notional: 10_870 }) // leg A
      .mockResolvedValueOnce({ pass: false, reason: "INSUFFICIENT_MARGIN", detail: "test" });               // leg B

    mockGetForUser.mockReturnValue([
      { id: "pending-1", orderId: "order-1", userId: "user-1" },
    ]);

    const result = await orderController.placeOcoPair(RESTING_LEG_A, RESTING_LEG_B, CTX);

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("OCO_LEG_B_REJECTED");
    expect(mockPendingCancel).toHaveBeenCalledWith("pending-1", "user-1");
  });

  it("rolls leg A back and re-throws when leg B's placement throws outright", async () => {
    mockPreTradeCheck
      .mockResolvedValueOnce({ pass: true, effectiveLeverage: 10, marginRequired: 100, notional: 10_870 }); // leg A only

    mockGetForUser.mockReturnValue([
      { id: "pending-1", orderId: "order-1", userId: "user-1" },
    ]);

    // Leg B's placeOrder() call hits the feed-circuit-open throw path.
    const { feedCircuit } = await import("../shared/feed.circuit.js");
    vi.mocked(feedCircuit.isOpen).mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(orderController.placeOcoPair(RESTING_LEG_A, RESTING_LEG_B, CTX)).rejects.toThrow(/FEED_CIRCUIT_OPEN/);
    expect(mockPendingCancel).toHaveBeenCalledWith("pending-1", "user-1");
  });
});
