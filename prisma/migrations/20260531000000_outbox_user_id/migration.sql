-- AlterTable: add userId to OutboxEvent for per-user event recovery
ALTER TABLE "OutboxEvent" ADD COLUMN "userId" TEXT;

-- CreateIndex
CREATE INDEX "OutboxEvent_userId_published_idx" ON "OutboxEvent"("userId", "published");
