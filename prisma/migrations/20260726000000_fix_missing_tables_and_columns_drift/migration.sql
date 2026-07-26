-- PRODUCTION CUTOVER Stage 3 — fixes real migration-history drift discovered
-- during shadow-environment live testing (a completely fresh database,
-- created via `prisma migrate deploy` reporting "no pending migrations,"
-- was still missing real tables/columns the application code actively
-- depends on via Prisma models — not raw SQL).
--
-- This file is a DELIBERATELY MINIMAL, hand-curated subset of the full
-- `prisma migrate diff --from-migrations ... --to-schema-datamodel
-- schema.prisma` output. The full diff also proposed dropping
-- EventSourceArchive/LedgerEntryArchive/TradeAuditArchive (confirmed via
-- the live dev database: EventSourceArchive alone holds 49,053 real rows)
-- and several performance indexes (BRIN/DESC-ordered, patterns Prisma's
-- declarative `@@index` cannot express) -- all of those are raw-SQL-only
-- structures schema.prisma was never meant to declare, and the diff tool
-- has no way to know that; including them here would have been a
-- genuinely destructive "fix." Every statement below was individually
-- confirmed as a real, Prisma-modeled dependency real application code
-- calls (see PRODUCTION_DEPLOYMENT_CHECKLIST.md for the specific
-- grep evidence per table/column) before being included.

-- Position: openedByAutopilot is the exact column whose absence caused
-- BrokerState.hydrateFromDatabase() to throw P2022 and silently drop the
-- entire application into in-memory sandbox mode on a fresh database --
-- confirmed live during this Stage's shadow-environment testing.
ALTER TABLE "Position"
  ADD COLUMN "openedByAutopilot" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "initialStopLoss"  DECIMAL(18,8),
  ADD COLUMN "breakEvenApplied" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "trailingActive"   BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Position_openedByAutopilot_status_idx" ON "Position"("openedByAutopilot", "status");

-- AutopilotConfig: all 8 columns confirmed read/written by
-- autopilot-service/autopilot.position.manager.ts and autopilot.service.ts
-- (break-even trigger, trailing stop, ATR multiple, event-lock window,
-- daily/hours-open caps, regime-exit toggle).
ALTER TABLE "AutopilotConfig"
  ADD COLUMN "breakEvenTriggerR"   DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  ADD COLUMN "trailingStopEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "trailingActivationR" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
  ADD COLUMN "atrTrailMultiple"    DOUBLE PRECISION NOT NULL DEFAULT 2.0,
  ADD COLUMN "regimeExitEnabled"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "eventLockMinutes"    INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "maxDailyTrades"      INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "maxHoursOpen"        INTEGER NOT NULL DEFAULT 48;

-- Watchlist: entire table missing. Confirmed real, active Prisma usage
-- (create/find/update/delete/count) in watchlist-service/watchlist.service.ts.
CREATE TABLE "Watchlist" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "symbols"   TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Watchlist_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Watchlist_userId_idx" ON "Watchlist"("userId");
CREATE UNIQUE INDEX "Watchlist_userId_name_key" ON "Watchlist"("userId", "name");

ALTER TABLE "Watchlist" ADD CONSTRAINT "Watchlist_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- StoredDocument: entire table missing. Confirmed real, active Prisma
-- usage (create/update/findUnique/findMany) in
-- document-storage/document.storage.service.ts and gateway/routes.ts --
-- this is the KYC/general document-upload storage table.
CREATE TABLE "StoredDocument" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "category"        TEXT NOT NULL,
    "fileName"        TEXT NOT NULL,
    "mimeType"        TEXT NOT NULL,
    "sizeBytes"       INTEGER NOT NULL,
    "storageKey"      TEXT NOT NULL,
    "storageBucket"   TEXT NOT NULL,
    "storageProvider" TEXT NOT NULL,
    "encryptedDek"    TEXT,
    "scanStatus"      TEXT NOT NULL DEFAULT 'PENDING',
    "scanResult"      JSONB,
    "scannedAt"       TIMESTAMP(3),
    "status"          TEXT NOT NULL DEFAULT 'QUARANTINE',
    "retentionPolicy" TEXT NOT NULL DEFAULT 'STANDARD',
    "retentionUntil"  TIMESTAMP(3),
    "kycDocumentId"   TEXT,
    "metadata"        JSONB,
    "uploadedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt"       TIMESTAMP(3),

    CONSTRAINT "StoredDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StoredDocument_userId_status_idx"    ON "StoredDocument"("userId", "status");
CREATE INDEX "StoredDocument_category_status_idx"  ON "StoredDocument"("category", "status");
CREATE INDEX "StoredDocument_scanStatus_idx"        ON "StoredDocument"("scanStatus");
CREATE INDEX "StoredDocument_retentionUntil_idx"    ON "StoredDocument"("retentionUntil");
CREATE INDEX "StoredDocument_storageKey_idx"        ON "StoredDocument"("storageKey");

ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DepositTransaction: entire table missing. Confirmed real, active Prisma
-- usage in payment-service/deposit.state.machine.ts,
-- payment-service/payment.service.ts, settlement/enhanced.reconciliation.service.ts,
-- and gateway/routes.ts -- THIS IS THE TABLE BACKING EVERY REAL PSP
-- DEPOSIT (Stripe/Nuvei/Praxis). A fresh production deployment without
-- this table would be unable to process a single real deposit.
CREATE TABLE "DepositTransaction" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "psp"         TEXT NOT NULL,
    "pspRef"      TEXT,
    "sessionId"   TEXT,
    "amount"      DECIMAL(18,8) NOT NULL,
    "currency"    TEXT NOT NULL DEFAULT 'USD',
    "status"      TEXT NOT NULL,
    "redirectUrl" TEXT,
    "returnUrl"   TEXT,
    "webhookData" JSONB,
    "failReason"  TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pendingAt"   TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "creditedAt"  TIMESTAMP(3),

    CONSTRAINT "DepositTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DepositTransaction_pspRef_key"          ON "DepositTransaction"("pspRef");
CREATE INDEX "DepositTransaction_userId_status_idx"          ON "DepositTransaction"("userId", "status");
CREATE INDEX "DepositTransaction_userId_requestedAt_idx"     ON "DepositTransaction"("userId", "requestedAt");
CREATE INDEX "DepositTransaction_psp_status_idx"             ON "DepositTransaction"("psp", "status");
CREATE INDEX "DepositTransaction_status_requestedAt_idx"     ON "DepositTransaction"("status", "requestedAt");

ALTER TABLE "DepositTransaction" ADD CONSTRAINT "DepositTransaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
