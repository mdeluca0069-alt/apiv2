-- Migration: Ledger API + Autopilot Configuration + KYC Architecture
-- 2026-06-01

-- ─── AutopilotConfig ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "AutopilotConfig" (
  "id"               TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"           TEXT         NOT NULL,
  "enabled"          BOOLEAN      NOT NULL DEFAULT false,
  "mode"             TEXT         NOT NULL DEFAULT 'BALANCED',
  "minConfidence"    DOUBLE PRECISION NOT NULL DEFAULT 0.70,
  "maxRiskPerTrade"  DOUBLE PRECISION NOT NULL DEFAULT 0.05,
  "maxOpenTrades"    INTEGER      NOT NULL DEFAULT 3,
  "maxExposurePct"   DOUBLE PRECISION NOT NULL DEFAULT 20.0,
  "allowedSymbols"   TEXT[]       NOT NULL DEFAULT '{}',
  "blockedSymbols"   TEXT[]       NOT NULL DEFAULT '{}',
  "stopDrawdownPct"  DOUBLE PRECISION NOT NULL DEFAULT 10.0,
  "capitalPct"       DOUBLE PRECISION NOT NULL DEFAULT 100.0,
  "lastDecision"     JSONB,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AutopilotConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AutopilotConfig_userId_key"
  ON "AutopilotConfig" ("userId");

CREATE INDEX IF NOT EXISTS "AutopilotConfig_userId_idx"
  ON "AutopilotConfig" ("userId");

-- Trigger to keep updatedAt current
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AutopilotConfig_updatedAt" ON "AutopilotConfig";
CREATE TRIGGER "AutopilotConfig_updatedAt"
  BEFORE UPDATE ON "AutopilotConfig"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── KycCase ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "KycCase" (
  "id"                TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"            TEXT         NOT NULL,
  "status"            TEXT         NOT NULL DEFAULT 'SUBMITTED',
  "riskScore"         INTEGER      NOT NULL DEFAULT 0,
  "verificationScore" INTEGER      NOT NULL DEFAULT 0,
  "reviewNotes"       TEXT,
  "reviewedBy"        TEXT,
  "reviewedAt"        TIMESTAMP(3),
  "completedAt"       TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KycCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "KycCase_userId_key"
  ON "KycCase" ("userId");

CREATE INDEX IF NOT EXISTS "KycCase_userId_idx"
  ON "KycCase" ("userId");

CREATE INDEX IF NOT EXISTS "KycCase_status_idx"
  ON "KycCase" ("status");

CREATE INDEX IF NOT EXISTS "KycCase_createdAt_idx"
  ON "KycCase" ("createdAt");

DROP TRIGGER IF EXISTS "KycCase_updatedAt" ON "KycCase";
CREATE TRIGGER "KycCase_updatedAt"
  BEFORE UPDATE ON "KycCase"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── KycVerificationStep ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "KycVerificationStep" (
  "id"         TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "caseId"     TEXT         NOT NULL,
  "stepType"   TEXT         NOT NULL,
  "status"     TEXT         NOT NULL DEFAULT 'PENDING',
  "provider"   TEXT,
  "confidence" DOUBLE PRECISION,
  "result"     JSONB,
  "errorMsg"   TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KycVerificationStep_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KycVerificationStep_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "KycCase" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "KycVerificationStep_caseId_idx"
  ON "KycVerificationStep" ("caseId");

CREATE INDEX IF NOT EXISTS "KycVerificationStep_stepType_status_idx"
  ON "KycVerificationStep" ("stepType", "status");

DROP TRIGGER IF EXISTS "KycVerificationStep_updatedAt" ON "KycVerificationStep";
CREATE TRIGGER "KycVerificationStep_updatedAt"
  BEFORE UPDATE ON "KycVerificationStep"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── KycDocument ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "KycDocument" (
  "id"              TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "caseId"          TEXT         NOT NULL,
  "documentKey"     TEXT         NOT NULL,
  "label"           TEXT         NOT NULL,
  "status"          TEXT         NOT NULL DEFAULT 'PENDING',
  "fileName"        TEXT,
  "mimeType"        TEXT,
  "documentNumber"  TEXT,
  "extractedData"   JSONB,
  "livenessScore"   DOUBLE PRECISION,
  "matchScore"      DOUBLE PRECISION,
  "rejectionReason" TEXT,
  "reviewedBy"      TEXT,
  "reviewedAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KycDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KycDocument_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "KycCase" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "KycDocument_caseId_idx"
  ON "KycDocument" ("caseId");

CREATE INDEX IF NOT EXISTS "KycDocument_documentKey_status_idx"
  ON "KycDocument" ("documentKey", "status");

CREATE INDEX IF NOT EXISTS "KycDocument_documentNumber_idx"
  ON "KycDocument" ("documentNumber")
  WHERE "documentNumber" IS NOT NULL;

DROP TRIGGER IF EXISTS "KycDocument_updatedAt" ON "KycDocument";
CREATE TRIGGER "KycDocument_updatedAt"
  BEFORE UPDATE ON "KycDocument"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Ledger: add missing constraint on type ───────────────────────────────────
-- (extends the constraint added in the previous migration if it exists)
ALTER TABLE "LedgerEntry"
  DROP CONSTRAINT IF EXISTS "LedgerEntry_type_check";

ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_type_check"
  CHECK ("type" IN (
    'DEPOSIT_REQUEST','WITHDRAW_REQUEST','ADMIN_CAPITAL_ALLOCATION',
    'MARGIN_RESERVED','MARGIN_RELEASED','MARGIN_LOCK','MARGIN_RELEASE',
    'PNL_CREDIT','PNL_DEBIT','PNL_SETTLEMENT',
    'COMMISSION','SWAP','ADJUSTMENT','FEE','DOCUMENT_EVENT'
  ));

-- Performance: partial index for pending autopilot candidates
CREATE INDEX IF NOT EXISTS "AutopilotConfig_enabled_idx"
  ON "AutopilotConfig" ("enabled")
  WHERE "enabled" = true;

-- Performance: pending KYC review queue
CREATE INDEX IF NOT EXISTS "KycCase_status_createdAt_idx"
  ON "KycCase" ("status", "createdAt")
  WHERE "status" IN ('DOCUMENT_CHECK', 'SELFIE_CHECK', 'ADDRESS_CHECK', 'MANUAL_REVIEW');
