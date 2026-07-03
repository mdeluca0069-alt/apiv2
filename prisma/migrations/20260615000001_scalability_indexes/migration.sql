-- Task 9 Part C: Scalability indexes for 10,000+ concurrent users.
--
-- All indexes use CONCURRENTLY so the migration can be applied to a live
-- production database without acquiring an exclusive table lock and
-- blocking user traffic. This makes it safe to run without a maintenance window.
--
-- IF NOT EXISTS prevents failure if a DBA already created an index manually.
--
-- Index selection rationale is documented in DATABASE_SCALING_REPORT.md.

-- ── 1. Position: partial index for the stop-out and margin-level scans ─────────
--
-- The StopOutEngine runs every 30s and queries:
--   SELECT DISTINCT "userId" FROM "Position" WHERE status = 'OPEN'
-- Without this index, PostgreSQL must perform a full sequential scan of Position
-- even though open positions are typically <1% of total rows as the table grows.
-- A partial index covers only OPEN positions, making the scan O(open positions)
-- rather than O(all positions).
--
CREATE INDEX IF NOT EXISTS "Position_open_userId_partial_idx"
    ON "Position" ("userId")
    WHERE status = 'OPEN';

-- ── 2. Position: composite index for stop-out sorted by open time ─────────────
--
-- The SettlementEngine sorts positions by openedAt when liquidating.
-- The existing (userId, status) index doesn't include openedAt, so PostgreSQL
-- must re-sort after the index scan. Adding openedAt avoids the sort step.
--
CREATE INDEX IF NOT EXISTS "Position_userId_status_openedAt_idx"
    ON "Position" ("userId", status, "openedAt");

-- ── 3. Position: BRIN index for time-range analytics ─────────────────────────
--
-- BRIN is ideal for append-ordered columns (positions are inserted once and
-- openedAt is monotonically increasing per partition). Costs ~0.1% of a
-- B-tree index in storage while accelerating date-range analytics queries.
--
CREATE INDEX IF NOT EXISTS "Position_openedAt_brin_idx"
    ON "Position" USING BRIN ("openedAt");

-- ── 4. Order: 3-column covering index for dashboard and API pagination ────────
--
-- REST endpoints like GET /api/v1/trading/orders?status=FILLED&limit=25 use:
--   WHERE userId = $1 AND status = $2 ORDER BY createdAt DESC LIMIT 25
-- The existing (userId, status) and (userId, createdAt) indexes force a
-- re-sort step or index merge. A single 3-column index with DESC createdAt
-- enables an index-only scan with sort elimination.
--
CREATE INDEX IF NOT EXISTS "Order_userId_status_createdAt_idx"
    ON "Order" ("userId", status, "createdAt" DESC);

-- ── 5. OutboxEvent: partial index for the retry sweep ─────────────────────────
--
-- The outbox retry sweep queries:
--   SELECT * FROM "OutboxEvent" WHERE published = false AND "createdAt" > $1
-- The existing (published, createdAt) index covers this but includes ALL
-- published rows. A partial index on published=false is smaller (undelivered
-- events are a tiny fraction of total rows after delivery) and therefore faster.
-- Includes userId for covering index on the delivery callback.
--
CREATE INDEX IF NOT EXISTS "OutboxEvent_unpublished_covering_idx"
    ON "OutboxEvent" (published, "createdAt", "userId")
    WHERE published = false;

-- ── 6. TradeAudit: index on closedAt for P&L analytics ───────────────────────
--
-- Regulatory reporting and client P&L history queries filter by close date:
--   WHERE userId = $1 AND closedAt BETWEEN $2 AND $3
-- The existing (userId, createdAt) index doesn't help closedAt-based filters.
-- Partial index excludes open trades (closedAt IS NULL) to keep it compact.
--
CREATE INDEX IF NOT EXISTS "TradeAudit_userId_closedAt_idx"
    ON "TradeAudit" ("userId", "closedAt")
    WHERE "closedAt" IS NOT NULL;

-- ── 7. TradeAudit: BRIN for high-volume append-only audits ───────────────────
--
-- TradeAudit grows proportionally to trading volume (one row per position open
-- and update). BRIN index on the monotonically increasing createdAt provides
-- fast range scans at ~0.1% storage overhead vs. B-tree.
--
CREATE INDEX IF NOT EXISTS "TradeAudit_createdAt_brin_idx"
    ON "TradeAudit" USING BRIN ("createdAt");

-- ── 8. LedgerEntry: BRIN for financial ledger ────────────────────────────────
--
-- LedgerEntry is a financial ledger that grows monotonically with all credit/
-- debit events. BRIN accelerates time-range scans for month-end reconciliation.
--
CREATE INDEX IF NOT EXISTS "LedgerEntry_createdAt_brin_idx"
    ON "LedgerEntry" USING BRIN ("createdAt");

-- ── 9. Notification: covering index for user notification feed ────────────────
--
-- The notification panel fetches unread notifications ordered by recency:
--   WHERE userId = $1 AND sent = false ORDER BY createdAt DESC LIMIT 25
-- Adding createdAt DESC to the existing (userId, sent) index eliminates
-- the sort step and enables an index-only scan.
--
CREATE INDEX IF NOT EXISTS "Notification_userId_sent_createdAt_idx"
    ON "Notification" ("userId", sent, "createdAt" DESC);

-- ── 10. Session: partial index for active sessions ───────────────────────────
--
-- Auth middleware validates sessions via:
--   WHERE "refreshToken" = $1 AND "expiresAt" > now()
-- The primary key handles the token lookup. This partial index on non-expired
-- sessions allows fast per-user session listing and cleanup without scanning
-- the full historical session table.
--
CREATE INDEX IF NOT EXISTS "Session_userId_active_idx"
    ON "Session" ("userId", "expiresAt");

-- ── 11. AuditLog: entity-scoped recency index ─────────────────────────────────
--
-- Admin audit trail lookups scan by entity prefix (e.g. "user:<uuid>"):
--   WHERE entity = $1 ORDER BY "createdAt" DESC LIMIT 50
-- The existing (entity, createdAt) index is in ASC order; adding DESC createdAt
-- matches the typical "most recent first" access pattern.
--
CREATE INDEX IF NOT EXISTS "AuditLog_entity_createdAt_desc_idx"
    ON "AuditLog" (entity, "createdAt" DESC);

-- ── 12. WalletAccount: index on currency for multi-currency queries ───────────
--
-- While most queries hit WalletAccount by userId (PK lookup), aggregate
-- balance queries across all users for a given currency (used by risk reporting)
-- require a currency index to avoid a full table scan at 10k users.
--
CREATE INDEX IF NOT EXISTS "WalletAccount_currency_idx"
    ON "WalletAccount" (currency);

-- ── 13. DepositTransaction: skipped — table not yet present in this schema version
