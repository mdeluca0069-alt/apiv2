/**
 * AutopilotEligibility — server-side gate verifying a client is actually
 * allowed to run Autopilot with real money: KYC approved, tier ≥ PLATINUM,
 * and a funded real wallet (balance > 0). Checked both at config-save time
 * (so the toggle itself can't be flipped without it) and again inside the
 * pipeline on every signal (defense in depth).
 *
 * Fails closed: any lookup error means NOT eligible, never a silent skip.
 * This replaces the old try/catch-and-ignore tier check in the pipeline,
 * which let a signal through if the account lookup threw.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { marginController } from "../risk-service/margin.controller.js";

export const TIER_RANK: Record<string, number> = {
  STANDARD: 1, GOLD: 2, PLATINUM: 3, VIP: 4, ENTERPRISE: 5,
};

export const AUTOPILOT_MIN_TIER = "PLATINUM";

export type EligibilityResult = { eligible: true } | { eligible: false; reason: string };

export class AutopilotEligibility {
  async assertEligible(
    userId: string,
    prefetchedMargin?: import("../shared/contracts.js").MarginState | null,
  ): Promise<EligibilityResult> {
    if (!IS_PERSISTENT || !prisma) {
      // Sandbox/no-DB mode — nothing to verify against, never block local dev.
      return { eligible: true };
    }

    try {
      const user = await prisma.user.findUnique({
        where:  { id: userId },
        select: { tier: true, kycStatus: true },
      });
      if (!user) return { eligible: false, reason: "Account not found" };

      if (user.kycStatus !== "approved") {
        return { eligible: false, reason: `KYC not approved (status: ${user.kycStatus})` };
      }

      const tierRank = TIER_RANK[user.tier] ?? 0;
      if (tierRank < TIER_RANK[AUTOPILOT_MIN_TIER]!) {
        return { eligible: false, reason: `Tier ${user.tier} below required ${AUTOPILOT_MIN_TIER}` };
      }

      const margin = prefetchedMargin ?? await marginController.getMarginState(userId);
      if (margin.equity <= 0) {
        return { eligible: false, reason: "Account has no funded balance" };
      }

      return { eligible: true };
    } catch (err) {
      return { eligible: false, reason: `Eligibility check failed: ${(err as Error).message}` };
    }
  }
}

export const autopilotEligibility = new AutopilotEligibility();
