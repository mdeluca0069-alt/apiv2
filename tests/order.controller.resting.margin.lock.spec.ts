/**
 * order.controller.resting.margin.lock.spec.ts
 *
 * PHASE2_REMEDIATION (H2) — resting (LIMIT/STOP/STOP_LIMIT/TRAILING_STOP)
 * orders previously stored `marginRequired` as a plain number on the
 * PendingOrder/Order record but never actually locked it in
 * WalletAccount.locked until (if ever) the order later triggered and
 * reached execution.engine.ts. A client could stack an unlimited number of
 * resting orders whose combined notional far exceeded real account equity,
 * with nothing backing any of them while they rested.
 *
 * Fix: _parkPendingOrder() now locks margin via marginController.
 * checkAndLockMargin() before an order is accepted as resting, releases it
 * again if pendingOrderBook.add() then fails to persist, and
 * executePendingOrder() passes preLockedMargin through to execute() so the
 * fill-time re-lock is a true-up (release estimate, lock real) instead of a
 * double-lock. A partial fill's re-queued remainder locks its own margin
 * share fresh, since the true-up releases the full pre-locked estimate and
 * only re-locks the filled portion's real amount.
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

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));
vi.mock("../execution-service/execution.engine.js", () => ({
  executionEngine: { execute: mockExecute },
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

const { mockPendingAdd } = vi.hoisted(() => ({ mockPendingAdd: vi.fn() }));
vi.mock("../trading-service/pending.order.book.js", () => ({
  pendingOrderBook: { add: mockPendingAdd },
}));

vi.mock("../trading-service/position.price.monitor.js", () => ({
  positionPriceMonitor: { isAtCapacity: vi.fn().mockReturnValue(false), addPosition: vi.fn() },
  PositionMonitorCapacityError: class PositionMonitorCapacityError extends Error {},
}));

const { mockCheckAndLockMargin, mockReleaseMargin } = vi.hoisted(() => ({
  mockCheckAndLockMargin: vi.fn(),
  mockReleaseMargin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../risk-service/margin.controller.js", () => ({
  marginController: { checkAndLockMargin: mockCheckAndLockMargin, releaseMargin: mockReleaseMargin },
}));

const { orderController } = await import("../trading-service/order.controller.js");

const REQ = {
  symbol: "EURUSD", side: "BUY" as const, type: "LIMIT" as const,
  quantity: 10_000, leverage: 10, price: 1.0900,
};
const CTX = { userId: "user-1", tenantId: "tenant-1" };
const FRESH_QUOTE = { bid: 1.0868, ask: 1.0870, mid: 1.0869, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetQuote.mockReturnValue(FRESH_QUOTE);
  mockIsStale.mockReturnValue(false);
  mockPreTradeCheck.mockResolvedValue({ pass: true, effectiveLeverage: 10, marginRequired: 100, notional: 10_900 });
  mockOrderLifecycleCreate.mockResolvedValue({ id: "order-1", createdAt: new Date() });
  mockCheckAndLockMargin.mockResolvedValue({ ok: true });
  mockPendingAdd.mockResolvedValue({ id: "pending-1", status: "PENDING", createdAt: new Date() });
});

describe("OrderController._parkPendingOrder() — PHASE2_REMEDIATION (H2): margin locked before a resting order rests", () => {
  it("locks margin for the risk-approved amount before parking the order", async () => {
    await orderController.placeOrder(REQ, CTX);

    expect(mockCheckAndLockMargin).toHaveBeenCalledWith("user-1", "order-1", 100);
    // The lock happens BEFORE the order is parked -- proves ordering, not just occurrence.
    const lockCallOrder = mockCheckAndLockMargin.mock.invocationCallOrder[0]!;
    const addCallOrder  = mockPendingAdd.mock.invocationCallOrder[0]!;
    expect(lockCallOrder).toBeLessThan(addCallOrder);
  });

  it("rejects the order and never parks it when margin is unavailable", async () => {
    mockCheckAndLockMargin.mockResolvedValue({ ok: false, reason: "INSUFFICIENT_MARGIN: need 100.00, available=20.00" });

    const ack = await orderController.placeOrder(REQ, CTX);

    expect(ack.status).toBe("REJECTED");
    expect(ack.rejectionReason).toContain("INSUFFICIENT_MARGIN");
    expect(mockPendingAdd).not.toHaveBeenCalled();
    expect(mockRejectOrder).toHaveBeenCalledWith("order-1", expect.stringContaining("INSUFFICIENT_MARGIN"));
  });

  it("releases the just-locked margin if persisting the resting order then fails", async () => {
    mockPendingAdd.mockRejectedValue(new Error("PENDING_ORDER_PERSIST_FAILED: DB unavailable"));

    const ack = await orderController.placeOrder(REQ, CTX);

    expect(ack.status).toBe("REJECTED");
    expect(mockReleaseMargin).toHaveBeenCalledWith("user-1", "order-1", 100);
  });

  it("a resting order is never parked without its margin lock call happening first, across order types", async () => {
    for (const type of ["LIMIT", "STOP", "STOP_LIMIT", "TRAILING_STOP"] as const) {
      vi.clearAllMocks();
      mockCheckAndLockMargin.mockResolvedValue({ ok: true });
      mockOrderLifecycleCreate.mockResolvedValue({ id: `order-${type}`, createdAt: new Date() });
      mockPendingAdd.mockResolvedValue({ id: `pending-${type}`, status: "PENDING", createdAt: new Date() });
      mockPreTradeCheck.mockResolvedValue({ pass: true, effectiveLeverage: 10, marginRequired: 100, notional: 10_900 });

      await orderController.placeOrder({ ...REQ, type }, CTX);

      expect(mockCheckAndLockMargin).toHaveBeenCalledTimes(1);
      expect(mockPendingAdd).toHaveBeenCalledTimes(1);
    }
  });
});

describe("OrderController.executePendingOrder() — PHASE2_REMEDIATION (H2): true-up at fill time", () => {
  const PENDING = {
    id: "pending-1", orderId: "order-1", userId: "user-1", symbol: "EURUSD",
    side: "BUY" as const, type: "LIMIT" as const, quantity: 10_000, leverage: 10,
    triggerPrice: 1.0900, marginRequired: 100, notional: 10_900,
  };

  it("passes preLockedMargin through to execute() so it can release the estimate before locking the real amount", async () => {
    mockExecute.mockResolvedValue({ status: "FILLED", orderId: "order-1", averageFillPrice: 1.0900, filledQuantity: 10_000 });

    await orderController.executePendingOrder(PENDING as never, 1.0900);

    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order-1", preLockedMargin: 100 }),
      expect.anything(),
    );
  });

  it("locks margin for the remainder before re-queuing a genuine partial fill", async () => {
    mockExecute.mockResolvedValue({
      status: "PARTIALLY_FILLED", orderId: "order-1", filledQuantity: 6_000, remainingQuantity: 4_000,
    });
    mockCheckAndLockMargin.mockResolvedValue({ ok: true });

    await orderController.executePendingOrder(PENDING as never, 1.0900);

    expect(mockCheckAndLockMargin).toHaveBeenCalledWith("user-1", "order-1", 40); // 100 * 4000/10000
    expect(mockPendingAdd).toHaveBeenCalledWith(expect.objectContaining({
      quantity: 4_000, marginRequired: 40,
    }));
  });

  it("does NOT re-queue the remainder when margin for it is unavailable -- never leaves an unprotected resting order", async () => {
    mockExecute.mockResolvedValue({
      status: "PARTIALLY_FILLED", orderId: "order-1", filledQuantity: 6_000, remainingQuantity: 4_000,
    });
    mockCheckAndLockMargin.mockResolvedValue({ ok: false, reason: "INSUFFICIENT_MARGIN: need 40.00, available=0.00" });

    await orderController.executePendingOrder(PENDING as never, 1.0900);

    expect(mockPendingAdd).not.toHaveBeenCalled();
  });

  it("a full fill (no remainder) never calls checkAndLockMargin again for a remainder", async () => {
    mockExecute.mockResolvedValue({ status: "FILLED", orderId: "order-1", averageFillPrice: 1.0900, filledQuantity: 10_000 });

    await orderController.executePendingOrder(PENDING as never, 1.0900);

    expect(mockCheckAndLockMargin).not.toHaveBeenCalled();
    expect(mockPendingAdd).not.toHaveBeenCalled();
  });
});
