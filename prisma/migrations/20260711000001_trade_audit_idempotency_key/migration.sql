-- FASE 2.4 follow-up — idempotency key for the audit outbox consumer.
--
-- compliance/audit.outbox.consumer.ts already wraps each TradeAudit
-- create/update + the source OutboxEvent's auditProcessed flip in one DB
-- transaction, so a genuine mid-write crash can't produce a flipped flag
-- without the audit row (or vice versa) — that half is already atomic.
--
-- The remaining gap: if the transaction COMMITS on the server but the
-- client never receives the acknowledgment (connection drop in that exact
-- window), the consumer's own retry-on-error path would attempt the same
-- INSERT again, producing a second, duplicate TradeAudit row for the same
-- fill — the one scenario a single transaction alone cannot rule out.
--
-- `sourceOutboxId` closes that gap: every TradeAudit row the consumer
-- creates carries the id of the OutboxEvent it came from. A retried INSERT
-- collides with the unique constraint instead of duplicating, and the
-- consumer treats that specific error as "already done" — true at-most-once
-- for the insert path, not just atomic-per-attempt.
--
-- Composite with "createdAt", not a plain unique on "sourceOutboxId" alone:
-- TradeAudit is partitioned by createdAt (Task 14) and Postgres requires
-- every unique index on a partitioned table to include the partition key.
-- This only holds because the consumer sets "createdAt" explicitly from the
-- source OutboxEvent's own createdAt rather than now() — deterministic
-- across retries, so the composite key is exactly as unique in practice as
-- sourceOutboxId alone would be.

ALTER TABLE "TradeAudit" ADD COLUMN "sourceOutboxId" TEXT;
CREATE UNIQUE INDEX "TradeAudit_sourceOutboxId_createdAt_key" ON "TradeAudit"("sourceOutboxId", "createdAt");
