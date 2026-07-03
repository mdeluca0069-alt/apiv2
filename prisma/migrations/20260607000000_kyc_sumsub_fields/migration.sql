-- Add Sumsub integration fields to KycCase
ALTER TABLE "KycCase"
  ADD COLUMN IF NOT EXISTS "sumsubApplicantId"  TEXT,
  ADD COLUMN IF NOT EXISTS "sumsubReviewStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "sumsubReviewAnswer" TEXT,
  ADD COLUMN IF NOT EXISTS "sumsubInspectionId" TEXT,
  ADD COLUMN IF NOT EXISTS "sumsubWebhookData"  JSONB;

-- Index for webhook lookups by applicant ID
CREATE INDEX IF NOT EXISTS "KycCase_sumsubApplicantId_idx"
  ON "KycCase"("sumsubApplicantId");
