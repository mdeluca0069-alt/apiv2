/**
 * autopilot.eligibility.spec.ts
 *
 * Real-client safety layer — AutopilotEligibility.assertEligible() gates
 * autopilot on KYC approval, tier, and a funded wallet. Must fail CLOSED:
 * any lookup error means NOT eligible, never a silent pass-through.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockFindUnique, mockGetMarginState } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockGetMarginState: vi.fn(),
}));

let isPersistent = true;

vi.mock("../shared/db.js", () => ({
  get IS_PERSISTENT() { return isPersistent; },
  prisma: { user: { findUnique: mockFindUnique } },
}));

vi.mock("../risk-service/margin.controller.js", () => ({
  marginController: { getMarginState: mockGetMarginState },
}));

import { AutopilotEligibility } from "../autopilot-service/autopilot.eligibility.js";

beforeEach(() => {
  isPersistent = true;
  mockFindUnique.mockReset().mockResolvedValue({ tier: "PLATINUM", kycStatus: "approved" });
  mockGetMarginState.mockReset().mockResolvedValue({ equity: 1_000 });
});

describe("AutopilotEligibility.assertEligible", () => {
  it("is eligible when KYC approved, tier sufficient, and wallet funded", async () => {
    const result = await new AutopilotEligibility().assertEligible("user-1");
    expect(result).toEqual({ eligible: true });
  });

  it("rejects when KYC is not approved", async () => {
    mockFindUnique.mockResolvedValue({ tier: "PLATINUM", kycStatus: "pending" });
    const result = await new AutopilotEligibility().assertEligible("user-1");
    expect(result.eligible).toBe(false);
    expect((result as { reason: string }).reason).toContain("KYC not approved");
  });

  it("rejects when tier is below PLATINUM", async () => {
    mockFindUnique.mockResolvedValue({ tier: "GOLD", kycStatus: "approved" });
    const result = await new AutopilotEligibility().assertEligible("user-1");
    expect(result.eligible).toBe(false);
    expect((result as { reason: string }).reason).toContain("Tier GOLD");
  });

  it("rejects when the wallet has no funded balance", async () => {
    mockGetMarginState.mockResolvedValue({ equity: 0 });
    const result = await new AutopilotEligibility().assertEligible("user-1");
    expect(result.eligible).toBe(false);
    expect((result as { reason: string }).reason).toContain("no funded balance");
  });

  it("rejects when the user is not found", async () => {
    mockFindUnique.mockResolvedValue(null);
    const result = await new AutopilotEligibility().assertEligible("user-1");
    expect(result.eligible).toBe(false);
  });

  it("fails CLOSED when the user lookup throws", async () => {
    mockFindUnique.mockRejectedValue(new Error("db down"));
    const result = await new AutopilotEligibility().assertEligible("user-1");
    expect(result.eligible).toBe(false);
    expect((result as { reason: string }).reason).toContain("db down");
  });

  it("fails CLOSED when the margin/equity lookup throws", async () => {
    mockGetMarginState.mockRejectedValue(new Error("wallet not found"));
    const result = await new AutopilotEligibility().assertEligible("user-1");
    expect(result.eligible).toBe(false);
  });

  it("is always eligible in sandbox/non-persistent mode (nothing to verify against)", async () => {
    isPersistent = false;
    const result = await new AutopilotEligibility().assertEligible("user-1");
    expect(result).toEqual({ eligible: true });
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});
