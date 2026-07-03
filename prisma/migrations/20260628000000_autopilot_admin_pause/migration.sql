-- Task 14, Phase 3 — admin pause for a single client's autopilot, distinct
-- from the client's own `enabled` toggle so the client's next config save
-- can never silently un-pause an admin-imposed pause.
ALTER TABLE "AutopilotConfig"
  ADD COLUMN IF NOT EXISTS "pausedByAdmin" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "pausedReason"  TEXT,
  ADD COLUMN IF NOT EXISTS "pausedAt"      TIMESTAMP(3);
