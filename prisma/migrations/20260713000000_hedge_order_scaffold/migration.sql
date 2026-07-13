-- FASE 3.8 (Group D) — scaffold for external-LP hedging.
--
-- No real external liquidity provider exists in this system today (confirmed:
-- zero A-book/STP path to any external LP anywhere in the repo). This table
-- exists so the hedge-decision policy (hedge-service/hedge.policy.ts) and its
-- audit trail are real and queryable now, ready to plug in an actual external
-- adapter later without a schema change. Every row this system creates today
-- resolves to status='REJECTED', "providerId"='NULL_PROVIDER' — see
-- hedge-service/null.hedge.provider.ts.

-- CreateTable
CREATE TABLE "HedgeOrder" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "notional" DECIMAL(18,2) NOT NULL,
    "quantity" DECIMAL(18,8),
    "status" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "externalRef" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HedgeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HedgeOrder_symbol_status_idx" ON "HedgeOrder"("symbol", "status");

-- CreateIndex
CREATE INDEX "HedgeOrder_createdAt_idx" ON "HedgeOrder"("createdAt");

-- AddForeignKey
ALTER TABLE "HedgeOrder" ADD CONSTRAINT "HedgeOrder_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "Instrument"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;
