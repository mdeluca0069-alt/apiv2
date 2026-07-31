/**
 * affiliate.service.create.audit.spec.ts
 *
 * PHASE2_REMEDIATION (H16) — the admin route audit found that
 * POST /admin/affiliates (AffiliateService.create()) had zero call into the
 * permanent, hash-chained AuditLog, unlike its sibling setStatus() (used by
 * activate/deactivate), which already writes an `affiliate.<status>` entry.
 * create() establishes the commission rate and generates the referral code
 * -- had no record of which admin created it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindUnique, mockCreate } = vi.hoisted(() => ({
  mockFindUnique: vi.fn().mockResolvedValue(null),
  mockCreate:     vi.fn(),
}));
vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: { affiliate: { findUnique: mockFindUnique, create: mockCreate } },
}));

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("audit-id-1") }));
vi.mock("../security/immutable.audit.js", () => ({
  immutableAudit: { write: mockAuditWrite },
}));

vi.mock("../events-bus/event.bus.js", () => ({
  eventBus: { emit: vi.fn() },
}));

const { affiliateService } = await import("../crm/affiliate.service.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUnique.mockResolvedValue(null);
  mockCreate.mockResolvedValue({
    id: "aff-1", name: "Jane Partner", email: "jane@example.com",
    code: "JANEPARTNER1234", commissionPct: { toNumber: () => 25 },
    status: "PENDING", createdAt: new Date(), Referrals: [], Commissions: [],
  });
  mockAuditWrite.mockResolvedValue("audit-id-1");
});

describe("AffiliateService.create() — PHASE2_REMEDIATION (H16): immutable audit trail", () => {
  it("writes an immutable audit entry attributing the creating admin", async () => {
    const affiliate = await affiliateService.create({ name: "Jane Partner", email: "jane@example.com", commissionPct: 25 }, "admin-1");

    expect(affiliate.id).toBe("aff-1");
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    const [entry] = mockAuditWrite.mock.calls[0]!;
    expect(entry).toMatchObject({
      actor:  "admin-1",
      action: "affiliate.created",
      entity: "aff-1",
      payload: expect.objectContaining({ name: "Jane Partner", email: "jane@example.com" }),
    });
  });

  it("still creates and returns the affiliate even if the audit write itself fails", async () => {
    mockAuditWrite.mockRejectedValueOnce(new Error("audit table unreachable"));

    const affiliate = await affiliateService.create({ name: "Jane Partner", email: "jane@example.com" }, "admin-1");

    expect(affiliate.id).toBe("aff-1");
  });
});
