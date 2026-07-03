-- Production Hardening Migration
-- Phase 4: Database indexes + constraints + Session expiry

-- ─── AuditLog indexes ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "AuditLog_actor_createdAt_idx"
  ON "AuditLog" ("actor", "createdAt");

CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx"
  ON "AuditLog" ("action", "createdAt");

CREATE INDEX IF NOT EXISTS "AuditLog_entity_createdAt_idx"
  ON "AuditLog" ("entity", "createdAt");

-- ─── Session indexes + expiry column ─────────────────────────────────────────
ALTER TABLE "Session"
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3)
    NOT NULL DEFAULT (NOW() + INTERVAL '7 days');

CREATE INDEX IF NOT EXISTS "Session_userId_idx"
  ON "Session" ("userId");

CREATE INDEX IF NOT EXISTS "Session_expiresAt_idx"
  ON "Session" ("expiresAt");

-- ─── LedgerEntry additional indexes ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "LedgerEntry_reference_idx"
  ON "LedgerEntry" ("reference");

CREATE INDEX IF NOT EXISTS "LedgerEntry_userId_type_status_idx"
  ON "LedgerEntry" ("userId", "type", "status");

-- ─── LedgerEntry type constraint ─────────────────────────────────────────────
ALTER TABLE "LedgerEntry"
  DROP CONSTRAINT IF EXISTS "LedgerEntry_type_check";

ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_type_check"
  CHECK ("type" IN (
    'DEPOSIT_REQUEST', 'WITHDRAW_REQUEST', 'ADMIN_CAPITAL_ALLOCATION',
    'MARGIN_LOCK', 'MARGIN_RESERVED', 'MARGIN_RELEASE', 'MARGIN_RELEASED',
    'PNL_CREDIT', 'PNL_DEBIT', 'FEE', 'SWAP', 'DOCUMENT_EVENT',
    'COMMISSION', 'ADJUSTMENT'
  ));

-- ─── ClientDocument indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "ClientDocument_status_idx"
  ON "ClientDocument" ("status");

CREATE INDEX IF NOT EXISTS "ClientDocument_userId_status_idx"
  ON "ClientDocument" ("userId", "status");

-- ─── TradeAudit indexes ───────────────────────────────────────────────────────
DROP INDEX IF EXISTS "TradeAudit_userId_idx";
DROP INDEX IF EXISTS "TradeAudit_symbol_idx";
DROP INDEX IF EXISTS "TradeAudit_createdAt_idx";

CREATE INDEX IF NOT EXISTS "TradeAudit_userId_createdAt_idx"
  ON "TradeAudit" ("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "TradeAudit_userId_tradeStatus_idx"
  ON "TradeAudit" ("userId", "tradeStatus");

CREATE INDEX IF NOT EXISTS "TradeAudit_symbol_tradeStatus_idx"
  ON "TradeAudit" ("symbol", "tradeStatus");

CREATE INDEX IF NOT EXISTS "TradeAudit_orderId_idx"
  ON "TradeAudit" ("orderId");

CREATE INDEX IF NOT EXISTS "TradeAudit_positionId_idx"
  ON "TradeAudit" ("positionId");

-- ─── OlosSignal indexes ───────────────────────────────────────────────────────
DROP INDEX IF EXISTS "OlosSignal_userId_idx";
DROP INDEX IF EXISTS "OlosSignal_symbol_idx";
DROP INDEX IF EXISTS "OlosSignal_status_idx";

CREATE INDEX IF NOT EXISTS "OlosSignal_userId_status_idx"
  ON "OlosSignal" ("userId", "status");

CREATE INDEX IF NOT EXISTS "OlosSignal_symbol_status_idx"
  ON "OlosSignal" ("symbol", "status");

CREATE INDEX IF NOT EXISTS "OlosSignal_userId_createdAt_idx"
  ON "OlosSignal" ("userId", "createdAt");

-- ─── RiskWarning indexes ──────────────────────────────────────────────────────
DROP INDEX IF EXISTS "RiskWarning_userId_idx";
DROP INDEX IF EXISTS "RiskWarning_severity_idx";

CREATE INDEX IF NOT EXISTS "RiskWarning_userId_acknowledged_idx"
  ON "RiskWarning" ("userId", "acknowledged");

CREATE INDEX IF NOT EXISTS "RiskWarning_userId_severity_idx"
  ON "RiskWarning" ("userId", "severity");

CREATE INDEX IF NOT EXISTS "RiskWarning_userId_createdAt_idx"
  ON "RiskWarning" ("userId", "createdAt");

-- ─── OutboxEvent: improve sweep query performance ─────────────────────────────
CREATE INDEX IF NOT EXISTS "OutboxEvent_published_retries_createdAt_idx"
  ON "OutboxEvent" ("published", "retries", "createdAt")
  WHERE "published" = false;

-- ─── Position: additional index for liquidation engine ────────────────────────
CREATE INDEX IF NOT EXISTS "Position_status_symbol_idx"
  ON "Position" ("status", "symbol")
  WHERE "status" = 'OPEN';

-- ─── WalletAccount: partial index for balance checks ─────────────────────────
CREATE INDEX IF NOT EXISTS "WalletAccount_userId_balance_idx"
  ON "WalletAccount" ("userId", "balance");

-- ─── Expire old sessions (cleanup) ───────────────────────────────────────────
-- Run periodically; safe to re-run
DELETE FROM "Session" WHERE "expiresAt" < NOW();
