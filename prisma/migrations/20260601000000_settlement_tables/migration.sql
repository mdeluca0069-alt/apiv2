-- Migration: settlement tables
-- Adds AccountDailySnapshot and SwapAccrual for the settlement & reconciliation sprint.

-- CreateTable: AccountDailySnapshot
CREATE TABLE "AccountDailySnapshot" (
    "id"             TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "snapshotDate"   DATE NOT NULL,
    "balance"        DECIMAL(18,8) NOT NULL,
    "equity"         DECIMAL(18,8) NOT NULL,
    "marginUsed"     DECIMAL(18,8) NOT NULL,
    "freeMargin"     DECIMAL(18,8) NOT NULL,
    "unrealizedPnl"  DECIMAL(18,8) NOT NULL,
    "realizedPnlDay" DECIMAL(18,8) NOT NULL,
    "totalFeesDay"   DECIMAL(18,8) NOT NULL,
    "totalSwapsDay"  DECIMAL(18,8) NOT NULL,
    "openPositions"  INTEGER NOT NULL,
    "closedToday"    INTEGER NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDailySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SwapAccrual
CREATE TABLE "SwapAccrual" (
    "id"              TEXT NOT NULL,
    "positionId"      TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "symbol"          TEXT NOT NULL,
    "side"            TEXT NOT NULL,
    "swapAmount"      DECIMAL(18,8) NOT NULL,
    "swapRateAnnual"  DECIMAL(10,6) NOT NULL,
    "nights"          INTEGER NOT NULL,
    "accrualDate"     DATE NOT NULL,
    "settlementId"    TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SwapAccrual_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountDailySnapshot_userId_snapshotDate_key"
    ON "AccountDailySnapshot"("userId", "snapshotDate");

CREATE INDEX "AccountDailySnapshot_userId_snapshotDate_idx"
    ON "AccountDailySnapshot"("userId", "snapshotDate");

CREATE INDEX "SwapAccrual_positionId_idx"
    ON "SwapAccrual"("positionId");

CREATE INDEX "SwapAccrual_userId_accrualDate_idx"
    ON "SwapAccrual"("userId", "accrualDate");
