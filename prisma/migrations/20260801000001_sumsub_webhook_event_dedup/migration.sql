-- PHASE C PENTEST (JWT/session/replay finding #1) — Sumsub webhook replay
-- protection. See prisma/schema.prisma's SumsubWebhookEvent comment for
-- the root cause.

-- CreateTable
CREATE TABLE "SumsubWebhookEvent" (
    "id" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "applicantId" TEXT,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SumsubWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SumsubWebhookEvent_payloadHash_key" ON "SumsubWebhookEvent"("payloadHash");

-- CreateIndex
CREATE INDEX "SumsubWebhookEvent_applicantId_idx" ON "SumsubWebhookEvent"("applicantId");
