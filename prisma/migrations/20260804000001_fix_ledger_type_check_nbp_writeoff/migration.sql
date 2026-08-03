-- PHASE H (fresh production-certification due-diligence audit) --
-- LedgerEntry_type_check was missing "NBP_WRITEOFF".
--
-- settlement/settlement.engine.ts writes a LedgerEntry with
-- type="NBP_WRITEOFF" (a positive credit to the client) whenever ESMA
-- negative-balance protection caps a client's aggregate wallet balance at
-- zero after a settlement that would otherwise have pushed it negative
-- (see that file's own docstring: "residual is absorbed by the broker via
-- an audited NBP_WRITEOFF ledger entry"). This is not a rare or
-- theoretical path -- settlement.engine.ts treats it as a first-class,
-- always-on control that fires under real margin stress.
--
-- LedgerEntry_type_check (last (re)defined in
-- 20260709000001_allow_deposit_credit_ledger_type/migration.sql, which
-- fixed the exact same bug class for DEPOSIT_CREDIT but did not audit for
-- other missing values at the same time) never included NBP_WRITEOFF. On
-- a genuinely fresh database, the first NBP write-off a client's account
-- ever triggers would fail outright with "new row ... violates check
-- constraint LedgerEntry_type_check" -- which, since this write is the
-- broker's only mechanism for keeping the client's balance non-negative
-- after a capped settlement, would leave that client's wallet in a
-- negative-balance state ESMA compliance requires never happen.
--
-- ALTER TABLE on the partitioned parent's CHECK constraint automatically
-- propagates to all partitions on PostgreSQL 11+ (per
-- 20260709000001's own note).

ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "LedgerEntry_type_check";

ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_type_check" CHECK (type IN (
  'DEPOSIT_REQUEST', 'DEPOSIT_CREDIT', 'WITHDRAW_REQUEST', 'ADMIN_CAPITAL_ALLOCATION',
  'MARGIN_RESERVED', 'MARGIN_RELEASED', 'MARGIN_LOCK', 'MARGIN_RELEASE',
  'PNL_CREDIT', 'PNL_DEBIT', 'PNL_SETTLEMENT', 'COMMISSION', 'SWAP',
  'ADJUSTMENT', 'FEE', 'DOCUMENT_EVENT', 'NBP_WRITEOFF'
));
