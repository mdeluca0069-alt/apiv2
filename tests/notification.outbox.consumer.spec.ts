/**
 * notification.outbox.consumer.spec.ts
 *
 * FASE 2.6 — Core Trading Certification.
 *
 * Proves NotificationOutboxConsumer.processPending() reliably turns
 * order.filled/position.closed OutboxEvent rows into Notification rows:
 * the DB write(s) and the notificationProcessed flip commit inside one
 * transaction, each row is an idempotent upsert keyed on
 * sourceOutboxId+channel (not a plain create), user preferences gate which
 * channels get a row, email is only attempted (best-effort, outside the
 * transaction) when EMAIL was an allowed channel, a failed event increments
 * notificationRetries without blocking the rest of the batch, and an event
 * that has failed persistently triggers an alert.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = {
    notification: { upsert: vi.fn().mockResolvedValue({}) },
    outboxEvent:  { update: vi.fn().mockResolvedValue({}) },
  };
  const mockDb = {
    outboxEvent: {
      findMany: vi.fn(),
      update:   vi.fn().mockResolvedValue({ notificationRetries: 1 }),
    },
    notificationPreference: { findUnique: vi.fn().mockResolvedValue(null) },
    user:                   { findUnique: vi.fn().mockResolvedValue({ email: "trader@example.com" }) },
    $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  };
  return { mockDb, mockTx };
});

vi.mock("../shared/db.js", () => ({ prisma: mockDb, IS_PERSISTENT: true }));
vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn(), observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

const { mockNotificationConsumerFailure } = vi.hoisted(() => ({
  mockNotificationConsumerFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { notificationConsumerFailure: mockNotificationConsumerFailure },
}));

const { mockEmailSend } = vi.hoisted(() => ({ mockEmailSend: vi.fn().mockResolvedValue(true) }));
vi.mock("../notification-service/email.sender.js", () => ({
  emailSender: { send: mockEmailSend },
}));

const { notificationOutboxConsumer } = await import("../notification-service/notification.outbox.consumer.js");

const FILL_EVENT = {
  id: "outbox-fill-1",
  eventType: "order.filled",
  userId: "user-1",
  payload: { symbol: "EURUSD", side: "BUY", fillPrice: 1.0870, filledQuantity: 10_000 },
};

const CLOSE_EVENT_WIN = {
  id: "outbox-close-1",
  eventType: "position.closed",
  userId: "user-1",
  payload: { symbol: "EURUSD", pnl: 42.5 },
};

const CLOSE_EVENT_LOSS = {
  id: "outbox-close-2",
  eventType: "position.closed",
  userId: "user-1",
  payload: { symbol: "GBPUSD", pnl: -18.25 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
  mockDb.notificationPreference.findUnique.mockResolvedValue(null);
  mockDb.user.findUnique.mockResolvedValue({ email: "trader@example.com" });
  mockDb.outboxEvent.update.mockResolvedValue({ notificationRetries: 1 });
  mockTx.notification.upsert.mockResolvedValue({});
  mockTx.outboxEvent.update.mockResolvedValue({});
  mockEmailSend.mockResolvedValue(true);
});

describe("NotificationOutboxConsumer.processPending()", () => {
  it("does nothing when there are no unprocessed events", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([]);

    const result = await notificationOutboxConsumer.processPending();

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 0 });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("order.filled with no preference row: upserts IN_APP + EMAIL rows, sends the actual email, flips notificationProcessed", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([FILL_EVENT]);

    const result = await notificationOutboxConsumer.processPending();

    expect(result).toEqual({ processed: 1, failed: 0, skipped: 0 });
    expect(mockTx.notification.upsert).toHaveBeenCalledTimes(2);
    const channels = mockTx.notification.upsert.mock.calls.map((c) => c[0].create.channel).sort();
    expect(channels).toEqual(["EMAIL", "IN_APP"]);

    const inAppCall = mockTx.notification.upsert.mock.calls.find((c) => c[0].create.channel === "IN_APP")![0];
    expect(inAppCall.where).toEqual({ sourceOutboxId_channel: { sourceOutboxId: "outbox-fill-1", channel: "IN_APP" } });
    expect(inAppCall.update).toEqual({}); // no-op on a duplicate — never overwrites
    expect(inAppCall.create.title).toContain("EURUSD");
    expect(inAppCall.create.body).toContain("BUY");
    expect(inAppCall.create.body).toContain("10000");

    expect(mockTx.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-fill-1" }, data: { notificationProcessed: true },
    });

    // Email is attempted AFTER the transaction, using the user's real address.
    expect(mockEmailSend).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1", to: "trader@example.com", subject: expect.stringContaining("EURUSD"),
    }));
  });

  it("respects notificationPreference: emailEnabled=false skips the EMAIL row and never calls emailSender", async () => {
    mockDb.notificationPreference.findUnique.mockResolvedValue({
      emailEnabled: false, inAppEnabled: true, categories: {},
    });
    mockDb.outboxEvent.findMany.mockResolvedValue([FILL_EVENT]);

    await notificationOutboxConsumer.processPending();

    expect(mockTx.notification.upsert).toHaveBeenCalledTimes(1);
    expect(mockTx.notification.upsert.mock.calls[0][0].create.channel).toBe("IN_APP");
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  it("respects notificationPreference: inAppEnabled=false skips the IN_APP row but still sends EMAIL", async () => {
    mockDb.notificationPreference.findUnique.mockResolvedValue({
      emailEnabled: true, inAppEnabled: false, categories: {},
    });
    mockDb.outboxEvent.findMany.mockResolvedValue([FILL_EVENT]);

    await notificationOutboxConsumer.processPending();

    expect(mockTx.notification.upsert).toHaveBeenCalledTimes(1);
    expect(mockTx.notification.upsert.mock.calls[0][0].create.channel).toBe("EMAIL");
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
  });

  it("position.closed: IN_APP only, no email attempted, formats a winning P&L with a leading +", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([CLOSE_EVENT_WIN]);

    const result = await notificationOutboxConsumer.processPending();

    expect(result).toEqual({ processed: 1, failed: 0, skipped: 0 });
    expect(mockTx.notification.upsert).toHaveBeenCalledTimes(1);
    const call = mockTx.notification.upsert.mock.calls[0][0];
    expect(call.create.channel).toBe("IN_APP");
    expect(call.create.title).toContain("EURUSD");
    expect(call.create.body).toBe("Realized P&L: +42.50 USD");
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  it("position.closed: formats a losing P&L without a leading +", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([CLOSE_EVENT_LOSS]);

    await notificationOutboxConsumer.processPending();

    expect(mockTx.notification.upsert.mock.calls[0][0].create.body).toBe("Realized P&L: -18.25 USD");
  });

  it("position.closed: mentions the write-off when negative balance protection absorbed part of the loss (FASE 5.2 Bug #8, LEDGER_FREEZE.md §0.8)", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([
      { ...CLOSE_EVENT_LOSS, payload: { ...CLOSE_EVENT_LOSS.payload, nbpWriteOff: 25.5 } },
    ]);

    await notificationOutboxConsumer.processPending();

    const body = mockTx.notification.upsert.mock.calls[0][0].create.body as string;
    expect(body).toContain("-18.25 USD");
    expect(body).toContain("25.50 USD");
    expect(body.toLowerCase()).toContain("negative balance protection");
  });

  it("position.closed: no write-off mention when nbpWriteOff is 0 or absent", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([CLOSE_EVENT_WIN]);

    await notificationOutboxConsumer.processPending();

    const body = mockTx.notification.upsert.mock.calls[0][0].create.body as string;
    expect(body).toBe("Realized P&L: +42.50 USD");
  });

  it("an event missing userId is marked processed and skipped, never reaches the transaction", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([
      { id: "outbox-no-user", eventType: "order.filled", userId: null, payload: {} },
    ]);

    const result = await notificationOutboxConsumer.processPending();

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 1 });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-no-user" }, data: { notificationProcessed: true },
    });
  });

  it("an unrecognized event type is marked processed without throwing (defensive — should be unreachable given the query filter)", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([
      { id: "outbox-unknown-1", eventType: "order.rejected", userId: "user-1", payload: {} },
    ]);

    const result = await notificationOutboxConsumer.processPending();

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 1 });
    expect(mockDb.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-unknown-1" }, data: { notificationProcessed: true },
    });
  });

  it("a failed event increments notificationRetries instead of being marked processed, and does not block the rest of the batch", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([FILL_EVENT, CLOSE_EVENT_WIN]);
    mockDb.$transaction.mockRejectedValueOnce(new Error("simulated DB error"));
    mockDb.outboxEvent.update.mockResolvedValue({ notificationRetries: 3 });

    const result = await notificationOutboxConsumer.processPending();

    expect(result).toEqual({ processed: 1, failed: 1, skipped: 0 });
    expect(mockDb.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "outbox-fill-1" },
      data:  { notificationRetries: { increment: 1 } },
      select: { notificationRetries: true },
    });
    expect(mockDb.outboxEvent.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "outbox-fill-1" }, data: { notificationProcessed: true } }),
    );
    // The second event in the batch still processed despite the first failing.
    expect(mockTx.notification.upsert).toHaveBeenCalledTimes(1);
    expect(mockNotificationConsumerFailure).not.toHaveBeenCalled();
  });

  it("alerts once a row's notificationRetries reaches the persistent-failure threshold", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([FILL_EVENT]);
    mockDb.$transaction.mockRejectedValue(new Error("still failing"));
    mockDb.outboxEvent.update.mockResolvedValue({ notificationRetries: 10 });

    const result = await notificationOutboxConsumer.processPending();

    expect(result.failed).toBe(1);
    expect(mockNotificationConsumerFailure).toHaveBeenCalledWith(
      "outbox-fill-1", "order.filled", 10, "still failing",
    );
  });
});
