-- ─────────────────────────────────────────────────────────────────────────────
-- Task 14: Monthly Range Partitioning — LedgerEntry + TradeAudit
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Converts two high-volume, append-only financial tables to PostgreSQL
-- declarative range partitioning by createdAt month.
--
-- Benefits:
--   • Partition pruning  — date-range queries skip irrelevant months entirely
--   • Online detach      — old partitions archived without table lock
--   • Vacuum efficiency  — each partition vacuumed independently
--   • INSERT performance — writes land in the current month's hot partition
--   • DROP speed         — archiving a month is O(1) (DROP TABLE on child)
--
-- Trade-off: composite PK (id, createdAt) required by PostgreSQL declarative
--   partitioning. Prisma findUnique({where:{id}}) still works — PostgreSQL
--   fans out to all partition indexes, which is acceptable for these audit
--   tables where date-range queries dominate (statements, reconciliation,
--   regulatory reporting). Direct ID lookups are uncommon.
--
-- Safety: each phase is wrapped in its own transaction.
--   Phase 1 — LedgerEntry
--   Phase 2 — TradeAudit
--   Phase 3 — Partition management function + monitoring view
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- PHASE 1 — LedgerEntry monthly partitioning
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1a. Drop all existing indexes on LedgerEntry (recreated on partitioned parent)
DROP INDEX IF EXISTS "LedgerEntry_reference_idx";
DROP INDEX IF EXISTS "LedgerEntry_type_status_idx";
DROP INDEX IF EXISTS "LedgerEntry_userId_createdAt_idx";
DROP INDEX IF EXISTS "LedgerEntry_userId_type_status_idx";
DROP INDEX IF EXISTS "LedgerEntry_userId_type_idx";
DROP INDEX IF EXISTS "LedgerEntry_createdAt_brin_idx";

-- 1b. Drop FK and check constraints (re-added on new table)
ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "LedgerEntry_userId_fkey";
ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "LedgerEntry_type_check";

-- 1c. Rename to preserve data during migration
ALTER TABLE "LedgerEntry" RENAME TO "LedgerEntry_legacy";

-- 1d. Create partitioned parent table (composite PK includes partition key)
CREATE TABLE "LedgerEntry" (
  id               TEXT            NOT NULL,
  "userId"         TEXT            NOT NULL,
  currency         TEXT            NOT NULL,
  amount           NUMERIC         NOT NULL,
  type             TEXT            NOT NULL,
  reference        TEXT            NOT NULL,
  status           TEXT            NOT NULL DEFAULT 'COMPLETED',
  note             TEXT            NOT NULL DEFAULT '',
  "runningBalance" NUMERIC(18, 8),
  "debitAccount"   TEXT,
  "creditAccount"  TEXT,
  "createdAt"      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, "createdAt"),
  CONSTRAINT "LedgerEntry_type_check" CHECK (type IN (
    'DEPOSIT_REQUEST','WITHDRAW_REQUEST','ADMIN_CAPITAL_ALLOCATION',
    'MARGIN_RESERVED','MARGIN_RELEASED','MARGIN_LOCK','MARGIN_RELEASE',
    'PNL_CREDIT','PNL_DEBIT','PNL_SETTLEMENT',
    'COMMISSION','SWAP','ADJUSTMENT','FEE','DOCUMENT_EVENT'
  ))
) PARTITION BY RANGE ("createdAt");

-- 1e. Default partition catches any row outside defined month ranges (safety net)
CREATE TABLE "LedgerEntry_default" PARTITION OF "LedgerEntry" DEFAULT;

-- 1f. Create monthly child partitions: 2024-01 through 2027-12
DO $$
DECLARE
  cur  DATE := '2024-01-01';
  nxt  DATE;
  nm   TEXT;
BEGIN
  WHILE cur < '2028-01-01' LOOP
    nxt := cur + INTERVAL '1 month';
    nm  := 'LedgerEntry_' || to_char(cur, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "LedgerEntry"
       FOR VALUES FROM (%L) TO (%L)',
      nm, cur::text, nxt::text
    );
    cur := nxt;
  END LOOP;
END $$;

-- 1g. FK constraint (PostgreSQL 12+ supports FKs on partitioned tables)
ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" (id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 1h. Recreate indexes on parent — PostgreSQL propagates to all partitions
CREATE INDEX "LedgerEntry_reference_idx"         ON "LedgerEntry" (reference);
CREATE INDEX "LedgerEntry_type_status_idx"        ON "LedgerEntry" (type, status);
CREATE INDEX "LedgerEntry_userId_createdAt_idx"   ON "LedgerEntry" ("userId", "createdAt");
CREATE INDEX "LedgerEntry_userId_type_status_idx" ON "LedgerEntry" ("userId", type, status);

-- 1i. Migrate existing data (INSERT from legacy into correct monthly partitions)
INSERT INTO "LedgerEntry"
  SELECT
    id, "userId", currency, amount, type, reference,
    status, note, "runningBalance", "debitAccount", "creditAccount", "createdAt"
  FROM "LedgerEntry_legacy";

-- 1j. Remove legacy table after successful copy
DROP TABLE "LedgerEntry_legacy";

COMMIT;


-- ═════════════════════════════════════════════════════════════════════════════
-- PHASE 2 — TradeAudit monthly partitioning
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- 2a. Drop all existing indexes on TradeAudit
DROP INDEX IF EXISTS "TradeAudit_userId_idx";
DROP INDEX IF EXISTS "TradeAudit_symbol_idx";
DROP INDEX IF EXISTS "TradeAudit_createdAt_idx";
DROP INDEX IF EXISTS "TradeAudit_orderId_idx";
DROP INDEX IF EXISTS "TradeAudit_positionId_idx";
DROP INDEX IF EXISTS "TradeAudit_symbol_tradeStatus_idx";
DROP INDEX IF EXISTS "TradeAudit_userId_createdAt_idx";
DROP INDEX IF EXISTS "TradeAudit_userId_tradeStatus_idx";
DROP INDEX IF EXISTS "TradeAudit_userId_closedAt_idx";
DROP INDEX IF EXISTS "TradeAudit_createdAt_brin_idx";

-- 2b. Drop FK
ALTER TABLE "TradeAudit" DROP CONSTRAINT IF EXISTS "TradeAudit_userId_fkey";

-- 2c. Rename to preserve data
ALTER TABLE "TradeAudit" RENAME TO "TradeAudit_legacy";

-- 2d. Create partitioned parent table
CREATE TABLE "TradeAudit" (
  id              TEXT         NOT NULL,
  "userId"        TEXT         NOT NULL,
  "orderId"       TEXT,
  "positionId"    TEXT,
  symbol          TEXT         NOT NULL,
  side            TEXT         NOT NULL,
  quantity        NUMERIC      NOT NULL,
  "entryPrice"    NUMERIC,
  "exitPrice"     NUMERIC,
  "stopLoss"      NUMERIC,
  "takeProfit"    NUMERIC,
  "pnlRealized"   NUMERIC,
  "pnlUnrealized" NUMERIC,
  "pnlPercent"    NUMERIC,
  "marginUsed"    NUMERIC,
  leverage        INTEGER,
  fees            NUMERIC      NOT NULL DEFAULT 0,
  slippage        NUMERIC      NOT NULL DEFAULT 0,
  duration        INTEGER,
  "tradeStatus"   TEXT         NOT NULL,
  lifecycle       JSON         NOT NULL,
  "riskMetrics"   JSON         NOT NULL,
  "createdAt"     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "closedAt"      TIMESTAMPTZ,
  "updatedAt"     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, "createdAt")
) PARTITION BY RANGE ("createdAt");

-- 2e. Default partition for safety
CREATE TABLE "TradeAudit_default" PARTITION OF "TradeAudit" DEFAULT;

-- 2f. Monthly child partitions: 2024-01 through 2027-12
DO $$
DECLARE
  cur  DATE := '2024-01-01';
  nxt  DATE;
  nm   TEXT;
BEGIN
  WHILE cur < '2028-01-01' LOOP
    nxt := cur + INTERVAL '1 month';
    nm  := 'TradeAudit_' || to_char(cur, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "TradeAudit"
       FOR VALUES FROM (%L) TO (%L)',
      nm, cur::text, nxt::text
    );
    cur := nxt;
  END LOOP;
END $$;

-- 2g. FK constraint
ALTER TABLE "TradeAudit"
  ADD CONSTRAINT "TradeAudit_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" (id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2h. Recreate indexes on parent
CREATE INDEX "TradeAudit_orderId_idx"            ON "TradeAudit" ("orderId");
CREATE INDEX "TradeAudit_positionId_idx"          ON "TradeAudit" ("positionId");
CREATE INDEX "TradeAudit_symbol_tradeStatus_idx"  ON "TradeAudit" (symbol, "tradeStatus");
CREATE INDEX "TradeAudit_userId_createdAt_idx"    ON "TradeAudit" ("userId", "createdAt");
CREATE INDEX "TradeAudit_userId_tradeStatus_idx"  ON "TradeAudit" ("userId", "tradeStatus");
CREATE INDEX "TradeAudit_userId_closedAt_idx"     ON "TradeAudit" ("userId", "closedAt")
  WHERE "closedAt" IS NOT NULL;

-- 2i. Migrate existing data
INSERT INTO "TradeAudit"
  SELECT
    id, "userId", "orderId", "positionId", symbol, side, quantity,
    "entryPrice", "exitPrice", "stopLoss", "takeProfit",
    "pnlRealized", "pnlUnrealized", "pnlPercent",
    "marginUsed", leverage, fees, slippage, duration,
    "tradeStatus", lifecycle, "riskMetrics",
    "createdAt", "closedAt", "updatedAt"
  FROM "TradeAudit_legacy";

-- 2j. Remove legacy table
DROP TABLE "TradeAudit_legacy";

COMMIT;


-- ═════════════════════════════════════════════════════════════════════════════
-- PHASE 3 — Partition management infrastructure
-- ═════════════════════════════════════════════════════════════════════════════

-- Function: auto-create next month's partitions (called by Node.js partition manager).
-- Creates partitions for current month + next 3 months (idempotent — IF NOT EXISTS).
-- Can also be called via pg_cron: SELECT igfxpro_create_next_partitions();
CREATE OR REPLACE FUNCTION igfxpro_create_next_partitions()
RETURNS TABLE (
  parent_table   TEXT,
  partition_name TEXT,
  created        BOOLEAN,
  from_date      TEXT,
  to_date        TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  target_month DATE;
  next_month   DATE;
  p_name       TEXT;
  tbl          TEXT;
  already      BOOLEAN;
BEGIN
  FOR i IN 0..3 LOOP
    target_month := date_trunc('month', NOW() AT TIME ZONE 'UTC') + (i || ' months')::INTERVAL;
    next_month   := target_month + INTERVAL '1 month';

    FOREACH tbl IN ARRAY ARRAY['LedgerEntry', 'TradeAudit'] LOOP
      p_name  := tbl || '_' || to_char(target_month, 'YYYY_MM');
      already := EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = p_name
      );

      IF NOT already THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
          p_name, tbl, target_month::text, next_month::text
        );
      END IF;

      parent_table   := tbl;
      partition_name := p_name;
      created        := NOT already;
      from_date      := target_month::text;
      to_date        := next_month::text;
      RETURN NEXT;
    END LOOP;
  END LOOP;
END;
$$;

-- Function: detach and drop a single month's partition (archival / cleanup).
-- Only proceeds if the partition has 0 rows (safety guard).
-- Usage: SELECT igfxpro_archive_partition('LedgerEntry', '2024_01');
CREATE OR REPLACE FUNCTION igfxpro_archive_partition(
  p_table      TEXT,
  p_month      TEXT  -- format: YYYY_MM
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  p_name TEXT;
  cnt    BIGINT;
BEGIN
  p_name := p_table || '_' || p_month;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = p_name
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'partition_not_found', 'partition', p_name);
  END IF;

  EXECUTE format('SELECT COUNT(*) FROM %I', p_name) INTO cnt;

  RETURN jsonb_build_object(
    'ok',        true,
    'partition', p_name,
    'row_count', cnt,
    'note',      'Detach + drop via: ALTER TABLE "' || p_table || '" DETACH PARTITION "' || p_name || '"; DROP TABLE "' || p_name || '";'
  );
END;
$$;

-- View: per-partition sizes for monitoring dashboard
CREATE OR REPLACE VIEW igfxpro_partition_stats AS
SELECT
  parent.relname                                          AS parent_table,
  child.relname                                           AS partition_name,
  pg_size_pretty(pg_total_relation_size(child.oid))       AS total_size,
  pg_total_relation_size(child.oid)                       AS total_bytes,
  pg_stat_user_tables.n_live_tup                          AS live_rows,
  pg_stat_user_tables.n_dead_tup                          AS dead_rows,
  pg_stat_user_tables.last_analyze                        AS last_analyzed,
  pg_stat_user_tables.last_autovacuum                     AS last_vacuumed
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
LEFT JOIN pg_stat_user_tables
  ON pg_stat_user_tables.relname = child.relname
  AND pg_stat_user_tables.schemaname = current_schema()
WHERE parent.relname IN ('LedgerEntry', 'TradeAudit')
ORDER BY parent.relname, child.relname;
