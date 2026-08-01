-- PHASE2_REMEDIATION (H17) — AML alert dispositions previously lived only
-- in an in-memory Map on the BrokerState singleton (shared/state.ts) and
-- were silently reset to PENDING on every process restart. This table
-- persists a compliance officer's review decision (status/reviewedBy/
-- note) keyed by the same deterministic alert id getAmlAlerts() already
-- derives from the underlying AuditLog finding.

-- CreateTable
CREATE TABLE "AmlAlertDisposition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reviewedBy" TEXT NOT NULL,
    "note" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmlAlertDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AmlAlertDisposition_status_idx" ON "AmlAlertDisposition"("status");

-- CreateIndex
CREATE INDEX "AmlAlertDisposition_userId_idx" ON "AmlAlertDisposition"("userId");
