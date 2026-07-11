/**
 * NotificationOutboxConsumer — reliable delivery of order-lifecycle notifications.
 *
 * FASE 2.6 (Core Trading Certification, stage 12 "Notifica"). Previously
 * notification.router.ts's `order.filled`/`position.closed` eventBus
 * listeners wrote a Notification row (and, for order.filled, sent an
 * email) via an unawaited `void this.sendAll(...)`/`void this.send(...)`
 * call — an unhandled rejection there (a transient DB error, for example)
 * is silently swallowed by Node, with zero retry and zero durable record
 * that a notification should have existed. Same shape as the pre-2.4
 * audit bug.
 *
 * Both event types already write a transactionally-durable OutboxEvent row
 * (FASE 2.1); this consumer polls for the ones flagged
 * `notificationProcessed: false` and turns them into Notification rows
 * reliably — the DB write and the flag flip commit in one transaction, and
 * each row is an idempotent upsert keyed on `sourceOutboxId` (composite
 * with `channel`, since a single order.filled event produces two rows —
 * IN_APP and EMAIL) so a retry after a lost commit ack lands on the same
 * row instead of duplicating it in the user's inbox — same reasoning as
 * TradeAudit.sourceOutboxId in compliance/audit.outbox.consumer.ts.
 *
 * The actual email SEND (external SMTP, can't be part of a DB transaction)
 * happens after that transaction commits, best-effort — exactly the
 * fire-once, log-on-failure semantics notification.router.ts already had;
 * this fixes the DURABILITY of the notification's existence, not the
 * delivery guarantee of the email itself.
 *
 * Every other notification.router.ts trigger (KYC, support, autopilot,
 * signals, wallet, risk/margin warnings, account) is unrelated to the
 * order lifecycle this OutboxEvent row exists for and is deliberately left
 * on the existing fire-and-forget path — out of scope for this phase.
 */

import { prisma }       from "../shared/db.js";
import { metrics }      from "../gateway/metrics.js";
import { alertManager } from "../alerting/alert.manager.js";
import { emailSender }  from "./email.sender.js";

const NOTIFIED_EVENT_TYPES = ["order.filled", "position.closed"] as const;
const BATCH_SIZE      = 200;
const MAX_ROW_RETRIES  = 10; // matches the audit consumer's own threshold

type OrderFilledPayload = {
  symbol: string; side: string; fillPrice: number; filledQuantity: number;
};

type PositionClosedPayload = {
  symbol: string; pnl: number;
};

type Channel = "IN_APP" | "EMAIL";

export type NotificationConsumerResult = { processed: number; failed: number; skipped: number };

export class NotificationOutboxConsumer {
  /**
   * Process one batch of unprocessed notification-bearing OutboxEvent rows,
   * oldest first. Safe to call concurrently across workers ONLY under the
   * caller's leader-election lock (main.ts) — no per-row locking here.
   */
  async processPending(): Promise<NotificationConsumerResult> {
    const db = prisma as NonNullable<typeof prisma>;
    const result: NotificationConsumerResult = { processed: 0, failed: 0, skipped: 0 };

    const events = await db.outboxEvent.findMany({
      where:   { notificationProcessed: false, eventType: { in: [...NOTIFIED_EVENT_TYPES] } },
      orderBy: { createdAt: "asc" },
      take:    BATCH_SIZE,
    });

    for (const event of events) {
      if (!event.userId) {
        // Every trade-lifecycle event carries a userId; defensive only.
        await db.outboxEvent.update({ where: { id: event.id }, data: { notificationProcessed: true } });
        result.skipped++;
        continue;
      }

      try {
        if (event.eventType === "order.filled") {
          const p = event.payload as OrderFilledPayload;
          await this._deliver(
            db, event.id, event.userId, "fill", "HIGH",
            `Order filled — ${p.symbol}`,
            `${p.side} ${p.filledQuantity} ${p.symbol} @ ${Number(p.fillPrice).toFixed(5)}`,
            ["IN_APP", "EMAIL"],
          );
        } else if (event.eventType === "position.closed") {
          const p = event.payload as PositionClosedPayload;
          const pnl = Number(p.pnl ?? 0);
          await this._deliver(
            db, event.id, event.userId, "fill", "NORMAL",
            `Position closed — ${p.symbol}`,
            `Realized P&L: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USD`,
            ["IN_APP"],
          );
        } else {
          // Unreachable given the `where` filter above — same defensive
          // guard as the audit consumer, never leave a row stuck forever.
          await db.outboxEvent.update({ where: { id: event.id }, data: { notificationProcessed: true } });
          result.skipped++;
          continue;
        }
        result.processed++;
      } catch (err) {
        result.failed++;
        const updated = await db.outboxEvent.update({
          where: { id: event.id },
          data:  { notificationRetries: { increment: 1 } },
          select: { notificationRetries: true },
        });
        const message = (err as Error).message;
        console.error(`[notification-consumer] event=${event.id} type=${event.eventType} retries=${updated.notificationRetries} failed:`, message);
        metrics.inc("notification_consumer_failures_total");
        if (updated.notificationRetries >= MAX_ROW_RETRIES) {
          void alertManager.notificationConsumerFailure(event.id, event.eventType, updated.notificationRetries, message);
        }
      }
    }

    return result;
  }

  /**
   * Write a Notification row per allowed channel (respecting user
   * preferences, same check notification.router.ts's send() already did)
   * and flip notificationProcessed inside one transaction, then — outside
   * the transaction, best-effort — actually send the email if EMAIL was
   * one of the allowed channels.
   */
  private async _deliver(
    db:       NonNullable<typeof prisma>,
    outboxId: string,
    userId:   string,
    category: string,
    priority: string,
    title:    string,
    body:     string,
    channels: Channel[],
  ): Promise<void> {
    const pref = await db.notificationPreference.findUnique({ where: { userId } });
    const allowed = channels.filter((ch) => {
      if (!pref) return true;
      if (ch === "EMAIL"  && !pref.emailEnabled)  return false;
      if (ch === "IN_APP" && !pref.inAppEnabled)  return false;
      const cats = (pref.categories as Record<string, boolean>) ?? {};
      if (cats[category] === false) return false;
      return true;
    });

    await db.$transaction(async (tx) => {
      for (const channel of allowed) {
        await tx.notification.upsert({
          where:  { sourceOutboxId_channel: { sourceOutboxId: outboxId, channel } },
          update: {},
          create: { userId, channel, category, priority, title, body, sourceOutboxId: outboxId },
        });
      }
      await tx.outboxEvent.update({ where: { id: outboxId }, data: { notificationProcessed: true } });
    });

    if (allowed.includes("EMAIL")) {
      const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
      await emailSender.send({ userId, to: user?.email, subject: title, text: body, html: `<p>${body}</p>` });
    }
  }
}

export const notificationOutboxConsumer = new NotificationOutboxConsumer();
export default notificationOutboxConsumer;
