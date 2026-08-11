/**
 * risk.warning.acknowledge.ownership.spec.ts
 *
 * FRONTEND_MOBILE_HARDENING Phase 4 (KYC/compliance audit) — regression
 * guard for a confirmed IDOR / broken object-level authorization bug:
 * RiskWarningService.acknowledgeWarning(warningId) used to run an
 * unconditional `prisma.riskWarning.update({ where: { id: warningId } })`
 * with no userId anywhere in the call chain (the route handler in
 * gateway/routes.ts didn't even resolve a principal). Any authenticated
 * user could acknowledge ANY other user's risk warning by id -- including
 * the mandatory MiFID II ESMA CFD risk disclosure surfaced via
 * RiskWarningOverlay.tsx / CompliancePage.tsx -- silently marking it
 * acknowledged (with a real server-recorded acknowledgedAt) without that
 * account holder's consent.
 *
 * Fix: acknowledgeWarning(warningId, userId) now uses
 * updateMany({ where: { id, userId } }) + a count check, throwing a 404
 * when the warning doesn't belong to the caller (or doesn't exist) --
 * indistinguishable outcomes, avoiding resource enumeration.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockUpdateMany } = vi.hoisted(() => ({
  mockUpdateMany: vi.fn(),
}));

vi.mock("../shared/db.js", () => ({
  prisma: {
    riskWarning: {
      updateMany: mockUpdateMany,
    },
  },
}));

import { RiskWarningService } from "../risk-service/risk.warning.service.js";

describe("RiskWarningService.acknowledgeWarning — ownership scoping (IDOR fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes the update to both the warning id AND the calling user's id", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    const svc = new RiskWarningService();

    await svc.acknowledgeWarning("warning-belonging-to-user-a", "user-a");

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "warning-belonging-to-user-a", userId: "user-a" },
      data: expect.objectContaining({ acknowledged: true }),
    });
  });

  it("REGRESSION GUARD: rejects acknowledging a warning that belongs to a different user", async () => {
    // Simulates the real Prisma behavior: updateMany's compound where
    // (id + userId) matches zero rows when the warning belongs to someone
    // else, since the id alone would have matched under the old buggy code.
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const svc = new RiskWarningService();

    await expect(
      svc.acknowledgeWarning("warning-belonging-to-user-a", "user-b"),
    ).rejects.toThrow(/not found/i);

    // Prove the attempted call was actually scoped to the attacker's id,
    // not silently widened back to an id-only match.
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "warning-belonging-to-user-a", userId: "user-b" },
      data: expect.objectContaining({ acknowledged: true }),
    });
  });

  it("succeeds when the warning genuinely belongs to the caller", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    const svc = new RiskWarningService();

    await expect(
      svc.acknowledgeWarning("warning-1", "user-a"),
    ).resolves.toBeDefined();
  });
});
