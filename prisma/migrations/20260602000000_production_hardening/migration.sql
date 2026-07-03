-- Production hardening migration: add FK constraints to previously unconstrained tables
-- and add missing indexes for performance.

-- ── MarginSnapshot → User ────────────────────────────────────────────────────
ALTER TABLE "MarginSnapshot" DROP CONSTRAINT IF EXISTS "MarginSnapshot_userId_fkey";
ALTER TABLE "MarginSnapshot"
  ADD CONSTRAINT "MarginSnapshot_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── AutopilotConfig → User ────────────────────────────────────────────────────
ALTER TABLE "AutopilotConfig" DROP CONSTRAINT IF EXISTS "AutopilotConfig_userId_fkey";
ALTER TABLE "AutopilotConfig"
  ADD CONSTRAINT "AutopilotConfig_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── KycCase → User ────────────────────────────────────────────────────────────
ALTER TABLE "KycCase" DROP CONSTRAINT IF EXISTS "KycCase_userId_fkey";
ALTER TABLE "KycCase"
  ADD CONSTRAINT "KycCase_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── SwapAccrual → User ────────────────────────────────────────────────────────
ALTER TABLE "SwapAccrual" DROP CONSTRAINT IF EXISTS "SwapAccrual_userId_fkey";
ALTER TABLE "SwapAccrual"
  ADD CONSTRAINT "SwapAccrual_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Notification → User ───────────────────────────────────────────────────────
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "Notification_userId_fkey";
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── NotificationPreference → User ─────────────────────────────────────────────
ALTER TABLE "NotificationPreference" DROP CONSTRAINT IF EXISTS "NotificationPreference_userId_fkey";
ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT "NotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Performance indexes ────────────────────────────────────────────────────────

-- LedgerEntry: high-frequency queries
CREATE INDEX IF NOT EXISTS "LedgerEntry_userId_type_idx"
  ON "LedgerEntry"("userId", "type");

CREATE INDEX IF NOT EXISTS "LedgerEntry_createdAt_idx"
  ON "LedgerEntry"("createdAt" DESC);

-- Order: dashboard queries
CREATE INDEX IF NOT EXISTS "Order_userId_status_createdAt_idx"
  ON "Order"("userId", "status", "createdAt" DESC);

-- Position: P&L recomputation
CREATE INDEX IF NOT EXISTS "Position_status_symbol_idx"
  ON "Position"("status", "symbol")
  WHERE "status" = 'OPEN';

-- AuditLog: compliance dashboard
CREATE INDEX IF NOT EXISTS "AuditLog_actor_action_idx"
  ON "AuditLog"("actor", "action");

CREATE INDEX IF NOT EXISTS "AuditLog_entity_createdAt_idx"
  ON "AuditLog"("entity", "createdAt" DESC);

-- TradeAudit: analytics queries
CREATE INDEX IF NOT EXISTS "TradeAudit_userId_closedAt_idx"
  ON "TradeAudit"("userId", "closedAt" DESC)
  WHERE "closedAt" IS NOT NULL;

-- MarginSnapshot: latest snapshot lookup
CREATE INDEX IF NOT EXISTS "MarginSnapshot_userId_createdAt_desc_idx"
  ON "MarginSnapshot"("userId", "createdAt" DESC);

-- Session: expiry cleanup job
CREATE INDEX IF NOT EXISTS "Session_expiresAt_idx"
  ON "Session"("expiresAt");

-- OutboxEvent: replay queries
CREATE INDEX IF NOT EXISTS "OutboxEvent_userId_published_idx"
  ON "OutboxEvent"("userId", "published")
  WHERE "published" = false;
