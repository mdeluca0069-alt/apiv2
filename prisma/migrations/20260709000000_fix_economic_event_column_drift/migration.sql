-- Milestone 1 / Fix #10 — EconomicEvent schema/migration drift.
--
-- schema.prisma has always declared columns "title", "source", "forecast",
-- "previous" plus a compound unique constraint and an index on
-- (source, eventTime) — but the ONLY migration that ever created this table
-- (20260619000000_signal_telemetry_and_adaptive_intelligence) created columns
-- "event", "estimate", "prev", no "source" column at all, and neither the
-- unique constraint nor the source index. Live application code
-- (economic-calendar/economic.event.service.ts) has always been written
-- against the schema.prisma names — every prisma.economicEvent.create/
-- upsert/findMany call referencing "title"/"source"/"forecast"/"previous"
-- would fail with "column does not exist" against a database built purely
-- from the migration history (e.g. `prisma migrate deploy` on a fresh
-- environment), even though this specific long-lived dev database had
-- separately been patched to the correct shape outside the migration
-- history at some point (via a direct `db push`, never captured as a
-- migration). This migration makes that patch reproducible and idempotent,
-- so a fresh environment converges to the same (correct) shape schema.prisma
-- has always declared, and re-running it here is a safe no-op.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'EconomicEvent' AND column_name = 'event')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'EconomicEvent' AND column_name = 'title') THEN
    ALTER TABLE "EconomicEvent" RENAME COLUMN "event" TO "title";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'EconomicEvent' AND column_name = 'estimate')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'EconomicEvent' AND column_name = 'forecast') THEN
    ALTER TABLE "EconomicEvent" RENAME COLUMN "estimate" TO "forecast";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'EconomicEvent' AND column_name = 'prev')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'EconomicEvent' AND column_name = 'previous') THEN
    ALTER TABLE "EconomicEvent" RENAME COLUMN "prev" TO "previous";
  END IF;
END $$;

-- "source" never existed in the migration history at all — add it with the
-- same default schema.prisma declares (@default("UNKNOWN")).
ALTER TABLE "EconomicEvent" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'UNKNOWN';

-- Compound unique constraint the live upsert() path
-- (economic.event.service.ts) has always relied on via
-- currency_eventTime_title_source, but which the original migration never
-- created. Guarded against both a formal pg_constraint entry AND a
-- same-named unique index (Postgres backs a unique constraint with an
-- index of the same name, and on this long-lived dev DB the equivalent
-- index already exists — added directly rather than via ADD CONSTRAINT —
-- so ADD CONSTRAINT would otherwise collide with it).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EconomicEvent_currency_eventTime_title_source_key'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'EconomicEvent_currency_eventTime_title_source_key'
  ) THEN
    ALTER TABLE "EconomicEvent"
      ADD CONSTRAINT "EconomicEvent_currency_eventTime_title_source_key"
      UNIQUE ("currency", "eventTime", "title", "source");
  END IF;
END $$;

-- Index schema.prisma declares (@@index([source, eventTime])) but the
-- original migration never created.
CREATE INDEX IF NOT EXISTS "EconomicEvent_source_eventTime_idx" ON "EconomicEvent"("source", "eventTime");
