-- Task 10: SignalTelemetry — persistent outcome tracking for every OLOS signal
CREATE TABLE "SignalTelemetry" (
    "id"                    TEXT NOT NULL,
    "signalId"              TEXT NOT NULL,
    "symbol"                TEXT NOT NULL,
    "timeframe"             TEXT NOT NULL DEFAULT '1H',
    "signalType"            TEXT NOT NULL,
    "confidence"            DOUBLE PRECISION NOT NULL,
    "entryPrice"            DECIMAL(18,8) NOT NULL,
    "stopLoss"              DECIMAL(18,8) NOT NULL,
    "target1"               DECIMAL(18,8) NOT NULL,
    "target2"               DECIMAL(18,8) NOT NULL,
    "riskRewardRatio"       DOUBLE PRECISION NOT NULL,
    "marketRegime"          TEXT NOT NULL,
    "volatilityLevel"       TEXT NOT NULL,
    "confluenceFactors"     JSONB NOT NULL,
    "indicatorsSnapshot"    JSONB NOT NULL,
    "positionId"            TEXT,
    "orderId"               TEXT,
    "actualEntryPrice"      DECIMAL(18,8),
    "outcome"               TEXT NOT NULL DEFAULT 'PENDING',
    "pnl"                   DECIMAL(18,8),
    "pnlPips"               DOUBLE PRECISION,
    "exitPrice"             DECIMAL(18,8),
    "exitReason"            TEXT,
    "durationSeconds"       INTEGER,
    "maxFavorableExcursion" DECIMAL(18,8),
    "maxAdverseExcursion"   DECIMAL(18,8),
    "generatedAt"           TIMESTAMP(3) NOT NULL,
    "executedAt"            TIMESTAMP(3),
    "closedAt"              TIMESTAMP(3),
    "expiresAt"             TIMESTAMP(3),
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignalTelemetry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SignalTelemetry_signalId_key"   ON "SignalTelemetry"("signalId");
CREATE UNIQUE INDEX "SignalTelemetry_positionId_key" ON "SignalTelemetry"("positionId");
CREATE INDEX "SignalTelemetry_symbol_outcome_idx"        ON "SignalTelemetry"("symbol", "outcome");
CREATE INDEX "SignalTelemetry_marketRegime_outcome_idx"  ON "SignalTelemetry"("marketRegime", "outcome");
CREATE INDEX "SignalTelemetry_confidence_idx"            ON "SignalTelemetry"("confidence");
CREATE INDEX "SignalTelemetry_generatedAt_idx"           ON "SignalTelemetry"("generatedAt");
CREATE INDEX "SignalTelemetry_outcome_generatedAt_idx"   ON "SignalTelemetry"("outcome", "generatedAt");
CREATE INDEX "SignalTelemetry_signalType_outcome_idx"    ON "SignalTelemetry"("signalType", "outcome");

-- Task 11: ConfidenceWeights — versioned adaptive weight sets produced by SelfOptimizer
CREATE TABLE "ConfidenceWeights" (
    "id"           TEXT NOT NULL,
    "version"      INTEGER NOT NULL,
    "weights"      JSONB NOT NULL,
    "regimeGates"  JSONB NOT NULL,
    "symbolConfig" JSONB NOT NULL,
    "sampleSize"   INTEGER NOT NULL,
    "winRate"      DOUBLE PRECISION NOT NULL,
    "profitFactor" DOUBLE PRECISION NOT NULL,
    "sharpeRatio"  DOUBLE PRECISION NOT NULL,
    "computedAt"   TIMESTAMP(3) NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfidenceWeights_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConfidenceWeights_version_key" ON "ConfidenceWeights"("version");
CREATE INDEX "ConfidenceWeights_version_idx"        ON "ConfidenceWeights"("version");

-- Task 11: EconomicEvent — macro calendar events from Finnhub
CREATE TABLE "EconomicEvent" (
    "id"        TEXT NOT NULL,
    "country"   TEXT NOT NULL,
    "currency"  TEXT NOT NULL,
    "event"     TEXT NOT NULL,
    "impact"    TEXT NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "actual"    TEXT,
    "estimate"  TEXT,
    "prev"      TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomicEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EconomicEvent_eventTime_idx"                    ON "EconomicEvent"("eventTime");
CREATE INDEX "EconomicEvent_currency_impact_eventTime_idx"    ON "EconomicEvent"("currency", "impact", "eventTime");

-- Task 11: OptimizationLog — audit trail for every weekly self-optimization run
CREATE TABLE "OptimizationLog" (
    "id"                TEXT NOT NULL,
    "runAt"             TIMESTAMP(3) NOT NULL,
    "sampleSize"        INTEGER NOT NULL,
    "previousVersion"   INTEGER,
    "newVersion"        INTEGER NOT NULL,
    "weightChanges"     JSONB NOT NULL,
    "symbolChanges"     JSONB NOT NULL,
    "regimeGateChanges" JSONB NOT NULL,
    "winRateBefore"     DOUBLE PRECISION,
    "winRateAfter"      DOUBLE PRECISION NOT NULL,
    "profitFactorAfter" DOUBLE PRECISION NOT NULL,
    "sharpeAfter"       DOUBLE PRECISION NOT NULL,
    "notes"             TEXT NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptimizationLog_pkey" PRIMARY KEY ("id")
);
