import { prisma, IS_PERSISTENT } from "../shared/db.js";

// Maximum retries before an event is abandoned.
const MAX_RETRIES = 10;

export type OutboxRecord = {
  id:        string;
  eventType: string;
  payload:   unknown;
  createdAt: Date;
};

/**
 * Transactional Outbox for WebSocket events.
 *
 * Critical user-facing events (fills, rejections, margin calls, etc.) are
 * written to the OutboxEvent table before the in-process push attempt.
 * If the client is offline at publish time, the event survives a server
 * restart and is replayed on the next authenticated connection.
 *
 * In SANDBOX mode (no DATABASE_URL) all methods are no-ops.
 */
export class OutboxService {
  /** Persist an event so it can be replayed if the WS push fails. */
  async enqueue(
    eventType: string,
    payload:   Record<string, unknown>,
    userId?:   string,
  ): Promise<string | null> {
    if (!IS_PERSISTENT) return null;
    try {
      const row = await (prisma as NonNullable<typeof prisma>).outboxEvent.create({
        data: { eventType, payload: payload as object, userId: userId ?? null },
      });
      return row.id;
    } catch (err) {
      console.error("[outbox] enqueue failed:", (err as Error).message);
      return null;
    }
  }

  /** Mark an event as successfully delivered. */
  async markPublished(id: string): Promise<void> {
    if (!IS_PERSISTENT) return;
    try {
      await (prisma as NonNullable<typeof prisma>).outboxEvent.update({
        where: { id },
        data:  { published: true, publishedAt: new Date() },
      });
    } catch {
      // Non-fatal: worst case the event gets replayed once more.
    }
  }

  /**
   * Return all undelivered events for a user, oldest-first.
   * Called when a client (re)connects so missed events can be replayed.
   */
  async getPendingForUser(userId: string): Promise<OutboxRecord[]> {
    if (!IS_PERSISTENT) return [];
    try {
      return await (prisma as NonNullable<typeof prisma>).outboxEvent.findMany({
        where:   { userId, published: false, retries: { lt: MAX_RETRIES } },
        orderBy: { createdAt: "asc" },
        take:    200,
        select:  { id: true, eventType: true, payload: true, createdAt: true },
      });
    } catch {
      return [];
    }
  }

  /**
   * Background recovery sweep.
   *
   * Finds events that are still unpublished and attempts to re-deliver them
   * via `pushFn`.  Returns the number successfully delivered.
   *
   * @param maxAge   Only consider events created after this timestamp.
   * @param pushFn   Delivery callback; returns true when the client is online.
   */
  async retryUnpublished(
    maxAge:  Date,
    pushFn:  (userId: string, eventType: string, payload: unknown) => boolean,
  ): Promise<number> {
    if (!IS_PERSISTENT) return 0;
    let delivered = 0;
    try {
      const events = await (prisma as NonNullable<typeof prisma>).outboxEvent.findMany({
        where: {
          published: false,
          userId:    { not: null },
          retries:   { lt: MAX_RETRIES },
          createdAt: { gte: maxAge },
        },
        orderBy: { createdAt: "asc" },
        take:    100,
      });

      for (const evt of events) {
        const userId = evt.userId!;
        if (pushFn(userId, evt.eventType, evt.payload)) {
          await this.markPublished(evt.id);
          delivered++;
        } else {
          await (prisma as NonNullable<typeof prisma>).outboxEvent.update({
            where: { id: evt.id },
            data:  { retries: { increment: 1 } },
          });
        }
      }
    } catch (err) {
      console.error("[outbox] retry sweep failed:", (err as Error).message);
    }
    return delivered;
  }
}

export const outboxService = new OutboxService();
