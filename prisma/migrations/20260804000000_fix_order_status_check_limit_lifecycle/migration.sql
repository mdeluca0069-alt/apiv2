-- PHASE H (fresh production-certification due-diligence audit) --
-- Order_status_check was missing the three STOP_LIMIT lifecycle statuses.
--
-- shared/contracts.ts's OrderStatusSchema declares "LIMIT_ARMED",
-- "LIMIT_EXPIRED", and "LIMIT_CANCELLED" for the STOP_LIMIT order type
-- (a stop that, once triggered, arms a resting limit leg rather than
-- filling immediately). Two of these are live, reachable write paths, not
-- theoretical: trading-service/order.trigger.watcher.ts calls
-- orderLifecycle.transition(orderId, "LIMIT_ARMED", ...) when a STOP_LIMIT
-- order's stop triggers, and trading-service/pending.order.expiry.ts calls
-- the same with "LIMIT_EXPIRED" when an armed limit order's TTL elapses
-- without filling. orderLifecycle.transition() (trading-service/
-- order.lifecycle.ts) writes these via a raw
-- `UPDATE "Order" SET status = ${toStatus} ...` -- not through Prisma's
-- generated client, so nothing at the application layer would have caught
-- this before the write reached Postgres.
--
-- Order_status_check (last (re)defined in
-- 20260601220000_phase_omega/migration.sql) only permitted:
--   RECEIVED, RISK_REVIEW, ACCEPTED, PARTIALLY_FILLED, FILLED, REJECTED, CANCELLED
--
-- On a genuinely fresh database (migrations replayed in order, constraint
-- enforced as declared), the first STOP_LIMIT order to trigger would fail
-- outright with "new row ... violates check constraint
-- Order_status_check" -- the exact bug class already fixed once for
-- LedgerEntry.type/DEPOSIT_CREDIT (20260709000001), left unfixed here.
--
-- LIMIT_CANCELLED has no current write site (reserved for a future
-- client-initiated-cancel-of-an-armed-order path) but is included for the
-- same reason DEPOSIT_CREDIT's sibling fix included every declared value,
-- not just the ones already observed failing.

ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_status_check";

ALTER TABLE "Order" ADD CONSTRAINT "Order_status_check" CHECK ("status" IN (
  'RECEIVED', 'RISK_REVIEW', 'ACCEPTED',
  'PARTIALLY_FILLED', 'FILLED',
  'REJECTED', 'CANCELLED',
  'LIMIT_ARMED', 'LIMIT_EXPIRED', 'LIMIT_CANCELLED'
));
