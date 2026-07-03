-- Real-client safety layer for Autopilot: recorded consent, per-client daily
-- loss breaker, and spread/slippage guard. See ROADMAP discussion — this is
-- the compliance/safety gap closure on top of the existing gated pipeline.
ALTER TABLE "AutopilotConfig"
  ADD COLUMN IF NOT EXISTS "consentVersion"       TEXT,
  ADD COLUMN IF NOT EXISTS "consentAcceptedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "maxDailyLossPct"       DOUBLE PRECISION NOT NULL DEFAULT 5.0,
  ADD COLUMN IF NOT EXISTS "dailyLossLockedUntil"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "maxSpreadBps"          INTEGER NOT NULL DEFAULT 15;

CREATE TABLE IF NOT EXISTS "AutopilotConsent" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "version"    TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AutopilotConsent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AutopilotConsent_userId_createdAt_idx"
  ON "AutopilotConsent"("userId", "createdAt");
