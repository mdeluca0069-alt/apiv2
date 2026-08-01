/**
 * kyc.status.transition.race.spec.ts
 *
 * PHASE C PENTEST (race-condition finding #4): approveCase(), the private
 * _rejectCase() (shared by the admin reject route and the risk engine's
 * auto-reject), and processSumsubWebhook() each did an UNCONDITIONAL
 * `tx.kycCase.update({ where: { id: caseId }, data: { status: ... } })` --
 * no precondition on the case's current status, no row lock, no explicit
 * isolation level. Concretely: an admin clicking "Approve" at the same
 * moment a (possibly stale/delayed, or re-triggered) Sumsub webhook with
 * reviewAnswer: RED arrives for the same applicant -- whichever commits
 * last silently wins, and an already-terminal (APPROVED/REJECTED) case
 * could be flipped again with no error at all.
 *
 * Fix: every transition now goes through `updateMany({ where: { id,
 * status: { notIn: ["APPROVED", "REJECTED"] } } })` and checks
 * `result.count`, so once a case reaches a terminal state, no further
 * transition (admin or webhook-driven) can silently overwrite it.
 *
 * This mock's `updateMany` faithfully tracks a real "current status" per
 * case (not a canned always-succeeds stub), so these tests exercise the
 * actual conditional-update semantics.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("id") }));
vi.mock("../security/immutable.audit.js", () => ({ immutableAudit: { write: mockAuditWrite } }));
vi.mock("../events-bus/event.bus.js", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("../kyc-service/sumsub.provider.js", () => ({
  sumsubProvider: {
    verifyWebhookSignature: vi.fn().mockReturnValue(true),
    mapReviewToStatus: vi.fn((reviewAnswer?: string) => (reviewAnswer === "GREEN" ? "APPROVED" : reviewAnswer === "RED" ? "REJECTED" : "DOCUMENT_CHECK")),
  },
}));

// In-memory stand-in for the KycCase table's status column -- updateMany()
// only succeeds (count: 1) when the row's CURRENT status matches the
// where clause's `notIn` condition, exactly like a real conditional
// UPDATE statement would.
const cases = new Map<string, { id: string; userId: string; status: string }>();

const mockKycCase = {
  findUnique: vi.fn(async ({ where }: { where: { id: string } }) => cases.get(where.id) ?? null),
  findFirst:  vi.fn(async (): Promise<{ id: string; userId: string } | null> => [...cases.values()][0] ?? null),
  updateMany: vi.fn(async ({ where, data }: { where: { id: string; status?: { notIn: string[] } }; data: { status: string } }) => {
    const row = cases.get(where.id);
    if (!row) return { count: 0 };
    if (where.status?.notIn.includes(row.status)) return { count: 0 };
    row.status = data.status;
    return { count: 1 };
  }),
};

const mockUser = { update: vi.fn().mockResolvedValue({}) };
const mockSumsubWebhookEvent = { create: vi.fn().mockResolvedValue({}) };

const mockPrisma: Record<string, unknown> = {
  kycCase: mockKycCase,
  user:    mockUser,
  sumsubWebhookEvent: mockSumsubWebhookEvent,
};
mockPrisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));

vi.mock("../shared/db.js", () => ({ prisma: mockPrisma, IS_PERSISTENT: true }));

const { kycService } = await import("../kyc-service/kyc.service.js");

beforeEach(() => {
  vi.clearAllMocks();
  cases.clear();
  cases.set("case-1", { id: "case-1", userId: "user-1", status: "MANUAL_REVIEW" });
});

describe("KycService — PHASE C PENTEST: atomic KYC status transitions", () => {
  it("approveCase() succeeds on a non-terminal case", async () => {
    await kycService.approveCase("case-1", "admin-1");
    expect(cases.get("case-1")!.status).toBe("APPROVED");
  });

  it("approveCase() throws (409) and does not touch user.kycStatus when the case is already REJECTED", async () => {
    cases.get("case-1")!.status = "REJECTED";

    await expect(kycService.approveCase("case-1", "admin-1")).rejects.toThrow(/terminal state/);

    expect(cases.get("case-1")!.status).toBe("REJECTED"); // unchanged
    expect(mockUser.update).not.toHaveBeenCalled();
  });

  it("rejectCase() is silently skipped (no throw, no user.kycStatus change) when the case is already APPROVED", async () => {
    cases.get("case-1")!.status = "APPROVED";

    await kycService.rejectCase("case-1", "admin-1", "late concern");

    expect(cases.get("case-1")!.status).toBe("APPROVED"); // unchanged, not flipped to REJECTED
    expect(mockUser.update).not.toHaveBeenCalled();
  });

  it("THE EXACT RACE SCENARIO: an admin approval and a stale/concurrent RED webhook for the same case -- only the first to commit wins, the case never ends up inconsistent", async () => {
    // Admin approves first.
    await kycService.approveCase("case-1", "admin-1");
    expect(cases.get("case-1")!.status).toBe("APPROVED");

    // A stale Sumsub webhook (captured/queued before the admin's decision,
    // delivered after) tries to reject the SAME case.
    const staleRedWebhook = JSON.stringify({
      applicantId: "applicant-1", inspectionId: "inspection-old", externalUserId: "user-1",
      type: "applicantReviewed", reviewStatus: "completed",
      reviewResult: { reviewAnswer: "RED" },
    });
    mockKycCase.findFirst.mockResolvedValueOnce({ id: "case-1", userId: "user-1" });

    await kycService.processSumsubWebhook(staleRedWebhook, "valid-digest");

    // The admin's APPROVED decision must NOT have been silently overwritten.
    expect(cases.get("case-1")!.status).toBe("APPROVED");
  });

  it("a webhook CAN transition a genuinely non-terminal case (no admin decision yet)", async () => {
    mockKycCase.findFirst.mockResolvedValueOnce({ id: "case-1", userId: "user-1" });
    const greenWebhook = JSON.stringify({
      applicantId: "applicant-1", inspectionId: "inspection-1", externalUserId: "user-1",
      type: "applicantReviewed", reviewStatus: "completed",
      reviewResult: { reviewAnswer: "GREEN" },
    });

    await kycService.processSumsubWebhook(greenWebhook, "valid-digest");

    expect(cases.get("case-1")!.status).toBe("APPROVED");
    expect(mockUser.update).toHaveBeenCalledWith({ where: { id: "user-1" }, data: { kycStatus: "approved" } });
  });
});
