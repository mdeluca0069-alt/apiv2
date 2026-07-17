/**
 * audit.outbox.consumer.spec.ts
 *
 * FASE 2.4 — Core Trading Certification.
 *
 * Proves that AuditOutboxConsumer.processPending() reliably turns
 * order.filled/order.partial_filled/position.closed OutboxEvent rows into
 * TradeAudit/AuditLog: each event's audit write(s) and its
 * `auditProcessed = true` flip commit inside one transaction (never a
 * TradeAudit row without the flag flip, or vice versa), the TradeAudit
 * write is an idempotent upsert keyed on sourceOutboxId+createdAt (not a
 * plain create — see the file header for why a try/catch around create
 * would NOT be idempotent under Postgres), a failed event increments
 * auditRetries instead of being marked processed, and an event that has
 * failed persistently triggers an alert.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = {
    tradeAudit: {
      upsert:     vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog:    { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { update: vi.fn().mockResolvedValue({}) },
  };
  const mockDb = {
    outboxEvent: {
      findMany: vi.fn(),
      update:   vi.fn().mockResolvedValue({ auditRetries: 1 }),
    },
    $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  };
  return { mockDb, mockTx };
});

vi.mock("../shared/db.js", () => ({ prisma: mockDb, IS_PERSISTENT: true }));
vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn(), observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

const { mockAuditConsumerFailure } = vi.hoisted(() => ({
  mockAuditConsumerFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { auditConsumerFailure: mockAuditConsumerFailure },
}));

const { auditOutboxConsumer } = await import("../compliance/audit.outbox.consumer.js");

const FILL_CREATED_AT = new Date("2026-07-11T10:00:00.000Z");
const FILL_EVENT = {
  id: "outbox-fill-1",
  eventType: "order.filled",
  createdAt: FILL_CREATED_AT,
  payload: {
    orderId: "order-1", positionId: "pos-1", userId: "user-1", symbol: "EURUSD", side: "BUY",
    fillPrice: 1.0870, marginUsed: 100, notional: 10_870, filledQuantity: 10_000,
    slippage: 0, fees: 1.08, leverage: 10,
    stopLoss: null, takeProfit: null, tradeStatus: "OPEN",
  },
};

const PARTIAL_EVENT = {
  id: "outbox-partial-1",
  eventType: "order.partial_filled",
  createdAt: new Date("2026-07-11T10:05:00.000Z"),
  payload: {
    orderId: "order-2", positionId: "pos-2", userId: "user-1", symbol: "EURUSD", side: "BUY",
    fillPrice: 1.0870, marginUsed: 50, notional: 5_435, filledQuantity: 5_000,
    slippage: 0, fees: 0.54, leverage: 10,
    stopLoss: 1.08, takeProfit: 1.09, tradeStatus: "PARTIAL",
    remainingQty: 5_000, cumulativeFilled: 5_000,
  },
};

const CLOSE_CREATED_AT = new Date("2026-07-11T11:00:00.000Z");
const CLOSE_EVENT = {
  id: "outbox-close-1",
  eventType: "position.closed",
  createdAt: CLOSE_CREATED_AT,
  payload: {
    positionId: "pos-1", userId: "user-1", symbol: "EURUSD", side: "BUY",
    pnl: 42.5, netCredit: 41.0, exitPrice: 1.0900, reason: "MANUAL", detail: "",
    entryPrice: 1.0870, quantity: 10_000, leverage: 10,
    openedAt: new Date(CLOSE_CREATED_AT.getTime() - 60_000).toISOString(),
    rawPnl: 42.5, pnlPercent: 3.9, commission: 1.5, swap: 0,
    marginUsedRequested: 100, marginUsedReleased: 100, marginDiscrepancy: 0,
    nbpWriteOff: 0,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
  mockDb.outboxEvent.update.mockResolvedValue({ auditRetries: 1 });
  mockTx.tradeAudit.upsert.mockResolvedValue({});
  mockTx.tradeAudit.updateMany.mockResolvedValue({ count: 0 });
  mockTx.auditLog.create.mockResolvedValue({});
  mockTx.outboxEvent.update.mockResolvedValue({});
});

describe("AuditOutboxConsumer.processPending()", () => {
  it("does nothing when there are no unprocessed events", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([]);

    const result = await auditOutboxConsumer.processPending();

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 0 });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("order.filled: upserts TradeAudit keyed on sourceOutboxId+createdAt and flips auditProcessed inside one transaction", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([FILL_EVENT]);

    const result = await auditOutboxConsumer.processPending();

    expect(result).toEqual({ processed: 1, failed: 0, skipped: 0 });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.tradeAudit.upsert).toHaveBeenCalledTimes(1);
    const call = mockTx.tradeAudit.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      sourceOutboxId_createdAt: { sourceOutboxId: "outbox-fill-1", createdAt: FILL_CREATED_AT },
    });
    expect(call.update).toEqual({}); // no-op on a duplicate — never overwrites
    expect(call.create.orderId).toBe("order-1");
    expect(call.create.positionId).toBe("pos-1");
    expect(call.create.tradeStatus).toBe("OPEN");
    expect(call.create.sourceOutboxId).toBe("outbox-fill-1");
    expect(call.create.createdAt).toBe(FILL_CREATED_AT);
    // The write and the flag flip are the same tx call — not two separate
    // top-level client calls that could commit independently.
    expect(mockTx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-fill-1" }, data: { auditProcessed: true },
    });
  });

  it("order.partial_filled: lifecycle detail reconstructs the original order quantity from cumulativeFilled + remainingQty", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([PARTIAL_EVENT]);

    await auditOutboxConsumer.processPending();

    const created = mockTx.tradeAudit.upsert.mock.calls[0][0].create;
    expect(created.tradeStatus).toBe("PARTIAL");
    const lifecycle = JSON.parse(created.lifecycle);
    // cumulativeFilled=5000 + remainingQty=5000 = originalQty=10000
    expect(lifecycle[0].detail).toBe("Partial fill 5000/10000 @ 1.087");
    const riskMetrics = JSON.parse(created.riskMetrics);
    expect(riskMetrics.remainingQty).toBe(5_000);
    expect(riskMetrics.cumulativeFilled).toBe(5_000);
  });

  it("position.closed: no prior OPEN TradeAudit row (updateMany count 0) — upserts a CLOSED-only row plus AuditLog", async () => {
    mockTx.tradeAudit.updateMany.mockResolvedValue({ count: 0 });
    mockDb.outboxEvent.findMany.mockResolvedValue([CLOSE_EVENT]);

    const result = await auditOutboxConsumer.processPending();

    expect(result).toEqual({ processed: 1, failed: 0, skipped: 0 });
    expect(mockTx.tradeAudit.updateMany).toHaveBeenCalledWith({
      where: { positionId: "pos-1" },
      data:  expect.objectContaining({ tradeStatus: "CLOSED" }),
    });
    expect(mockTx.tradeAudit.upsert).toHaveBeenCalledTimes(1);
    const call = mockTx.tradeAudit.upsert.mock.calls[0][0];
    expect(call.create.tradeStatus).toBe("CLOSED");
    expect(call.where).toEqual({
      sourceOutboxId_createdAt: { sourceOutboxId: "outbox-close-1", createdAt: CLOSE_CREATED_AT },
    });
    expect(mockTx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockTx.auditLog.create.mock.calls[0][0].data.action).toBe("position.manual");
    expect(mockTx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-close-1" }, data: { auditProcessed: true },
    });
  });

  it("position.closed: prior OPEN TradeAudit row exists (updateMany count 1) — updates in place, does not upsert a duplicate row", async () => {
    mockTx.tradeAudit.updateMany.mockResolvedValue({ count: 1 });
    mockDb.outboxEvent.findMany.mockResolvedValue([CLOSE_EVENT]);

    await auditOutboxConsumer.processPending();

    expect(mockTx.tradeAudit.upsert).not.toHaveBeenCalled();
    expect(mockTx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("position.closed: copies nbpWriteOff into both AuditLog.payload and TradeAudit.riskMetrics (FASE 5.2 Bug #8, LEDGER_FREEZE.md §0.8)", async () => {
    mockTx.tradeAudit.updateMany.mockResolvedValue({ count: 0 });
    mockDb.outboxEvent.findMany.mockResolvedValue([
      { ...CLOSE_EVENT, payload: { ...CLOSE_EVENT.payload, netCredit: -50, nbpWriteOff: 12.34 } },
    ]);

    await auditOutboxConsumer.processPending();

    const auditPayload = mockTx.auditLog.create.mock.calls[0][0].data.payload as { nbpWriteOff: number };
    expect(auditPayload.nbpWriteOff).toBe(12.34);

    const created = mockTx.tradeAudit.upsert.mock.calls[0][0].create;
    const riskMetrics = JSON.parse(created.riskMetrics);
    expect(riskMetrics.nbpWriteOff).toBe(12.34);
  });

  it("a failed event increments auditRetries instead of being marked processed, and does not block the rest of the batch", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([FILL_EVENT, CLOSE_EVENT]);
    mockTx.tradeAudit.upsert.mockRejectedValueOnce(new Error("simulated DB error"));
    mockDb.outboxEvent.update.mockResolvedValue({ auditRetries: 3 });

    const result = await auditOutboxConsumer.processPending();

    expect(result).toEqual({ processed: 1, failed: 1, skipped: 0 });
    expect(mockDb.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-fill-1" },
      data:  { auditRetries: { increment: 1 } },
      select: { auditRetries: true },
    });
    // auditProcessed:true was never set for the failed row via the base client.
    expect(mockDb.outboxEvent.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "outbox-fill-1" }, data: { auditProcessed: true } }),
    );
    // The second event in the batch still processed despite the first failing.
    expect(mockTx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockAuditConsumerFailure).not.toHaveBeenCalled();
  });

  it("alerts once a row's auditRetries reaches the persistent-failure threshold", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([FILL_EVENT]);
    mockTx.tradeAudit.upsert.mockRejectedValue(new Error("still failing"));
    mockDb.outboxEvent.update.mockResolvedValue({ auditRetries: 10 });

    const result = await auditOutboxConsumer.processPending();

    expect(result.failed).toBe(1);
    expect(mockAuditConsumerFailure).toHaveBeenCalledWith(
      "outbox-fill-1", "order.filled", 10, "still failing",
    );
  });

  it("an unrecognized event type is marked processed without throwing (defensive — should be unreachable given the query filter)", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([
      { id: "outbox-unknown-1", eventType: "order.rejected", createdAt: new Date(), payload: {} },
    ]);

    const result = await auditOutboxConsumer.processPending();

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 1 });
    expect(mockDb.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-unknown-1" }, data: { auditProcessed: true },
    });
  });
});
