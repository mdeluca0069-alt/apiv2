-- Financial Invariant Audit — 8 checks, expected ZERO violations each
-- Run: psql -h localhost -p 5435 -U igfxpro -d igfxpro -f invariants.sql

\echo '============================================================'
\echo 'FINANCIAL INVARIANT AUDIT — POST-CLEANUP CERTIFICATION'
\echo '============================================================'
\echo ''

-- CHECK 1: wallet.locked == SUM(marginUsed for OPEN positions)
\echo 'CHECK 1: Locked margin vs open-position marginUsed'
SELECT
  w."userId",
  w.locked                             AS wallet_locked,
  COALESCE(SUM(p."marginUsed"), 0)     AS sum_margin_used,
  w.locked - COALESCE(SUM(p."marginUsed"), 0) AS discrepancy
FROM "WalletAccount" w
LEFT JOIN "Position" p ON p."userId" = w."userId" AND p.status = 'OPEN'
GROUP BY w."userId", w.locked
HAVING ABS(w.locked - COALESCE(SUM(p."marginUsed"), 0)) > 0.01
ORDER BY ABS(w.locked - COALESCE(SUM(p."marginUsed"), 0)) DESC
LIMIT 20;

SELECT COUNT(*) AS check1_violations FROM (
  SELECT w."userId"
  FROM "WalletAccount" w
  LEFT JOIN "Position" p ON p."userId" = w."userId" AND p.status = 'OPEN'
  GROUP BY w."userId", w.locked
  HAVING ABS(w.locked - COALESCE(SUM(p."marginUsed"), 0)) > 0.01
) sub;

\echo ''

-- CHECK 2: Duplicate clientOrderId per user
\echo 'CHECK 2: Duplicate clientOrderId per user'
SELECT "userId", "clientOrderId", COUNT(*) AS duplicates
FROM "Order"
WHERE "clientOrderId" IS NOT NULL
GROUP BY "userId", "clientOrderId"
HAVING COUNT(*) > 1
ORDER BY duplicates DESC
LIMIT 20;

SELECT COUNT(*) AS check2_violations FROM (
  SELECT "userId", "clientOrderId"
  FROM "Order"
  WHERE "clientOrderId" IS NOT NULL
  GROUP BY "userId", "clientOrderId"
  HAVING COUNT(*) > 1
) sub;

\echo ''

-- CHECK 3: Duplicate settlements — same positionId closed more than once via PNL_SETTLEMENT
\echo 'CHECK 3: Duplicate PNL_SETTLEMENT per position'
SELECT reference AS "positionId", COUNT(*) AS settlement_count
FROM "LedgerEntry"
WHERE type = 'PNL_SETTLEMENT'
GROUP BY reference
HAVING COUNT(*) > 1
ORDER BY settlement_count DESC
LIMIT 20;

SELECT COUNT(*) AS check3_violations FROM (
  SELECT reference
  FROM "LedgerEntry"
  WHERE type = 'PNL_SETTLEMENT'
  GROUP BY reference
  HAVING COUNT(*) > 1
) sub;

\echo ''

-- CHECK 4: Duplicate swap accruals — same positionId + same logical accrual day.
-- `reference` is built as SWAP:{positionId}:{accrualDate} (swap.accrual.service.ts:165)
-- and already uniquely encodes position+day — grouping additionally by
-- DATE("createdAt") is wrong: a catch-up/backfill run can insert a row for an
-- earlier missed accrualDate on a later wall-clock day, which is correct
-- behavior (one row per accrualDate) but was flagged as a false-positive
-- duplicate. `reference` alone is the right (and sufficient) grouping key,
-- same pattern as CHECK 3 above for PNL_SETTLEMENT.
\echo 'CHECK 4: Duplicate swap accruals (same positionId + accrualDate)'
SELECT reference AS "positionId_and_accrualDate", COUNT(*) AS swap_count
FROM "LedgerEntry"
WHERE type = 'SWAP'
GROUP BY reference
HAVING COUNT(*) > 1
ORDER BY swap_count DESC
LIMIT 20;

SELECT COUNT(*) AS check4_violations FROM (
  SELECT reference
  FROM "LedgerEntry"
  WHERE type = 'SWAP'
  GROUP BY reference
  HAVING COUNT(*) > 1
) sub;

\echo ''

-- CHECK 5: Orphan positions — no parent Order row
\echo 'CHECK 5: Orphan positions (no parent Order)'
SELECT p.id, p."userId", p.status, p."openedAt"
FROM "Position" p
WHERE NOT EXISTS (SELECT 1 FROM "Order" o WHERE o.id = p."orderId")
LIMIT 20;

SELECT COUNT(*) AS check5_violations
FROM "Position" p
WHERE NOT EXISTS (SELECT 1 FROM "Order" o WHERE o.id = p."orderId");

\echo ''

-- CHECK 6: Orphan LedgerEntry rows — userId not in User table
\echo 'CHECK 6: Orphan LedgerEntry rows (userId not in User)'
SELECT le."userId", COUNT(*) AS orphan_entries
FROM "LedgerEntry" le
WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = le."userId")
GROUP BY le."userId"
LIMIT 20;

SELECT COUNT(*) AS check6_violations
FROM "LedgerEntry" le
WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = le."userId");

\echo ''

-- CHECK 7: Negative wallet balances
\echo 'CHECK 7: Negative wallet balances'
SELECT "userId", balance, equity, locked
FROM "WalletAccount"
WHERE balance < 0 OR equity < 0
ORDER BY balance ASC
LIMIT 20;

SELECT COUNT(*) AS check7_violations
FROM "WalletAccount"
WHERE balance < 0 OR equity < 0;

\echo ''

-- CHECK 8: Negative locked margin
\echo 'CHECK 8: Negative locked margin'
SELECT "userId", locked
FROM "WalletAccount"
WHERE locked < 0
ORDER BY locked ASC
LIMIT 20;

SELECT COUNT(*) AS check8_violations
FROM "WalletAccount"
WHERE locked < 0;

\echo ''
\echo '============================================================'
\echo 'AUDIT COMPLETE — review violation counts above'
\echo '============================================================'
