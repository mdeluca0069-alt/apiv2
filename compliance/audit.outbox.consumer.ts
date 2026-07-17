/**
 * AuditOutboxConsumer — reliable delivery of TradeAudit/AuditLog records.
 *
 * FASE 2.4 (Core Trading Certification, stage 10 "Audit"). Previously
 * execution.engine.ts and settlement.engine.ts wrote TradeAudit (and, on
 * close, AuditLog) fire-and-forget after their financial transaction
 * committed, with a silent `catch {}` — a crash or transient DB error in
 * that window permanently lost the compliance record with no retry and no
 * alert.
 *
 * Now those two call sites only enrich the OutboxEvent row they already
 * write transactionally (FASE 2.1) with the fields an audit record needs,
 * and set `auditProcessed: false` on it. This consumer polls for those rows
 * and turns them into TradeAudit/AuditLog — each event's audit write(s) and
 * its `auditProcessed = true` flip happen inside one Prisma transaction, so
 * a crash between "audit row written" and "marked processed" cannot happen:
 * either both commit or neither does, and the next poll retries cleanly.
 *
 * Idempotency beyond the transaction boundary: a transaction can COMMIT on
 * the server while the client never sees the ack (connection drop in that
 * exact window) — the one case a single transaction can't rule out, and the
 * consumer's own retry-on-error path would otherwise re-attempt the same
 * write. Every TradeAudit row this consumer creates is an `upsert` keyed on
 * `sourceOutboxId` (composite with `createdAt`, which this consumer always
 * sets deterministically from the source event rather than `now()` — see
 * the partitioning note on the schema field) instead of a plain `create`: a
 * retried attempt lands on the same row and no-ops instead of duplicating.
 * (A `create` wrapped in try/catch for the unique-violation would NOT work
 * here — Postgres aborts the whole transaction on the first statement
 * error, so every statement after it, including the auditProcessed flip,
 * would fail too, even with the JS exception caught.) AuditLog does not get
 * the same key: it has no per-entity uniqueness anywhere else in the
 * codebase either, and moving it from "fire-and-forget, can be lost
 * entirely" to "transactional, at-least-once" is already strictly better
 * than before FASE 2.4.
 *
 * `auditProcessed`/`auditRetries` are independent of `published` (WS
 * delivery, FASE 2.1) on the same row — the same OutboxEvent row serves
 * both consumers without interfering with each other, and outbox-cleanup
 * (main.ts) only prunes rows once BOTH are done.
 *
 * Scheduling: main.ts registers this with JobCoordinator and runs it on a
 * short interval (single leader across the cluster, like outbox-retry-sweep).
 */

import { Decimal }   from "@prisma/client/runtime/library";
import { prisma }    from "../shared/db.js";
import { metrics }   from "../gateway/metrics.js";
import { alertManager } from "../alerting/alert.manager.js";

const AUDITED_EVENT_TYPES = ["order.filled", "order.partial_filled", "position.closed"] as const;
const BATCH_SIZE       = 200;
const MAX_ROW_RETRIES  = 10; // matches OutboxService's own MAX_RETRIES for WS delivery

type OrderFillPayload = {
  orderId: string; positionId: string; userId: string; symbol: string; side: string;
  fillPrice: number; marginUsed: number; notional: number; filledQuantity: number;
  slippage: number; fees: number; leverage: number;
  stopLoss: number | null; takeProfit: number | null; tradeStatus: string;
  remainingQty?: number; cumulativeFilled?: number;
};

type PositionClosedPayload = {
  positionId: string; userId: string; symbol: string; side: string;
  pnl: number; netCredit: number; exitPrice: number; reason: string; detail: string;
  entryPrice: number; quantity: number; leverage: number; openedAt: string;
  rawPnl: number; pnlPercent: number; commission: number; swap: number;
  marginUsedRequested: number; marginUsedReleased: number; marginDiscrepancy: number;
  /** LEDGER_FREEZE.md §0.8: settlement.engine.ts always sends this (0 when no
   *  write-off happened) — must be copied through to the durable audit trail,
   *  never dropped, since the source OutboxEvent row is pruned a few hours
   *  after processing and this is the only other place the fact survives. */
  nbpWriteOff: number;
};

export type AuditConsumerResult = { processed: number; failed: number; skipped: number };

export class AuditOutboxConsumer {
  /**
   * Process one batch of unprocessed audit-bearing OutboxEvent rows,
   * oldest first. Safe to call concurrently across workers ONLY under the
   * caller's leader-election lock (main.ts) — no per-row locking here.
   */
  async processPending(): Promise<AuditConsumerResult> {
    const db = prisma as NonNullable<typeof prisma>;
    const result: AuditConsumerResult = { processed: 0, failed: 0, skipped: 0 };

    const events = await db.outboxEvent.findMany({
      where:   { auditProcessed: false, eventType: { in: [...AUDITED_EVENT_TYPES] } },
      orderBy: { createdAt: "asc" },
      take:    BATCH_SIZE,
    });

    for (const event of events) {
      try {
        if (event.eventType === "order.filled" || event.eventType === "order.partial_filled") {
          await this._processFill(db, event.id, event.createdAt, event.payload as OrderFillPayload);
        } else if (event.eventType === "position.closed") {
          await this._processClose(db, event.id, event.createdAt, event.payload as PositionClosedPayload);
        } else {
          // Unreachable given the `where` filter above — guards against a
          // future event type being added to AUDITED_EVENT_TYPES without a
          // matching branch here; never leave a row stuck retrying forever
          // for a type this consumer doesn't know how to handle.
          await db.outboxEvent.update({ where: { id: event.id }, data: { auditProcessed: true } });
          result.skipped++;
          continue;
        }
        result.processed++;
      } catch (err) {
        result.failed++;
        const updated = await db.outboxEvent.update({
          where: { id: event.id },
          data:  { auditRetries: { increment: 1 } },
          select: { auditRetries: true },
        });
        const message = (err as Error).message;
        console.error(`[audit-consumer] event=${event.id} type=${event.eventType} retries=${updated.auditRetries} failed:`, message);
        metrics.inc("audit_consumer_failures_total");
        if (updated.auditRetries >= MAX_ROW_RETRIES) {
          void alertManager.auditConsumerFailure(event.id, event.eventType, updated.auditRetries, message);
        }
      }
    }

    return result;
  }

  private async _processFill(
    db: NonNullable<typeof prisma>,
    outboxId: string,
    outboxCreatedAt: Date,
    p: OrderFillPayload,
  ): Promise<void> {
    const isPartial   = p.tradeStatus === "PARTIAL";
    const originalQty = isPartial ? (p.cumulativeFilled ?? p.filledQuantity) + (p.remainingQty ?? 0) : p.filledQuantity;

    const data = {
      userId:      p.userId,
      orderId:     p.orderId,
      positionId:  p.positionId,
      symbol:      p.symbol,
      side:        p.side,
      quantity:    new Decimal(p.filledQuantity),
      entryPrice:  new Decimal(p.fillPrice),
      marginUsed:  new Decimal(p.marginUsed),
      leverage:    p.leverage,
      fees:        new Decimal(p.fees),
      slippage:    new Decimal(p.slippage),
      stopLoss:    p.stopLoss   != null ? new Decimal(p.stopLoss)   : null,
      takeProfit:  p.takeProfit != null ? new Decimal(p.takeProfit) : null,
      tradeStatus: p.tradeStatus,
      createdAt:   outboxCreatedAt,
      sourceOutboxId: outboxId,
      lifecycle: JSON.stringify([{
        status:    p.tradeStatus,
        timestamp: outboxCreatedAt.toISOString(),
        detail:    isPartial
          ? `Partial fill ${p.filledQuantity}/${originalQty} @ ${p.fillPrice}`
          : `Opened @ ${p.fillPrice}`,
      }]),
      riskMetrics: JSON.stringify({
        marginRequired: p.marginUsed,
        notional:       p.notional,
        leverage:       p.leverage,
        ...(isPartial ? { remainingQty: p.remainingQty, cumulativeFilled: p.cumulativeFilled } : {}),
      }),
    };

    await db.$transaction(async (tx) => {
      // upsert, not create: a retry of an event already committed on a
      // prior attempt (ack lost after commit) lands on the same
      // sourceOutboxId+createdAt row and no-ops instead of duplicating.
      await tx.tradeAudit.upsert({
        where:  { sourceOutboxId_createdAt: { sourceOutboxId: outboxId, createdAt: outboxCreatedAt } },
        create: data,
        update: {},
      });
      await tx.outboxEvent.update({ where: { id: outboxId }, data: { auditProcessed: true } });
    });
  }

  private async _processClose(
    db: NonNullable<typeof prisma>,
    outboxId: string,
    outboxCreatedAt: Date,
    p: PositionClosedPayload,
  ): Promise<void> {
    const closedAt = outboxCreatedAt;
    const duration = Math.floor((closedAt.getTime() - new Date(p.openedAt).getTime()) / 60_000);

    await db.$transaction(async (tx) => {
      const closedData = {
        exitPrice:   new Decimal(p.exitPrice),
        pnlRealized: new Decimal(p.pnl),
        pnlPercent:  new Decimal(p.pnlPercent),
        fees:        new Decimal(p.commission),
        tradeStatus: "CLOSED",
        closedAt,
        duration,
      };
      // Naturally idempotent on retry — re-applying the same closedData is a
      // no-op difference, unlike an INSERT.
      const updated = await tx.tradeAudit.updateMany({
        where: { positionId: p.positionId },
        data:  closedData,
      });
      if (updated.count === 0) {
        // The OPEN row hasn't been written yet (its own fill event is still
        // pending in this same batch/queue, or arrived out of order) — write
        // a CLOSED-only row now. The fill event, when it processes, always
        // upserts rather than blindly inserting, so this never gets
        // duplicated by it. upsert (not create) here too: a retry of an
        // event already committed on a prior attempt (ack lost after
        // commit) lands on the same sourceOutboxId+createdAt row and no-ops
        // — updateMany above would normally already have found it on a
        // real retry (same positionId), this only guards the narrow window
        // where both races align.
        await tx.tradeAudit.upsert({
          where:  { sourceOutboxId_createdAt: { sourceOutboxId: outboxId, createdAt: outboxCreatedAt } },
          update: {},
          create: {
            userId:      p.userId,
            orderId:     null,
            positionId:  p.positionId,
            symbol:      p.symbol,
            side:        p.side,
            quantity:    new Decimal(p.quantity),
            entryPrice:  new Decimal(p.entryPrice),
            exitPrice:   new Decimal(p.exitPrice),
            pnlRealized: new Decimal(p.pnl),
            pnlPercent:  new Decimal(p.pnlPercent),
            marginUsed:  new Decimal(p.marginUsedRequested),
            leverage:    p.leverage,
            fees:        new Decimal(p.commission),
            tradeStatus: "CLOSED",
            closedAt,
            duration,
            createdAt:   outboxCreatedAt,
            sourceOutboxId: outboxId,
            lifecycle: JSON.stringify([{
              status:    "CLOSED",
              timestamp: closedAt.toISOString(),
              detail:    `${p.reason} close @ ${p.exitPrice}`,
              actor:     "SYSTEM",
            }]),
            riskMetrics: JSON.stringify({ reason: p.reason, netCredit: p.netCredit, nbpWriteOff: p.nbpWriteOff }),
          },
        });
      }

      await tx.auditLog.create({
        data: {
          actor:   p.userId,
          action:  `position.${p.reason.toLowerCase()}`,
          entity:  p.positionId,
          payload: {
            positionId:          p.positionId,
            symbol:              p.symbol,
            side:                p.side,
            quantity:            p.quantity,
            entryPrice:          p.entryPrice,
            exitPrice:           p.exitPrice,
            rawPnl:              p.rawPnl,
            cappedPnl:           p.pnl,
            commission:          p.commission,
            swap:                p.swap,
            netCredit:           p.netCredit,
            marginUsedRequested: p.marginUsedRequested,
            marginUsedReleased:  p.marginUsedReleased,
            marginDiscrepancy:   p.marginDiscrepancy,
            nbpWriteOff:         p.nbpWriteOff,
            reason:              p.reason,
            detail:              p.detail,
          } as object,
          createdAt: closedAt,
        },
      });

      await tx.outboxEvent.update({ where: { id: outboxId }, data: { auditProcessed: true } });
    });
  }
}

export const auditOutboxConsumer = new AuditOutboxConsumer();
export default auditOutboxConsumer;
