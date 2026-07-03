-- Migration: partial_fills_fill_table_stoplimit_lifecycle
-- Task 8 — Core Trading Engine Hardening
--
-- Changes:
--   1. Drop Position_orderId_key unique index → allows multiple positions per order (multi-leg partial fills)
--   2. Add Position_orderId_idx non-unique index (FK lookup performance)
--   3. Add Order.filledQuantity column — running total of quantity filled across all legs
--   4. Create Fill table — immutable record of each individual fill leg
--   5. (No schema change needed for LIMIT_ARMED/LIMIT_EXPIRED/LIMIT_CANCELLED — status is String in DB)
--
-- Rollback: see below each statement

-- ── 1. Drop unique constraint on Position.orderId ─────────────────────────────
-- Allows the same orderId to appear on multiple Position rows (partial fill legs).
-- ROLLBACK: CREATE UNIQUE INDEX "Position_orderId_key" ON "Position"("orderId");
DROP INDEX IF EXISTS "Position_orderId_key";

-- ── 2. Add non-unique index for Position.orderId FK lookup ────────────────────
-- Without the unique index, FK lookups from Fill → Position need this.
-- ROLLBACK: DROP INDEX IF EXISTS "Position_orderId_idx";
CREATE INDEX IF NOT EXISTS "Position_orderId_idx" ON "Position"("orderId");

-- ── 3. Add filledQuantity to Order ────────────────────────────────────────────
-- Tracks cumulative filled quantity across all fill legs.
-- Order reaches FILLED when filledQuantity >= quantity.
-- ROLLBACK: ALTER TABLE "Order" DROP COLUMN IF EXISTS "filledQuantity";
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "filledQuantity" DECIMAL(18,8) NOT NULL DEFAULT 0;

-- ── 4. Create Fill table ──────────────────────────────────────────────────────
-- Immutable record of each fill leg. Supports both full fills (one row)
-- and partial fills (multiple rows per order as legs arrive).
-- ROLLBACK: DROP TABLE IF EXISTS "Fill";
CREATE TABLE IF NOT EXISTS "Fill" (
  "id"                TEXT         NOT NULL,
  "orderId"           TEXT         NOT NULL,
  "positionId"        TEXT,
  "quantity"          DECIMAL(18,8) NOT NULL,
  "price"             DECIMAL(18,8) NOT NULL,
  "liquidityProvider" TEXT         NOT NULL DEFAULT 'IGFX_INTERNAL',
  "slippage"          DECIMAL(18,8) NOT NULL DEFAULT 0,
  "fees"              DECIMAL(18,8) NOT NULL DEFAULT 0,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- FK: Fill.orderId → Order.id
ALTER TABLE "Fill"
  ADD CONSTRAINT "Fill_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK: Fill.positionId → Position.id (nullable — fill may precede position creation in error path)
ALTER TABLE "Fill"
  ADD CONSTRAINT "Fill_positionId_fkey"
  FOREIGN KEY ("positionId") REFERENCES "Position"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes for Fill
CREATE INDEX IF NOT EXISTS "Fill_orderId_idx"    ON "Fill"("orderId");
CREATE INDEX IF NOT EXISTS "Fill_positionId_idx" ON "Fill"("positionId");
