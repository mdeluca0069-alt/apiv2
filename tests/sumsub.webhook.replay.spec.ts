/**
 * sumsub.webhook.replay.spec.ts
 *
 * PHASE C PENTEST (JWT/session/replay finding #1): Sumsub's webhook HMAC
 * (X-Payload-Digest = HMAC-SHA256(rawBody, SUMSUB_WEBHOOK_SECRET)) is bound
 * only to the body, with no timestamp/nonce. A captured webhook (proxy log,
 * MITM before TLS termination, compromised monitoring pipeline) could be
 * replayed at any later time to re-apply its effect -- e.g. an attacker
 * captures a legitimate "GREEN" (approved) webhook, waits until the user's
 * KYC is legitimately re-reviewed and REJECTED, then replays the old
 * captured payload to flip kycStatus back to "approved" and unlock
 * withdrawal/trading eligibility gated on it (gateway/routes.ts checks
 * `user.kycStatus === "approved"`).
 *
 * Fix: every processed webhook's raw-body hash is recorded in a new
 * SumsubWebhookEvent table with a UNIQUE constraint; processSumsubWebhook()
 * now inserts that row BEFORE applying any effect, so a byte-identical
 * replay is recognized (P2002 unique violation) and no-op'd -- regardless
 * of what the case's current state has since moved to.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("audit-id") }));
vi.mock("../security/immutable.audit.js", () => ({ immutableAudit: { write: mockAuditWrite } }));

vi.mock("../kyc-service/sumsub.provider.js", () => ({
  sumsubProvider: {
    verifyWebhookSignature: vi.fn().mockReturnValue(true),
    mapReviewToStatus: vi.fn((reviewAnswer?: string) => (reviewAnswer === "GREEN" ? "APPROVED" : reviewAnswer === "RED" ? "REJECTED" : "DOCUMENT_CHECK")),
  },
}));

// In-memory stand-in for the SumsubWebhookEvent table -- a real unique
// constraint, enforced the same way Postgres would (throws P2002 on a
// duplicate payloadHash), so this test exercises the real control flow,
// not just a mocked-away "assume it works" stub.
const webhookEventStore = new Map<string, { payloadHash: string }>();

const mockKycCase = {
  findFirst: vi.fn(),
  update:    vi.fn().mockResolvedValue({}),
};
const mockUser = { update: vi.fn().mockResolvedValue({}) };
const mockSumsubWebhookEvent = {
  create: vi.fn(async ({ data }: { data: { payloadHash: string; applicantId: string | null; type: string } }) => {
    if (webhookEventStore.has(data.payloadHash)) {
      const err = new Error("Unique constraint failed on the fields: (`payloadHash`)");
      (err as unknown as { code: string }).code = "P2002";
      throw err;
    }
    webhookEventStore.set(data.payloadHash, { payloadHash: data.payloadHash });
    return { id: "evt-1", ...data };
  }),
};

const mockPrisma: Record<string, unknown> = {
  kycCase: mockKycCase,
  user:    mockUser,
  sumsubWebhookEvent: mockSumsubWebhookEvent,
};
mockPrisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));

vi.mock("../shared/db.js", () => ({ prisma: mockPrisma, IS_PERSISTENT: true }));

const { kycService } = await import("../kyc-service/kyc.service.js");

const GREEN_PAYLOAD = JSON.stringify({
  applicantId: "applicant-1", inspectionId: "inspection-old-1", externalUserId: "user-1",
  type: "applicantReviewed", reviewStatus: "completed",
  reviewResult: { reviewAnswer: "GREEN" },
});

beforeEach(() => {
  vi.clearAllMocks();
  webhookEventStore.clear();
  mockKycCase.findFirst.mockResolvedValue({ id: "case-1", userId: "user-1" });
});

describe("KycService.processSumsubWebhook() — PHASE C PENTEST: replay protection", () => {
  it("applies the effect on first delivery (case approved, user kycStatus flipped)", async () => {
    await kycService.processSumsubWebhook(GREEN_PAYLOAD, "valid-digest");

    expect(mockKycCase.update).toHaveBeenCalledTimes(1);
    expect(mockKycCase.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "case-1" },
      data:  expect.objectContaining({ status: "APPROVED" }),
    }));
    expect(mockUser.update).toHaveBeenCalledWith({ where: { id: "user-1" }, data: { kycStatus: "approved" } });
  });

  it("REPLAY: the exact same captured payload replayed later is recognized and does NOT re-apply its effect", async () => {
    // First (legitimate) delivery.
    await kycService.processSumsubWebhook(GREEN_PAYLOAD, "valid-digest");
    expect(mockKycCase.update).toHaveBeenCalledTimes(1);

    // Simulate time passing: the case was legitimately re-reviewed and
    // rejected in the meantime (a real webhook, different content/hash,
    // would correctly apply). Then the attacker replays the OLD captured
    // GREEN payload byte-for-byte.
    mockKycCase.update.mockClear();
    mockUser.update.mockClear();

    await kycService.processSumsubWebhook(GREEN_PAYLOAD, "valid-digest");

    // The replay must be a no-op: no second write, no re-flip to approved.
    expect(mockKycCase.update).not.toHaveBeenCalled();
    expect(mockUser.update).not.toHaveBeenCalled();
  });

  it("a genuinely different webhook (different inspectionId/content) for the same applicant is still processed normally", async () => {
    await kycService.processSumsubWebhook(GREEN_PAYLOAD, "valid-digest");
    mockKycCase.update.mockClear();
    mockUser.update.mockClear();

    const redPayload = JSON.stringify({
      applicantId: "applicant-1", inspectionId: "inspection-new-2", externalUserId: "user-1",
      type: "applicantReviewed", reviewStatus: "completed",
      reviewResult: { reviewAnswer: "RED" },
    });
    await kycService.processSumsubWebhook(redPayload, "valid-digest");

    expect(mockKycCase.update).toHaveBeenCalledTimes(1);
    expect(mockUser.update).toHaveBeenCalledWith({ where: { id: "user-1" }, data: { kycStatus: "rejected" } });
  });

  it("still rejects an invalid HMAC signature before the replay check even runs", async () => {
    const { sumsubProvider } = await import("../kyc-service/sumsub.provider.js");
    (sumsubProvider.verifyWebhookSignature as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

    await expect(kycService.processSumsubWebhook(GREEN_PAYLOAD, "bad-digest")).rejects.toThrow("WEBHOOK_SIGNATURE_INVALID");
    expect(mockSumsubWebhookEvent.create).not.toHaveBeenCalled();
  });
});
