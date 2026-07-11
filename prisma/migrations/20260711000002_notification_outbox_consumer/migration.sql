-- FASE 2.6 (Core Trading Certification) — reliable outbox-driven order
-- notifications, same pattern as FASE 2.4's audit consumer.
--
-- notification.router.ts's eventBus listeners for order.filled and
-- position.closed wrote a Notification row (and, for order.filled, sent an
-- email) via an unawaited `void this.sendAll(...)`/`void this.send(...)`
-- call — an unhandled promise rejection there is silently swallowed by
-- Node, with zero retry and zero durable record that a notification should
-- have existed. This mirrors the pre-2.4 audit bug exactly.
--
-- Fix: the two order-lifecycle event types that already have a
-- transactionally-written OutboxEvent row (FASE 2.1) now also carry
-- `notificationProcessed: false`; notification.outbox.consumer.ts turns
-- those into Notification rows reliably. Every other notification.router.ts
-- trigger (KYC, support, autopilot, signals, wallet, risk/margin warnings,
-- account) is unrelated to the order lifecycle this OutboxEvent row exists
-- for and stays on the existing fire-and-forget path — out of scope.
--
-- `Notification.sourceOutboxId` (composite unique with `channel`, since one
-- order.filled event produces two rows — IN_APP and EMAIL) is the same
-- idempotency-key pattern as TradeAudit.sourceOutboxId, without the
-- partitioning complication since Notification isn't partitioned.

ALTER TABLE "OutboxEvent" ADD COLUMN "notificationProcessed" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "OutboxEvent" ADD COLUMN "notificationRetries" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "OutboxEvent_notificationProcessed_createdAt_idx" ON "OutboxEvent"("notificationProcessed", "createdAt");

ALTER TABLE "Notification" ADD COLUMN "sourceOutboxId" TEXT;
CREATE UNIQUE INDEX "Notification_sourceOutboxId_channel_key" ON "Notification"("sourceOutboxId", "channel");
