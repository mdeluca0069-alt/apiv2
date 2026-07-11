/**
 * order.controller.staleness.spec.ts
 *
 * FASE 3.4 — Internal Liquidity Engine.
 *
 * Proves OrderController.placeOrder() and .executePendingOrder() both
 * reject with NO_LIVE_MARKET_DATA when quoteCache.isStale() is true — the
 * check quoteCache.isStale()'s own docstring already claimed
 * "order.controller uses this to reject orders" but never actually did.
 * Isolated from the rest of the pipeline: a stale quote must be rejected
 * before the risk engine, execution queue, or order lifecycle are ever
 * touched.
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

vi.mock("../trading-service/pending.order.book.js", () => ({
  pendingOrderBook: { add: vi.fn() },
}));

vi.mock("../trading-service/position.price.monitor.js", () => ({
  positionPriceMonitor: { isAtCapacity: vi.fn().mockReturnValue(false), addPosition: vi.fn() },
  PositionMonitorCapacityError: class PositionMonitorCapacityError extends Error {},
}));

const { orderController } = await import("../trading-service/order.controller.js");

const REQ = {
  symbol: "EURUSD", side: "BUY" as const, type: "MARKET" as const,
  quantity: 10_000, leverage: 10,
};
const CTX = { userId: "user-1", tenantId: "tenant-1" };
const FRESH_QUOTE = { bid: 1.0868, ask: 1.0870, mid: 1.0869, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetQuote.mockReturnValue(FRESH_QUOTE);
  mockIsStale.mockReturnValue(false);
});

describe("OrderController.placeOrder() — staleness gate", () => {
  it("rejects with NO_LIVE_MARKET_DATA when the quote is stale, before touching the risk engine", async () => {
    mockIsStale.mockReturnValue(true);

    const ack = await orderController.placeOrder(REQ, CTX);

    expect(ack.status).toBe("REJECTED");
    expect(ack.rejectionReason).toContain("NO_LIVE_MARKET_DATA");
    expect(ack.rejectionReason).toContain("stale");
    expect(mockPreTradeCheck).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("proceeds past the quote checks when the quote is fresh", async () => {
    mockIsStale.mockReturnValue(false);
    mockPreTradeCheck.mockResolvedValue({ pass: false, reason: "INSUFFICIENT_MARGIN", detail: "test short-circuit" });
    mockOrderLifecycleCreate.mockResolvedValue({ id: "order-1", createdAt: new Date() });

    await orderController.placeOrder(REQ, CTX);

    // Reached the risk engine — proves the staleness gate did not block a fresh quote.
    expect(mockPreTradeCheck).toHaveBeenCalledTimes(1);
  });
});

describe("OrderController.executePendingOrder() — staleness gate", () => {
  it("throws NO_LIVE_MARKET_DATA when the quote is stale", async () => {
    mockIsStale.mockReturnValue(true);
    const pending = {
      id: "pending-1", orderId: "order-1", userId: "user-1", symbol: "EURUSD",
      side: "BUY" as const, quantity: 10_000, leverage: 10,
      triggerPrice: 1.0870, marginRequired: 100, notional: 10_870,
    };

    await expect(orderController.executePendingOrder(pending as never, 1.0870))
      .rejects.toThrow(/NO_LIVE_MARKET_DATA/);
  });
});
