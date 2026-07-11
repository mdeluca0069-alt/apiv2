/**
 * outbox.service.spec.ts
 *
 * FASE 2.7 — Core Trading Certification (stage 11, WebSocket).
 *
 * Proves the reconnect-time replay path (getPendingForUser) is no longer
 * gated by the background sweep's own retry cap — a freshly reconnected
 * socket is a guaranteed-live delivery opportunity, independent of how many
 * times the leader-elected sweep's local-node-only attempts failed — and
 * that retryUnpublished threads the outbox row's own id to the delivery
 * callback so a caller can fall back to cross-node relay on a local miss.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    outboxEvent: {
      create:    vi.fn(),
      update:    vi.fn().mockResolvedValue({}),
      findMany:  vi.fn(),
    },
  };
  return { mockDb };
});
vi.mock("../shared/db.js", () => ({ prisma: mockDb, IS_PERSISTENT: true }));

const { outboxService } = await import("../realtime-infra/outbox.service.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.outboxEvent.update.mockResolvedValue({});
});

describe("OutboxService.getPendingForUser()", () => {
  it("does not filter by retries — a row that exhausted the sweep's retry cap is still returned for reconnect replay", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([
      { id: "evt-1", eventType: "order.filled", payload: {}, createdAt: new Date() },
    ]);

    await outboxService.getPendingForUser("user-1");

    const call = mockDb.outboxEvent.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: "user-1", published: false });
    expect(call.where.retries).toBeUndefined();
  });
});

describe("OutboxService.retryUnpublished()", () => {
  it("passes the outbox row's own id as the 4th argument to pushFn", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([
      { id: "evt-42", eventType: "position.closed", payload: { pnl: 10 }, userId: "user-1", retries: 2, createdAt: new Date() },
    ]);
    const pushFn = vi.fn().mockReturnValue(true);

    await outboxService.retryUnpublished(new Date(0), pushFn);

    expect(pushFn).toHaveBeenCalledWith("user-1", "position.closed", { pnl: 10 }, "evt-42");
  });

  it("marks published and does not increment retries when pushFn succeeds", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([
      { id: "evt-1", eventType: "order.filled", payload: {}, userId: "user-1", retries: 0, createdAt: new Date() },
    ]);
    const pushFn = vi.fn().mockReturnValue(true);

    const delivered = await outboxService.retryUnpublished(new Date(0), pushFn);

    expect(delivered).toBe(1);
    expect(mockDb.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "evt-1" }, data: { published: true, publishedAt: expect.any(Date) },
    });
  });

  it("increments retries (not published) when pushFn returns false — a local miss is not proof the user is offline", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([
      { id: "evt-1", eventType: "order.filled", payload: {}, userId: "user-1", retries: 3, createdAt: new Date() },
    ]);
    const pushFn = vi.fn().mockReturnValue(false);

    const delivered = await outboxService.retryUnpublished(new Date(0), pushFn);

    expect(delivered).toBe(0);
    expect(mockDb.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: "evt-1" }, data: { retries: { increment: 1 } },
    });
  });

  it("still filters the sweep's own query by retries < MAX_RETRIES (bounds background re-publish attempts, unlike reconnect replay)", async () => {
    mockDb.outboxEvent.findMany.mockResolvedValue([]);

    await outboxService.retryUnpublished(new Date(0), vi.fn());

    const call = mockDb.outboxEvent.findMany.mock.calls[0][0];
    expect(call.where.retries).toEqual({ lt: 10 });
  });
});
