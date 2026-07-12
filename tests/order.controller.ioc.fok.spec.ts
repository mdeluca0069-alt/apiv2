/**
 * order.controller.ioc.fok.spec.ts
 *
 * FASE 3.5 — Internal Liquidity Engine (Group C: order types).
 *
 * Proves OrderController.placeOrder() routes IOC and FOK through the same
 * immediate-execution path as MARKET (executionQueue.enqueue → the per-user
 * queue that prevents margin races) rather than the resting order book —
 * IOC/FOK must either execute right now or be cancelled, they can never
 * rest waiting for a trigger price like LIMIT/STOP do.
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

const { mockEnqueue } = vi.hoisted(() => ({ mockEnqueue: vi.fn() }));
vi.mock("../execution-service/execution.queue.js", () => ({
  executionQueue: { enqueue: mockEnqueue },
}));

vi.mock("../execution-service/execution.engine.js", () => ({
  executionEngine: { execute: vi.fn() },
}));

const { mockOrderLifecycleCreate, mockRejectOrder } = vi.hoisted(() => ({
  mockOrderLifecycleCreate: vi.fn(),
  mockRejectOrder: vi.fn(),
}));
vi.mock("../trading-service/order.lifecycle.js", () => ({
  orderLifecycle: { create: mockOrderLifecycleCreate, rejectOrder: mockRejectOrder },
  DuplicateOrderError: class DuplicateOrderError extends Error {},
}));

const { mockPendingOrderBookAdd } = vi.hoisted(() => ({ mockPendingOrderBookAdd: vi.fn() }));
vi.mock("../trading-service/pending.order.book.js", () => ({
  pendingOrderBook: { add: mockPendingOrderBookAdd },
}));

vi.mock("../trading-service/position.price.monitor.js", () => ({
  positionPriceMonitor: { isAtCapacity: vi.fn().mockReturnValue(false), addPosition: vi.fn() },
  PositionMonitorCapacityError: class PositionMonitorCapacityError extends Error {},
}));

const { orderController } = await import("../trading-service/order.controller.js");

const CTX = { userId: "user-1", tenantId: "tenant-1" };
const FRESH_QUOTE = { bid: 1.0868, ask: 1.0870, mid: 1.0869, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetQuote.mockReturnValue(FRESH_QUOTE);
  mockIsStale.mockReturnValue(false);
  mockPreTradeCheck.mockResolvedValue({
    pass: true, effectiveLeverage: 10, marginRequired: 100, notional: 10_870,
  });
  mockEnqueue.mockResolvedValue({
    ok: true,
    result: {
      id: "order-1", symbol: "EURUSD", side: "BUY", type: "IOC",
      quantity: 10_000, status: "FILLED", marginRequired: 100, notional: 10_870,
      createdAt: new Date().toISOString(),
    },
  });
});

describe("OrderController.placeOrder() — IOC/FOK routing", () => {
  it("routes an IOC order through executionQueue.enqueue, not the resting order book", async () => {
    const req = { symbol: "EURUSD", side: "BUY" as const, type: "IOC" as const, quantity: 10_000, leverage: 10 };

    await orderController.placeOrder(req, CTX);

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockPendingOrderBookAdd).not.toHaveBeenCalled();
  });

  it("routes a FOK order through executionQueue.enqueue, not the resting order book", async () => {
    const req = { symbol: "EURUSD", side: "BUY" as const, type: "FOK" as const, quantity: 10_000, leverage: 10 };

    await orderController.placeOrder(req, CTX);

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockPendingOrderBookAdd).not.toHaveBeenCalled();
  });
});
