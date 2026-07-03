-- Reset load-test wallets and clear open positions between benchmark tiers
-- Preserves all real-user data (filters on loadtest email pattern)

BEGIN;

-- 1. Close any lingering open positions from load-test users
DELETE FROM "Position"
WHERE status = 'OPEN'
  AND "userId" IN (
    SELECT id FROM "User"
    WHERE email LIKE '%@igfxpro-loadtest.internal'
  );

-- 2. Reset wallet balances for all load-test users
UPDATE "WalletAccount"
SET balance = 10000, equity = 10000, locked = 0
WHERE "userId" IN (
  SELECT id FROM "User"
  WHERE email LIKE '%@igfxpro-loadtest.internal'
);

COMMIT;

-- Confirm
SELECT
  COUNT(*) FILTER (WHERE status = 'OPEN') AS open_positions_remaining,
  COUNT(*) FILTER (WHERE balance != 10000 OR locked != 0) AS wallets_not_reset
FROM "WalletAccount" w
JOIN "User" u ON u.id = w."userId"
LEFT JOIN "Position" p ON p."userId" = w."userId" AND p.status = 'OPEN'
WHERE u.email LIKE '%@igfxpro-loadtest.internal';
