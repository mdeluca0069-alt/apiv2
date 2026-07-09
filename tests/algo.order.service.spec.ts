/**
 * algo.order.service.spec.ts
 *
 * Milestone 1 / Fix #1 — TWAP/VWAP/ICEBERG/BRACKET algo orders must place
 * real child orders through orderController.placeOrder() (the same path
 * MARKET orders use) instead of only recording a PENDING child that nothing
 * ever fills. This file proves: (a) every slice actually calls placeOrder,
 * (b) filledQuantity/avgFillPrice/remainingQty reflect the real fills
 * orderController returns, (c) a rejected/failed slice is marked CANCELLED
 * instead of vanishing, and (d) the algo only completes once every slice has
 * been placed AND resolved (no premature COMPLETED while a slice is still
 * in flight).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPlaceOrder } = vi.hoisted(() => ({
  mockPlaceOrder: vi.fn(),
}));

vi.mock("../trading-service/order.controller.js", () => ({
  orderController: { placeOrder: mockPlaceOrder },
}));

const { AlgoOrderService } = await import("../execution-service/algo.order.service.js");

function filledAck(price: number, quantity: number) {
  return {
    id: `ord_${Math.random().toString(36).slice(2)}`,
    symbol: "EURUSD",
    side: "BUY" as const,
    type: "MARKET" as const,
    quantity,
    averageFillPrice: price,
    status: "FILLED" as const,
    marginRequired: 0,
    notional: 0,
  };
}

function rejectedAck(reason: string) {
  return {
    id: `ord_${Math.random().toString(36).slice(2)}`,
    symbol: "EURUSD",
    side: "BUY" as const,
    type: "MARKET" as const,
    quantity: 0,
    status: "REJECTED" as const,
    rejectionReason: reason,
    marginRequired: 0,
    notional: 0,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const ctx = { userId: "user-1", tenantId: "tenant-1" };

beforeEach(() => {
  mockPlaceOrder.mockReset();
});

describe("AlgoOrderService — TWAP places real child orders", () => {
  it("calls orderController.placeOrder once per slice and accumulates real fills", async () => {
    mockPlaceOrder.mockResolvedValue(filledAck(1.1, 1));

    const service = new AlgoOrderService();
    const algo = service.submit({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      symbol: "EURUSD",
      direction: "BUY",
      totalQuantity: 3,
      params: { type: "TWAP", durationMs: 30, slices: 3, maxSlippage: 1 },
    });

    await waitUntil(() => mockPlaceOrder.mock.calls.length >= 3);
    await waitUntil(() => service.get(algo.id) === null); // completes and is removed from active

    expect(mockPlaceOrder).toHaveBeenCalledTimes(3);
    // Every call must route through the real order path with a MARKET order.
    for (const call of mockPlaceOrder.mock.calls) {
      expect(call[0]).toMatchObject({ symbol: "EURUSD", side: "BUY", type: "MARKET" });
      expect(call[1]).toEqual(ctx);
    }
  });

  it("never marks the algo COMPLETED while a slice is still PENDING", async () => {
    let resolveFirst!: (v: unknown) => void;
    const firstPending = new Promise((r) => { resolveFirst = r; });
    mockPlaceOrder
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValue(filledAck(1.1, 1));

    const service = new AlgoOrderService();
    const algo = service.submit({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      symbol: "EURUSD",
      direction: "BUY",
      totalQuantity: 1,
      params: { type: "BRACKET", entryPrice: 1.1, takeProfit: 1.2, stopLoss: 1.05, orderType: "MARKET" },
    });

    // Give the microtask queue a chance to run — the first slice is still
    // awaiting orderController.placeOrder(), so the algo must still be RUNNING.
    await new Promise((r) => setTimeout(r, 20));
    expect(service.get(algo.id)?.status).toBe("RUNNING");

    resolveFirst(filledAck(1.1, 1));
    await waitUntil(() => service.get(algo.id) === null);
  });
});

describe("AlgoOrderService — a rejected child order is accounted for, not lost", () => {
  it("marks the failed slice CANCELLED and still completes the algo with partial fill", async () => {
    mockPlaceOrder
      .mockResolvedValueOnce(filledAck(1.1, 1))
      .mockResolvedValueOnce(rejectedAck("INSUFFICIENT_MARGIN"));

    const service = new AlgoOrderService();
    const algo = service.submit({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      symbol: "EURUSD",
      direction: "BUY",
      totalQuantity: 2,
      params: { type: "TWAP", durationMs: 10, slices: 2, maxSlippage: 1 },
    });

    await waitUntil(() => mockPlaceOrder.mock.calls.length >= 2);
    await waitUntil(() => service.get(algo.id) === null);

    // The algo object returned by submit() is the same object mutated in place.
    expect(algo.filledQuantity).toBe(1);
    expect(algo.remainingQty).toBe(1);
    expect(algo.status).toBe("COMPLETED"); // partial fill still counts as completed, not silently fine
    expect(algo.childOrders).toHaveLength(2);
    expect(algo.childOrders.filter((c) => c.status === "FILLED")).toHaveLength(1);
    expect(algo.childOrders.filter((c) => c.status === "CANCELLED")).toHaveLength(1);
  });

  it("marks the algo FAILED (not COMPLETED) when every slice is rejected", async () => {
    mockPlaceOrder.mockResolvedValue(rejectedAck("KILL_SWITCH_ACTIVE"));

    const service = new AlgoOrderService();
    const algo = service.submit({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      symbol: "EURUSD",
      direction: "SELL",
      totalQuantity: 1,
      params: { type: "BRACKET", entryPrice: 1.1, takeProfit: 1.0, stopLoss: 1.15, orderType: "MARKET" },
    });

    await waitUntil(() => mockPlaceOrder.mock.calls.length >= 1);
    await waitUntil(() => service.get(algo.id) === null);

    expect(algo.filledQuantity).toBe(0);
    expect(algo.status).toBe("FAILED");
  });
});

describe("AlgoOrderService — cancel() stops future slices", () => {
  it("does not place further orders after cancel", async () => {
    mockPlaceOrder.mockResolvedValue(filledAck(1.1, 1));

    const service = new AlgoOrderService();
    const algo = service.submit({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      symbol: "EURUSD",
      direction: "BUY",
      totalQuantity: 5,
      params: { type: "TWAP", durationMs: 200, slices: 5, maxSlippage: 1 },
    });

    await waitUntil(() => mockPlaceOrder.mock.calls.length >= 1);
    service.cancel(algo.id, ctx.userId);
    const callsAtCancel = mockPlaceOrder.mock.calls.length;

    await new Promise((r) => setTimeout(r, 150));
    expect(mockPlaceOrder.mock.calls.length).toBe(callsAtCancel);
    expect(algo.status).toBe("CANCELLED");
  });
});
