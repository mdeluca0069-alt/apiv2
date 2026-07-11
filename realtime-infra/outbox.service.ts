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
   *
   * FASE 2.7: deliberately NOT filtered by `retries < MAX_RETRIES`. That cap
   * exists to bound the background sweep's re-publish attempts (below), not
   * to decide whether a freshly (re)connected socket — a guaranteed-live
   * delivery opportunity, independent of however many times the sweep's
   * own attempts failed — should receive the event. Before this fix, a row
   * that hit MAX_RETRIES became invisible here too, silently and
   * permanently, even though the whole point of persisting it was that
   * reconnect-time replay is the last-resort guarantee.
   */
  async getPendingForUser(userId: string): Promise<OutboxRecord[]> {
    if (!IS_PERSISTENT) return [];
    try {
      return await (prisma as NonNullable<typeof prisma>).outboxEvent.findMany({
        where:   { userId, published: false },
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
   * FASE 2.7: this only ever runs on ONE leader-elected node (main.ts), but
   * the user it's trying to reach could be connected to any node in the
   * cluster. `pushFn` now also receives the outbox row's own id so the
   * caller can fall back to the same Redis cross-node relay the first
   * delivery attempt uses (enqueueAndPush) when local delivery misses —
   * whichever node actually has the user's socket marks the row published
   * itself, asynchronously, decoupled from this sweep's own retry counting.
   * Without that, a user connected to a non-leader node would see this
   * sweep fail every single cycle no matter how many times it ran.
   *
   * @param maxAge   Only consider events created after this timestamp.
   * @param pushFn   Delivery callback; returns true when THIS node has the
   *                 client online (a false return does not mean the user is
   *                 offline — see above).
   */
  async retryUnpublished(
    maxAge:  Date,
    pushFn:  (userId: string, eventType: string, payload: unknown, outboxId: string) => boolean,
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
        if (pushFn(userId, evt.eventType, evt.payload, evt.id)) {
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
