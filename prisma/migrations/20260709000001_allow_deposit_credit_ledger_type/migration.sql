-- Milestone 1 / Fix #11 (DB) — LedgerEntry_type_check was missing "DEPOSIT_CREDIT".
--
-- payment-service/deposit.state.machine.ts's live PSP deposit-crediting
-- path (payment-service/deposit.state.machine.ts:114) has always written
-- LedgerEntry rows with type="DEPOSIT_CREDIT" — but the CHECK constraint
-- guarding this column (last redefined in
-- 20260619000001_monthly_partitioning_retention) never included that value.
-- Verified empirically against this live database: every real PSP deposit
-- credit attempt fails outright with
-- "new row ... violates check constraint LedgerEntry_type_check" — the
-- exact code path Milestone-1 Fix #7 taught the reconciliation engine to
-- recognize could never actually produce a row in the first place. This is
-- a more fundamental bug than #7 and needed fixing at the same time.
--
-- ALTER TABLE on the partitioned parent's CHECK constraint automatically
-- propagates to all existing (and future) partitions on PostgreSQL 11+, so
-- this single statement pair fixes all 49 existing monthly partitions.

ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "LedgerEntry_type_check";

ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_type_check" CHECK (type IN (
  'DEPOSIT_REQUEST', 'DEPOSIT_CREDIT', 'WITHDRAW_REQUEST', 'ADMIN_CAPITAL_ALLOCATION',
  'MARGIN_RESERVED', 'MARGIN_RELEASED', 'MARGIN_LOCK', 'MARGIN_RELEASE',
  'PNL_CREDIT', 'PNL_DEBIT', 'PNL_SETTLEMENT', 'COMMISSION', 'SWAP',
  'ADJUSTMENT', 'FEE', 'DOCUMENT_EVENT'
));
