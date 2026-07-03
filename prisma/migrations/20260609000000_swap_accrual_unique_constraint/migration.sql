-- Migration: swap_accrual_unique_constraint
-- Adds database-level idempotency guarantee for SwapAccrual.
-- Prevents double-charging overnight swap to the same position on the same date
-- even if the nightly accrual job runs concurrently or is retried.
--
-- Without this constraint, two concurrent 22:00 UTC swap accrual runs could
-- both INSERT successfully for the same (positionId, accrualDate), charging
-- the client twice. The application-level check is insufficient under concurrency.

CREATE UNIQUE INDEX "SwapAccrual_positionId_accrualDate_key"
    ON "SwapAccrual"("positionId", "accrualDate");
