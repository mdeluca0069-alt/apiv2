-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "roles" JSONB NOT NULL,
    "permissions" JSONB NOT NULL,
    "tier" TEXT NOT NULL,
    "kycStatus" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Instrument" (
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assetClass" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "precision" INTEGER NOT NULL,
    "minTradeSize" DECIMAL(65,30) NOT NULL,
    "maxLeverageRetail" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Instrument_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "clientOrderId" TEXT,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "quantity" DECIMAL(18,8) NOT NULL,
    "requestedPrice" DECIMAL(18,8),
    "averageFillPrice" DECIMAL(18,8),
    "notional" DECIMAL(18,8) NOT NULL,
    "marginRequired" DECIMAL(18,8) NOT NULL,
    "leverage" INTEGER NOT NULL DEFAULT 1,
    "stopLoss" DECIMAL(18,8),
    "takeProfit" DECIMAL(18,8),
    "slippage" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "fees" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "riskCheckResult" JSONB,
    "rejectionReason" TEXT,
    "filledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" DECIMAL(18,8) NOT NULL,
    "entryPrice" DECIMAL(18,8) NOT NULL,
    "markPrice" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "pnl" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "pnlPercent" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "marginUsed" DECIMAL(18,8) NOT NULL,
    "leverage" INTEGER NOT NULL,
    "stopLoss" DECIMAL(18,8),
    "takeProfit" DECIMAL(18,8),
    "exitPrice" DECIMAL(18,8),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarginSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "equity" DECIMAL(18,8) NOT NULL,
    "balance" DECIMAL(18,8) NOT NULL,
    "marginUsed" DECIMAL(18,8) NOT NULL,
    "freeMargin" DECIMAL(18,8) NOT NULL,
    "marginLevelPct" DECIMAL(10,4) NOT NULL,
    "unrealizedPnl" DECIMAL(18,8) NOT NULL,
    "triggerReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarginSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "retries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "type" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "note" TEXT NOT NULL DEFAULT '',
    "runningBalance" DECIMAL(18,8),
    "debitAccount" TEXT,
    "creditAccount" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "balance" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "equity" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "locked" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fileName" TEXT,
    "rejectionReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Session" (
    "refreshToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("refreshToken")
);

-- CreateTable
CREATE TABLE "TradeAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "positionId" TEXT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "entryPrice" DECIMAL(65,30),
    "exitPrice" DECIMAL(65,30),
    "stopLoss" DECIMAL(65,30),
    "takeProfit" DECIMAL(65,30),
    "pnlRealized" DECIMAL(65,30),
    "pnlUnrealized" DECIMAL(65,30),
    "pnlPercent" DECIMAL(65,30),
    "marginUsed" DECIMAL(65,30),
    "leverage" INTEGER,
    "fees" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "slippage" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "duration" INTEGER,
    "tradeStatus" TEXT NOT NULL,
    "lifecycle" JSONB NOT NULL,
    "riskMetrics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OlosSignal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "confidence" DECIMAL(65,30) NOT NULL,
    "setupPattern" TEXT NOT NULL,
    "setupDescription" TEXT NOT NULL,
    "supportLevel" DECIMAL(65,30),
    "resistanceLevel" DECIMAL(65,30),
    "confluenceFactors" JSONB NOT NULL,
    "confidenceBreakdown" JSONB NOT NULL,
    "entryPrice" DECIMAL(65,30) NOT NULL,
    "entryRationale" TEXT NOT NULL,
    "targetLevels" JSONB NOT NULL,
    "stopLoss" DECIMAL(65,30) NOT NULL,
    "slRationale" TEXT NOT NULL,
    "riskRewardRatio" DECIMAL(65,30) NOT NULL,
    "macroEvents" JSONB NOT NULL,
    "marketRegime" TEXT NOT NULL,
    "volatilityLevel" TEXT NOT NULL,
    "expectedRiskPips" DECIMAL(65,30) NOT NULL,
    "marginRequirement" DECIMAL(65,30) NOT NULL,
    "liquidityProfile" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "triggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OlosSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskWarning" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "riskScore" INTEGER NOT NULL,
    "marginLevel" DECIMAL(65,30) NOT NULL,
    "portfolioAggregate" JSONB NOT NULL,
    "esmaLeverageActive" BOOLEAN NOT NULL DEFAULT true,
    "negativeBalanceActive" BOOLEAN NOT NULL DEFAULT true,
    "liveTradeDisabled" BOOLEAN NOT NULL DEFAULT false,
    "scenarios" JSONB NOT NULL,
    "upcomingEvents" JSONB NOT NULL,
    "marginForecast" JSONB NOT NULL,
    "exposureHeatmap" JSONB NOT NULL,
    "killSwitchTriggers" JSONB NOT NULL,
    "regulatoryLevel" TEXT NOT NULL,
    "regulatoryText" TEXT,
    "eventCalendarItems" JSONB NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskWarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyContent" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "videoUrl" TEXT,
    "duration" INTEGER,
    "sections" JSONB NOT NULL,
    "caseStudies" JSONB,
    "resources" JSONB,
    "prerequisites" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nextTopics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "relatedContent" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "completionRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "rating" DECIMAL(65,30),
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserAcademyProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "progress" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "lastViewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "rating" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAcademyProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Order_userId_status_idx" ON "Order"("userId", "status");

-- CreateIndex
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_symbol_status_idx" ON "Order"("symbol", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_userId_clientOrderId_key" ON "Order"("userId", "clientOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_orderId_key" ON "Position"("orderId");

-- CreateIndex
CREATE INDEX "Position_userId_status_idx" ON "Position"("userId", "status");

-- CreateIndex
CREATE INDEX "Position_userId_closedAt_idx" ON "Position"("userId", "closedAt");

-- CreateIndex
CREATE INDEX "Position_symbol_status_idx" ON "Position"("symbol", "status");

-- CreateIndex
CREATE INDEX "MarginSnapshot_userId_createdAt_idx" ON "MarginSnapshot"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_published_createdAt_idx" ON "OutboxEvent"("published", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_userId_createdAt_idx" ON "LedgerEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_type_status_idx" ON "LedgerEntry"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WalletAccount_userId_key" ON "WalletAccount"("userId");

-- CreateIndex
CREATE INDEX "WalletAccount_userId_idx" ON "WalletAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientDocument_userId_documentKey_key" ON "ClientDocument"("userId", "documentKey");

-- CreateIndex
CREATE INDEX "TradeAudit_userId_idx" ON "TradeAudit"("userId");

-- CreateIndex
CREATE INDEX "TradeAudit_symbol_idx" ON "TradeAudit"("symbol");

-- CreateIndex
CREATE INDEX "TradeAudit_createdAt_idx" ON "TradeAudit"("createdAt");

-- CreateIndex
CREATE INDEX "OlosSignal_userId_idx" ON "OlosSignal"("userId");

-- CreateIndex
CREATE INDEX "OlosSignal_symbol_idx" ON "OlosSignal"("symbol");

-- CreateIndex
CREATE INDEX "OlosSignal_status_idx" ON "OlosSignal"("status");

-- CreateIndex
CREATE INDEX "RiskWarning_userId_idx" ON "RiskWarning"("userId");

-- CreateIndex
CREATE INDEX "RiskWarning_severity_idx" ON "RiskWarning"("severity");

-- CreateIndex
CREATE INDEX "AcademyContent_category_idx" ON "AcademyContent"("category");

-- CreateIndex
CREATE INDEX "AcademyContent_level_idx" ON "AcademyContent"("level");

-- CreateIndex
CREATE INDEX "AcademyContent_isPublished_idx" ON "AcademyContent"("isPublished");

-- CreateIndex
CREATE INDEX "UserAcademyProgress_userId_idx" ON "UserAcademyProgress"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserAcademyProgress_userId_contentId_key" ON "UserAcademyProgress"("userId", "contentId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "Instrument"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "Instrument"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletAccount" ADD CONSTRAINT "WalletAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeAudit" ADD CONSTRAINT "TradeAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OlosSignal" ADD CONSTRAINT "OlosSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskWarning" ADD CONSTRAINT "RiskWarning_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAcademyProgress" ADD CONSTRAINT "UserAcademyProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
