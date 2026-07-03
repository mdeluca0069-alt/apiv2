-- Phase Omega Migration
-- FK constraints + Notification tables + order.cancel support + compliance tables
-- 2026-06-01

-- ─── updatedAt trigger (idempotent) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW."updatedAt" = CURRENT_TIMESTAMP; RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ─── AutopilotConfig FK ───────────────────────────────────────────────────────
ALTER TABLE "AutopilotConfig"
  DROP CONSTRAINT IF EXISTS "AutopilotConfig_userId_fkey";

ALTER TABLE "AutopilotConfig"
  ADD CONSTRAINT "AutopilotConfig_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE;

-- ─── KycCase FK ───────────────────────────────────────────────────────────────
ALTER TABLE "KycCase"
  DROP CONSTRAINT IF EXISTS "KycCase_userId_fkey";

ALTER TABLE "KycCase"
  ADD CONSTRAINT "KycCase_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE;

-- ─── MarginSnapshot FK ───────────────────────────────────────────────────────
ALTER TABLE "MarginSnapshot"
  DROP CONSTRAINT IF EXISTS "MarginSnapshot_userId_fkey";

ALTER TABLE "MarginSnapshot"
  ADD CONSTRAINT "MarginSnapshot_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE;

-- ─── SwapAccrual FK ──────────────────────────────────────────────────────────
ALTER TABLE "SwapAccrual"
  DROP CONSTRAINT IF EXISTS "SwapAccrual_positionId_fkey";

ALTER TABLE "SwapAccrual"
  ADD CONSTRAINT "SwapAccrual_positionId_fkey"
  FOREIGN KEY ("positionId") REFERENCES "Position" ("id") ON DELETE CASCADE;

ALTER TABLE "SwapAccrual"
  DROP CONSTRAINT IF EXISTS "SwapAccrual_userId_fkey";

ALTER TABLE "SwapAccrual"
  ADD CONSTRAINT "SwapAccrual_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE;

-- ─── OutboxEvent soft FK (userId is nullable — no cascade delete) ─────────────
-- Partial index to speed up per-user outbox queries
CREATE INDEX IF NOT EXISTS "OutboxEvent_userId_published_idx"
  ON "OutboxEvent" ("userId", "published")
  WHERE "userId" IS NOT NULL AND "published" = false;

-- ─── Notification table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Notification" (
  "id"            TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"        TEXT         NOT NULL,
  "channel"       TEXT         NOT NULL DEFAULT 'IN_APP',
  "category"      TEXT         NOT NULL DEFAULT 'system',
  "priority"      TEXT         NOT NULL DEFAULT 'NORMAL',
  "title"         TEXT         NOT NULL,
  "body"          TEXT         NOT NULL,
  "templateId"    TEXT,
  "payload"       JSONB,
  "sent"          BOOLEAN      NOT NULL DEFAULT false,
  "sentAt"        TIMESTAMP(3),
  "failureReason" TEXT,
  "retries"       INTEGER      NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Notification_userId_sent_idx"
  ON "Notification" ("userId", "sent");

CREATE INDEX IF NOT EXISTS "Notification_channel_sent_createdAt_idx"
  ON "Notification" ("channel", "sent", "createdAt");

CREATE INDEX IF NOT EXISTS "Notification_category_createdAt_idx"
  ON "Notification" ("category", "createdAt");

-- ─── NotificationPreference table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "NotificationPreference" (
  "id"           TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"       TEXT         NOT NULL,
  "emailEnabled" BOOLEAN      NOT NULL DEFAULT true,
  "smsEnabled"   BOOLEAN      NOT NULL DEFAULT false,
  "pushEnabled"  BOOLEAN      NOT NULL DEFAULT true,
  "inAppEnabled" BOOLEAN      NOT NULL DEFAULT true,
  "categories"   JSONB        NOT NULL DEFAULT '{}',
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NotificationPreference_userId_key"
  ON "NotificationPreference" ("userId");

CREATE INDEX IF NOT EXISTS "NotificationPreference_userId_idx"
  ON "NotificationPreference" ("userId");

DROP TRIGGER IF EXISTS "NotificationPreference_updatedAt" ON "NotificationPreference";
CREATE TRIGGER "NotificationPreference_updatedAt"
  BEFORE UPDATE ON "NotificationPreference"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Order status CANCELLED constraint extension ──────────────────────────────
ALTER TABLE "Order"
  DROP CONSTRAINT IF EXISTS "Order_status_check";

-- (Prisma uses String, not enum — constraint added for DB-level integrity)
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_status_check"
  CHECK ("status" IN (
    'RECEIVED','RISK_REVIEW','ACCEPTED',
    'PARTIALLY_FILLED','FILLED',
    'REJECTED','CANCELLED'
  ));

-- ─── Additional performance indexes ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Order_userId_status_createdAt_idx"
  ON "Order" ("userId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "Position_userId_status_openedAt_idx"
  ON "Position" ("userId", "status", "openedAt")
  WHERE "status" = 'OPEN';

CREATE INDEX IF NOT EXISTS "TradeAudit_userId_closedAt_idx"
  ON "TradeAudit" ("userId", "closedAt")
  WHERE "closedAt" IS NOT NULL;

-- Compliance audit log fast-path
CREATE INDEX IF NOT EXISTS "AuditLog_actor_action_idx"
  ON "AuditLog" ("actor", "action");
