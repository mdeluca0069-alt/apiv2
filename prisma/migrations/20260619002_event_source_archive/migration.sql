-- Task 13: Event Sourcing Archive
--
-- Immutable append-only log of all domain events emitted on the internal
-- event bus. Provides a complete audit trail for regulatory review, replay
-- capability for disaster recovery, and temporal querying across event types.
--
-- Design decisions:
--   – PARTITION BY RANGE (publishedAt): one partition per month. Large platforms
--     can generate 100M+ events/year; partitioning keeps each partition < 500 MB
--     and enables instant partition drop for GDPR right-to-erasure on old events.
--   – JSONB payload: flexible schema that accommodates every domain event type
--     without schema migrations when new event types are added.
--   – streamId: logical grouping key (e.g. "user:<uuid>", "symbol:EURUSD").
--     Allows efficient per-entity event replay without scanning by userId.
--   – No UPDATE, no DELETE on live partitions: enforced by application logic.
--     Corrections are modelled as new CORRECTION events with the original id
--     in correlationId.

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1: EventSourceArchive partitioned table
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "EventSourceArchive" (
  id              TEXT        NOT NULL,
  "eventType"     TEXT        NOT NULL,
  "streamId"      TEXT,                          -- e.g. "user:<userId>", "symbol:EURUSD"
  "correlationId" TEXT,                          -- links correction events to originals
  payload         JSONB       NOT NULL,
  "publishedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE ("publishedAt");

-- Monthly partitions: 2026-06 through 2027-12
-- (Archive begins at platform launch. Prior months not needed.)
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2026_06" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2026_07" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2026_08" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2026_09" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2026_10" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2026_11" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2026_12" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

CREATE TABLE IF NOT EXISTS "EventSourceArchive_2027_01" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2027_02" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2027_03" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2027_04" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2027_05" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2027_06" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2027_07" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2027_08" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2027_09" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2027_10" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2027_11" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE IF NOT EXISTS "EventSourceArchive_2027_12" PARTITION OF "EventSourceArchive" FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2: Indexes
-- ═══════════════════════════════════════════════════════════════════════════

-- BRIN on publishedAt — primary range-scan index.
-- Partitioning already limits scans to one month per query; BRIN handles
-- intra-partition range filtering with minimal storage.
CREATE INDEX IF NOT EXISTS "EventSourceArchive_publishedAt_brin_idx"
    ON "EventSourceArchive" USING BRIN ("publishedAt");

-- B-tree on eventType for filtering by event class
CREATE INDEX IF NOT EXISTS "EventSourceArchive_eventType_publishedAt_idx"
    ON "EventSourceArchive" ("eventType", "publishedAt" DESC);

-- B-tree on streamId for per-entity replay queries
CREATE INDEX IF NOT EXISTS "EventSourceArchive_streamId_publishedAt_idx"
    ON "EventSourceArchive" ("streamId", "publishedAt" DESC)
    WHERE "streamId" IS NOT NULL;

-- B-tree on correlationId for linking correction events to originals
CREATE INDEX IF NOT EXISTS "EventSourceArchive_correlationId_idx"
    ON "EventSourceArchive" ("correlationId")
    WHERE "correlationId" IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3: Auto-partition maintenance (extends monthly_partition_maintenance)
-- ═══════════════════════════════════════════════════════════════════════════

-- Replace the function from 20260619001 to also cover EventSourceArchive.
CREATE OR REPLACE FUNCTION monthly_partition_maintenance()
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  month_start DATE;
  month_end   DATE;
  suffix      TEXT;
  created     INTEGER := 0;
BEGIN
  FOR i IN 0..2 LOOP
    month_start := DATE_TRUNC('month', NOW() + (i || ' months')::INTERVAL)::DATE;
    month_end   := (month_start + '1 month'::INTERVAL)::DATE;
    suffix      := TO_CHAR(month_start, 'YYYY_MM');

    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'LedgerEntryArchive_' || suffix) THEN
      EXECUTE FORMAT('CREATE TABLE "LedgerEntryArchive_%s" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM (%L) TO (%L)', suffix, month_start::TEXT, month_end::TEXT);
      created := created + 1;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'TradeAuditArchive_' || suffix) THEN
      EXECUTE FORMAT('CREATE TABLE "TradeAuditArchive_%s" PARTITION OF "TradeAuditArchive" FOR VALUES FROM (%L) TO (%L)', suffix, month_start::TEXT, month_end::TEXT);
      created := created + 1;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'EventSourceArchive_' || suffix) THEN
      EXECUTE FORMAT('CREATE TABLE "EventSourceArchive_%s" PARTITION OF "EventSourceArchive" FOR VALUES FROM (%L) TO (%L)', suffix, month_start::TEXT, month_end::TEXT);
      created := created + 1;
    END IF;
  END LOOP;

  RETURN FORMAT('Created %s new partitions', created);
END;
$$;
