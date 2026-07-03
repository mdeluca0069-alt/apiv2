-- Task 13: Monthly Ledger Partitioning
--
-- Creates append-only archive tables for LedgerEntry and TradeAudit.
-- Hot rows stay in the Prisma-managed tables for the current month.
-- Rows older than 90 days can be moved to the partitioned archive via
-- the archive_ledger_entries() and archive_trade_audits() functions.
--
-- Why separate archive tables instead of partitioning the live tables?
--   Prisma does not manage partitioned tables. Altering "LedgerEntry" to a
--   PARTITION-parent would break Prisma's FK validation and foreign key
--   constraints. Archive tables are plain partitioned tables outside Prisma's
--   schema — safe to use with raw SQL or $queryRaw.
--
-- Partition strategy: RANGE ON (createdAt), one partition per calendar month.
-- Pre-creates partitions for 2025-01 through 2027-12 (36 months). Future
-- partitions are created by the monthly_partition_maintenance() function,
-- which is called by the background job ledger-partition-maintenance.

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1: LedgerEntry Archive
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "LedgerEntryArchive" (
  id              TEXT        NOT NULL,
  "userId"        TEXT        NOT NULL,
  currency        TEXT        NOT NULL,
  amount          NUMERIC     NOT NULL,
  type            TEXT        NOT NULL,
  reference       TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'COMPLETED',
  note            TEXT        NOT NULL DEFAULT '',
  "runningBalance" NUMERIC,
  "debitAccount"  TEXT,
  "creditAccount" TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE ("createdAt");

-- Monthly partitions: 2025-01 through 2027-12
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2025_01" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2025_02" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2025_03" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2025_04" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2025_05" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2025-05-01') TO ('2025-06-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2025_06" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2025_07" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2025-07-01') TO ('2025-08-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2025_08" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2025_09" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2025_10" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2025_11" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2025_12" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');

CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2026_01" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2026_02" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2026_03" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2026_04" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2026_05" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2026_06" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2026_07" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2026_08" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2026_09" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2026_10" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2026_11" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2026_12" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2027_01" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2027_02" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2027_03" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2027_04" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2027_05" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2027_06" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2027_07" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2027_08" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2027_09" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2027_10" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2027_11" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE IF NOT EXISTS "LedgerEntryArchive_2027_12" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');

-- BRIN index for the parent (inherited by partitions automatically)
CREATE INDEX IF NOT EXISTS "LedgerEntryArchive_createdAt_brin_idx"
    ON "LedgerEntryArchive" USING BRIN ("createdAt");

CREATE INDEX IF NOT EXISTS "LedgerEntryArchive_userId_createdAt_idx"
    ON "LedgerEntryArchive" ("userId", "createdAt");

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2: TradeAudit Archive
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "TradeAuditArchive" (
  id              TEXT        NOT NULL,
  "userId"        TEXT        NOT NULL,
  "orderId"       TEXT,
  "positionId"    TEXT,
  symbol          TEXT        NOT NULL,
  side            TEXT        NOT NULL,
  quantity        NUMERIC     NOT NULL,
  "entryPrice"    NUMERIC,
  "exitPrice"     NUMERIC,
  "stopLoss"      NUMERIC,
  "takeProfit"    NUMERIC,
  "pnlRealized"   NUMERIC,
  "pnlUnrealized" NUMERIC,
  "pnlPercent"    NUMERIC,
  "marginUsed"    NUMERIC,
  leverage        INTEGER,
  fees            NUMERIC     NOT NULL DEFAULT 0,
  slippage        NUMERIC     NOT NULL DEFAULT 0,
  duration        INTEGER,
  "tradeStatus"   TEXT        NOT NULL,
  lifecycle       JSONB       NOT NULL DEFAULT '[]',
  "riskMetrics"   JSONB       NOT NULL DEFAULT '{}',
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "closedAt"      TIMESTAMPTZ,
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE ("createdAt");

-- Monthly partitions: 2025-01 through 2027-12
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2025_01" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2025_02" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2025_03" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2025_04" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2025_05" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2025-05-01') TO ('2025-06-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2025_06" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2025_07" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2025-07-01') TO ('2025-08-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2025_08" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2025_09" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2025_10" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2025_11" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2025_12" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');

CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2026_01" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2026_02" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2026_03" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2026_04" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2026_05" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2026_06" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2026_07" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2026_08" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2026_09" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2026_10" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2026_11" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2026_12" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2027_01" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2027_02" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2027_03" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2027_04" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2027_05" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2027_06" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2027_07" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2027_08" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2027_09" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2027_10" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2027_11" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE IF NOT EXISTS "TradeAuditArchive_2027_12" PARTITION OF "TradeAuditArchive" FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');

CREATE INDEX IF NOT EXISTS "TradeAuditArchive_createdAt_brin_idx"
    ON "TradeAuditArchive" USING BRIN ("createdAt");

CREATE INDEX IF NOT EXISTS "TradeAuditArchive_userId_createdAt_idx"
    ON "TradeAuditArchive" ("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "TradeAuditArchive_userId_closedAt_idx"
    ON "TradeAuditArchive" ("userId", "closedAt")
    WHERE "closedAt" IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3: Archive stored procedures
-- ═══════════════════════════════════════════════════════════════════════════

-- archive_ledger_entries: moves LedgerEntry rows older than cutoff_date
-- to LedgerEntryArchive and deletes them from the live table.
-- Returns the number of rows moved.
CREATE OR REPLACE FUNCTION archive_ledger_entries(cutoff_date TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  moved_count INTEGER;
BEGIN
  WITH archived AS (
    DELETE FROM "LedgerEntry"
    WHERE "createdAt" < cutoff_date
    RETURNING
      id, "userId", currency, amount, type, reference, status, note,
      "runningBalance", "debitAccount", "creditAccount", "createdAt"
  )
  INSERT INTO "LedgerEntryArchive" (
    id, "userId", currency, amount, type, reference, status, note,
    "runningBalance", "debitAccount", "creditAccount", "createdAt"
  )
  SELECT
    id, "userId", currency, amount, type, reference, status, note,
    "runningBalance", "debitAccount", "creditAccount", "createdAt"
  FROM archived;

  GET DIAGNOSTICS moved_count = ROW_COUNT;
  RETURN moved_count;
END;
$$;

-- archive_trade_audits: moves TradeAudit rows older than cutoff_date
-- (where closedAt IS NOT NULL — only move closed trades) to TradeAuditArchive.
CREATE OR REPLACE FUNCTION archive_trade_audits(cutoff_date TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  moved_count INTEGER;
BEGIN
  WITH archived AS (
    DELETE FROM "TradeAudit"
    WHERE "createdAt" < cutoff_date
      AND "closedAt" IS NOT NULL
    RETURNING
      id, "userId", "orderId", "positionId", symbol, side, quantity,
      "entryPrice", "exitPrice", "stopLoss", "takeProfit",
      "pnlRealized", "pnlUnrealized", "pnlPercent",
      "marginUsed", leverage, fees, slippage, duration,
      "tradeStatus", lifecycle, "riskMetrics",
      "createdAt", "closedAt", "updatedAt"
  )
  INSERT INTO "TradeAuditArchive" (
    id, "userId", "orderId", "positionId", symbol, side, quantity,
    "entryPrice", "exitPrice", "stopLoss", "takeProfit",
    "pnlRealized", "pnlUnrealized", "pnlPercent",
    "marginUsed", leverage, fees, slippage, duration,
    "tradeStatus", lifecycle, "riskMetrics",
    "createdAt", "closedAt", "updatedAt"
  )
  SELECT
    id, "userId", "orderId", "positionId", symbol, side, quantity,
    "entryPrice", "exitPrice", "stopLoss", "takeProfit",
    "pnlRealized", "pnlUnrealized", "pnlPercent",
    "marginUsed", leverage, fees, slippage, duration,
    "tradeStatus", lifecycle, "riskMetrics",
    "createdAt", "closedAt", "updatedAt"
  FROM archived;

  GET DIAGNOSTICS moved_count = ROW_COUNT;
  RETURN moved_count;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4: Auto-partition maintenance function
-- ═══════════════════════════════════════════════════════════════════════════

-- monthly_partition_maintenance: creates the next 3 months of partitions
-- for both archive tables if they don't already exist.
-- Called by the ledger-partition-maintenance background job (monthly).
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

    -- LedgerEntryArchive
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables
      WHERE tablename = 'LedgerEntryArchive_' || suffix
    ) THEN
      EXECUTE FORMAT(
        'CREATE TABLE "LedgerEntryArchive_%s" PARTITION OF "LedgerEntryArchive" FOR VALUES FROM (%L) TO (%L)',
        suffix, month_start::TEXT, month_end::TEXT
      );
      created := created + 1;
    END IF;

    -- TradeAuditArchive
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables
      WHERE tablename = 'TradeAuditArchive_' || suffix
    ) THEN
      EXECUTE FORMAT(
        'CREATE TABLE "TradeAuditArchive_%s" PARTITION OF "TradeAuditArchive" FOR VALUES FROM (%L) TO (%L)',
        suffix, month_start::TEXT, month_end::TEXT
      );
      created := created + 1;
    END IF;
  END LOOP;

  RETURN FORMAT('Created %s new partitions', created);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5: Partition inventory view
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW "partition_inventory" AS
SELECT
  parent.relname                  AS parent_table,
  child.relname                   AS partition_name,
  pg_get_expr(child.relpartbound, child.oid) AS partition_bound,
  pg_size_pretty(pg_total_relation_size(child.oid)) AS total_size,
  pg_total_relation_size(child.oid)                 AS total_bytes
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
WHERE parent.relname IN ('LedgerEntryArchive', 'TradeAuditArchive', 'EventSourceArchive')
ORDER BY parent.relname, child.relname;
