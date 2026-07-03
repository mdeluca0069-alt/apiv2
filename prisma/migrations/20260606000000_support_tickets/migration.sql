-- CreateTable
CREATE TABLE IF NOT EXISTS "SupportTicket" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "subject"     TEXT NOT NULL,
    "message"     TEXT NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'OPEN',
    "priority"    TEXT NOT NULL DEFAULT 'NORMAL',
    "category"    TEXT NOT NULL DEFAULT 'GENERAL',
    "resolution"  TEXT,
    "resolvedAt"  TIMESTAMP(3),
    "slaDeadline" TIMESTAMP(3),
    "agentNote"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupportTicket_userId_status_idx" ON "SupportTicket"("userId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupportTicket_status_priority_idx" ON "SupportTicket"("status", "priority");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SupportTicket_createdAt_idx" ON "SupportTicket"("createdAt");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SupportTicket_userId_fkey'
  ) THEN
    ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
