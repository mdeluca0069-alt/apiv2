-- FASE 2.4 (Core Trading Certification) — reliable outbox-driven trade audit.
--
-- execution.engine.ts and settlement.engine.ts used to write TradeAudit
-- (and, on close, AuditLog) fire-and-forget, outside the financial
-- transaction, with a silent `catch {}`. A crash or transient DB error in
-- that window permanently lost the compliance record with no retry and no
-- alert — stage 10 ("Audit") of SYSTEM_ARCHITECTURE_FREEZE.md's 12-stage
-- order lifecycle snapshot.
--
-- Fix: the two order-lifecycle events that need an audit record
-- (order.filled / order.partial_filled / position.closed) now carry every
-- field the audit write needs directly in the OutboxEvent row already
-- created inside the same DB transaction as the fill/close (FASE 2.1).
-- compliance/audit.outbox.consumer.ts polls for unprocessed rows and turns
-- them into TradeAudit/AuditLog reliably, with retry and alerting on
-- persistent failure.
--
-- `auditProcessed` is a second, independent completion flag alongside the
-- existing `published` (WS delivery) flag on the same row — defaults to
-- true so the ~15 other event types that don't need an audit record (risk
-- warnings, wallet events, etc.) are never picked up by the consumer's poll
-- query. The three trade-lifecycle event types explicitly set it false.

ALTER TABLE "OutboxEvent" ADD COLUMN "auditProcessed" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "OutboxEvent" ADD COLUMN "auditRetries" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "OutboxEvent_auditProcessed_createdAt_idx" ON "OutboxEvent"("auditProcessed", "createdAt");
