-- Migration: wallet_nonneg_constraints
-- Adds CHECK constraints to prevent wallet.locked and wallet.balance from going
-- negative. These are financial invariants that should never be violated:
--
--   wallet.locked  represents margin reserved for open positions  (always >= 0)
--   wallet.balance represents client cash balance                  (always >= 0)
--
-- Any code path that would violate these constraints has a bug. The constraint
-- surfaces the bug immediately as a DB error rather than silently corrupting state.
--
-- Safety: we clean up any pre-existing invalid values before adding constraints,
-- so the migration applies cleanly to existing data.

-- Fix any negative locked values left by potential recovery-service edge cases
UPDATE "WalletAccount" SET locked = 0 WHERE locked < 0;

-- Fix any negative balance values (should not exist but defensive cleanup)
UPDATE "WalletAccount" SET balance = 0 WHERE balance < 0;

ALTER TABLE "WalletAccount"
  ADD CONSTRAINT "wallet_locked_nonneg"
  CHECK (locked >= 0);

ALTER TABLE "WalletAccount"
  ADD CONSTRAINT "wallet_balance_nonneg"
  CHECK (balance >= 0);
