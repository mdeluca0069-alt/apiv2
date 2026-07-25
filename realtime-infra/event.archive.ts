/**
 * Event Sourcing Archive — immutable append-only log of all domain events.
 *
 * Every event emitted on the internal eventBus is captured here, serialised
 * to JSONB, and batch-inserted into the EventSourceArchive partitioned table
 * every FLUSH_INTERVAL_MS (default 5 seconds).
 *
 * Design:
 *   – Buffer in memory → bulk INSERT (one roundtrip per flush cycle vs one
 *     INSERT per event). Throughput at 10,000 users can reach ~5,000 events/s;
 *     buffering prevents DB write amplification.
 *   – If the buffer exceeds MAX_BUFFER_SIZE before the flush timer fires,
 *     an immediate flush is triggered (back-pressure guard).
 *   – Rows are NEVER deleted or updated — corrections are new events with the
 *     original id in correlationId.
 *   – streamId is derived from the event payload: userId → "user:<userId>",
 *     symbol → "symbol:<symbol>", otherwise null.
 *
 * Graceful degradation:
 *   When DB is unavailable, events are discarded (not buffered indefinitely).
 *   The primary trading tables (LedgerEntry, TradeAudit) are the canonical
 *   source of truth; the archive is a supplementary audit log.
 */

import { randomUUID }       from "node:crypto";
import { eventBus }         from "../events-bus/event.bus.js";
import { prisma }           from "../shared/db.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const FLUSH_INTERVAL_MS = 5_000;
const MAX_BUFFER_SIZE   = 1_000;

// ── Types ─────────────────────────────────────────────────────────────────────
type ArchiveRow = {
  id:            string;
  eventType:     string;
  streamId:      string | null;
  correlationId: string | null;
  payload:       Record<string, unknown>;
  publishedAt:   Date;
};

export type ArchiveStats = {
  buffered:    number;
  flushed:     number;
  flushErrors: number;
  totalEvents: number;
  lastFlushAt: string | null;
  startedAt:   string;
};

// ── All event types to archive ────────────────────────────────────────────────
// Include every event type on the bus. High-frequency events (pnl_updated,
// market.quotes) are excluded to prevent storage exhaustion.
const ARCHIVED_EVENTS: Array<keyof import("../events-bus/event.bus.js").BrokerEventMap> = [
  "order.filled",
  "order.rejected",
  "position.opened",
  "position.closed",
  "signal.generated",
  "risk.warning",
  // FASE 7 CLOSURE, Phase A (M.6): compliance alerts split out of
  // risk.warning into their own event -- keep the same archive coverage
  // AML/sanctions/transaction-monitoring alerts already had under the old name.
  "compliance.alert",
  "wallet.event",
  // REALTIME_FREEZE.md Critical #1: "risk.stop_out"/"risk.margin_call" were
  // removed as event names entirely -- stopout.engine.ts now emits a single
  // canonical "margin.warning" for all three thresholds (WARNING/
  // MARGIN_CALL/STOP_OUT, disambiguated by its own `threshold` field), so
  // this one archive subscription now covers what used to require three.
  "margin.warning",
  "swap.accrued",
  // FASE 7 CLOSURE, Phase A (L.3, re-evaluated): these 8 were emitted with
  // zero consumer anywhere -- unlike a dead-both-ends event (L.2), the
  // emit sites are real and fire in production, so nothing was actually
  // broken, but nothing durably recorded these specific moments either
  // (kyc.service.ts/crm/affiliate.service.ts have immutableAudit.write()
  // calls for OTHER actions -- approval/rejection/commission-crediting --
  // not necessarily these exact ones; document.storage.service.ts has none
  // at all). Building live WS/UI consumers for these would be speculative
  // feature work outside this fix's scope; archiving them (the same
  // "produced but not durably recorded" gap this table already exists to
  // close for every other category) is not -- it's the minimum viable fix
  // that actually closes the gap rather than just documenting it.
  "kyc.document_uploaded",
  "kyc.docs_requested",
  "document.scan_clean",
  "document.scan_infected",
  "document.deleted",
  "affiliate.status_changed",
  "affiliate.referral_recorded",
  "affiliate.commission_accrued",
];

// ─────────────────────────────────────────────────────────────────────────────

class EventArchiveService {
  private buffer: ArchiveRow[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private subscribed = false;

  private _flushed     = 0;
  private _flushErrors = 0;
  private _totalEvents = 0;
  private _lastFlushAt: Date | null = null;
  private readonly _startedAt = new Date();

  /** Subscribe to the event bus and start the flush loop. */
  start(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    // Subscribe to all archived event types
    for (const eventType of ARCHIVED_EVENTS) {
      eventBus.on(eventType, (payload) => {
        this._capture(eventType, payload as Record<string, unknown>);
      });
    }

    this.flushTimer = setInterval(() => void this._flush(), FLUSH_INTERVAL_MS);
    console.log(`[event-archive] started — subscribing to ${ARCHIVED_EVENTS.length} event types`);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Flush remaining buffered events on shutdown
    if (this.buffer.length > 0) {
      void this._flush();
    }
  }

  /** Runtime stats for the admin monitoring endpoint. */
  getStats(): ArchiveStats {
    return {
      buffered:    this.buffer.length,
      flushed:     this._flushed,
      flushErrors: this._flushErrors,
      totalEvents: this._totalEvents,
      lastFlushAt: this._lastFlushAt?.toISOString() ?? null,
      startedAt:   this._startedAt.toISOString(),
    };
  }

  /**
   * Query archived events (for admin replay / regulatory inspection).
   * Returns up to limit rows in descending time order.
   */
  async query(opts: {
    streamId?:   string;
    eventType?:  string;
    from?:       Date;
    to?:         Date;
    limit?:      number;
  }): Promise<ArchiveRow[]> {
    if (!prisma) return [];

    const limit = Math.min(opts.limit ?? 50, 500);

    const where: string[] = ['"publishedAt" IS NOT NULL'];
    const params: unknown[] = [];

    if (opts.streamId)  { params.push(opts.streamId);  where.push(`"streamId" = $${params.length}`); }
    if (opts.eventType) { params.push(opts.eventType); where.push(`"eventType" = $${params.length}`); }
    if (opts.from)      { params.push(opts.from);       where.push(`"publishedAt" >= $${params.length}`); }
    if (opts.to)        { params.push(opts.to);         where.push(`"publishedAt" <= $${params.length}`); }

    params.push(limit);

    const sql = `
      SELECT id, "eventType", "streamId", "correlationId", payload, "publishedAt"
      FROM "EventSourceArchive"
      WHERE ${where.join(" AND ")}
      ORDER BY "publishedAt" DESC
      LIMIT $${params.length}
    `;

    try {
      const rows = await prisma.$queryRawUnsafe<ArchiveRow[]>(sql, ...params);
      return rows;
    } catch {
      return [];
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _capture(eventType: string, payload: Record<string, unknown>): void {
    this._totalEvents++;

    const streamId = this._deriveStreamId(payload);
    const row: ArchiveRow = {
      id:            randomUUID(),
      eventType,
      streamId,
      correlationId: (payload.correlationId as string | undefined) ?? null,
      payload,
      publishedAt:   new Date(),
    };

    this.buffer.push(row);

    // Back-pressure: flush immediately if buffer is full
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      void this._flush();
    }
  }

  private async _flush(): Promise<void> {
    if (this.buffer.length === 0 || !prisma) return;

    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      // Bulk INSERT via $executeRawUnsafe — Prisma doesn't support
      // createMany with arbitrary raw-SQL tables outside the schema.
      const values = batch
        .map((_, i) => {
          const base = i * 5;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb)`;
        })
        .join(", ");

      const params: unknown[] = [];
      for (const row of batch) {
        params.push(row.id, row.eventType, row.streamId, row.correlationId, JSON.stringify(row.payload));
      }

      await prisma.$executeRawUnsafe(
        `INSERT INTO "EventSourceArchive" (id, "eventType", "streamId", "correlationId", payload)
         VALUES ${values}
         ON CONFLICT DO NOTHING`,
        ...params,
      );

      this._flushed     += batch.length;
      this._lastFlushAt  = new Date();
    } catch (err) {
      this._flushErrors++;
      console.warn(`[event-archive] flush failed (${batch.length} events discarded):`, (err as Error).message);
    }
  }

  private _deriveStreamId(payload: Record<string, unknown>): string | null {
    if (payload.userId && typeof payload.userId === "string") {
      return `user:${payload.userId}`;
    }
    if (payload.symbol && typeof payload.symbol === "string") {
      return `symbol:${payload.symbol}`;
    }
    return null;
  }
}

export const eventArchive = new EventArchiveService();
export default eventArchive;
