/**
 * ClientExposureLimits — per-client aggregate exposure cap.
 *
 * RISK_ENGINE_FREEZE.md §3.1: "MANCANTE" -- no cap on a single client's total
 * open notional or concurrent position count existed anywhere in the repo.
 * House-wide per-symbol exposure (exposure.limits.ts) and per-order margin
 * availability (margin.controller.ts) were both already enforced, but a
 * client with enough equity could still concentrate into an unbounded number
 * of large positions. This closes that specific structural gap.
 *
 * Tier-keyed hardcoded limits, same convention as gateway/rate-limiter.ts's
 * TIER_LIMITS and trading-service/commission.calculator.ts's TIER_FACTOR
 * (not DB/admin-configurable -- consistent with exposure.limits.ts's own
 * EXPOSURE_LIMITS being hardcoded too).
 *
 * This is a best-effort structural gate, not a hard atomic invariant: it
 * reads current open positions live but is not lock-scoped per-client the
 * way exposure.limits.ts's checkCanOpenAtomic is per-symbol. The real hard
 * safety net against over-leveraging is margin.controller.ts's atomic
 * checkAndLockMargin, called earlier in the same pre-trade pipeline -- a
 * same-instant double-submit race here could in theory admit one order
 * slightly over cap, but could never over-leverage the account past its
 * real equity.
 */
import type { Prisma } from "@prisma/client";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import type { AccountTier } from "../shared/contracts.js";
import { liveNotional } from "../market-data/position.valuation.js";

/** See order.lifecycle.ts / exposure.limits.ts — same composability contract. */
type Db = Prisma.TransactionClient | typeof prisma;

export type ClientExposureCheckResult =
  | { ok: true }
  | { ok: false; reason: "CLIENT_EXPOSURE_LIMIT_EXCEEDED"; detail: string };

export const CLIENT_EXPOSURE_LIMITS: Record<AccountTier, { maxNotionalUsd: number; maxOpenPositions: number }> = {
  STANDARD:   { maxNotionalUsd: 250_000,    maxOpenPositions: 15  },
  GOLD:       { maxNotionalUsd: 750_000,    maxOpenPositions: 25  },
  PLATINUM:   { maxNotionalUsd: 2_000_000,  maxOpenPositions: 40  },
  VIP:        { maxNotionalUsd: 5_000_000,  maxOpenPositions: 60  },
  ENTERPRISE: { maxNotionalUsd: 20_000_000, maxOpenPositions: 100 },
};

class ClientExposureLimitsChecker {
  async check(userId: string, tier: string, incomingNotional: number): Promise<ClientExposureCheckResult> {
    if (!IS_PERSISTENT) return { ok: true };

    const limit = CLIENT_EXPOSURE_LIMITS[tier as AccountTier] ?? CLIENT_EXPOSURE_LIMITS.STANDARD;

    const positions = await prisma!.position.findMany({
      where:  { userId, status: "OPEN" },
      select: { symbol: true, quantity: true, entryPrice: true },
    });

    if (positions.length + 1 > limit.maxOpenPositions) {
      return {
        ok:     false,
        reason: "CLIENT_EXPOSURE_LIMIT_EXCEEDED",
        detail: `Opening this position would exceed the ${tier} tier's limit of ${limit.maxOpenPositions} concurrent open positions`,
      };
    }

    // MARKET_DATA_FREEZE.md §0.3: live quoteCache valuation, not the
    // Position.markPrice DB column -- see market-data/position.valuation.ts.
    const currentNotional = positions.reduce(
      (sum, p) => sum + liveNotional({ symbol: p.symbol, quantity: p.quantity.toNumber(), entryPrice: p.entryPrice.toNumber() }),
      0,
    );
    const projectedNotional = currentNotional + incomingNotional;

    if (projectedNotional > limit.maxNotionalUsd) {
      return {
        ok:     false,
        reason: "CLIENT_EXPOSURE_LIMIT_EXCEEDED",
        detail: `Opening this position would bring total exposure to ${projectedNotional.toFixed(2)} USD, exceeding the ${tier} tier's cap of ${limit.maxNotionalUsd} USD`,
      };
    }

    return { ok: true };
  }

  /**
   * PHASE2_REMEDIATION (H6): atomic, cluster-wide version of check() above.
   *
   * check() (the pre-trade advisory read, still used by risk.engine.ts's
   * preTradeCheck() to reject obviously-over-cap orders early) reads
   * Position rows live but takes no lock -- this class's own doc comment
   * already flagged that as "a same-instant double-submit race here could
   * in theory admit one order slightly over cap." Confirmed real: two
   * near-simultaneous orders for the SAME client can both read the same
   * pre-order position count/notional, both compute a projected value
   * under the cap, and both commit.
   *
   * Same pattern as exposure.limits.ts's checkCanOpenAtomic(), just keyed
   * by userId instead of symbol: must be called inside the same DB
   * transaction that will create the position (execution.engine.ts), so
   * the check and the write it gates are atomic together. Acquires a
   * Postgres advisory lock scoped to `userId` (pg_advisory_xact_lock --
   * auto-released at transaction end), serializing concurrent opens for
   * the same client across every worker in the cluster.
   */
  async checkAtomic(
    tx:               Db,
    userId:           string,
    tier:             string,
    incomingNotional: number,
  ): Promise<ClientExposureCheckResult> {
    if (!IS_PERSISTENT) return { ok: true };

    const limit = CLIENT_EXPOSURE_LIMITS[tier as AccountTier] ?? CLIENT_EXPOSURE_LIMITS.STANDARD;

    const rows = await tx.$queryRaw<Array<{ symbol: string; quantity: string; entryPrice: string }>>`
      WITH lock_acquired AS (SELECT pg_advisory_xact_lock(hashtext(${userId})))
      SELECT p.symbol, p.quantity, p."entryPrice"
      FROM "Position" p, lock_acquired
      WHERE p."userId" = ${userId} AND p.status = 'OPEN'
    `;

    if (rows.length + 1 > limit.maxOpenPositions) {
      return {
        ok:     false,
        reason: "CLIENT_EXPOSURE_LIMIT_EXCEEDED",
        detail: `Opening this position would exceed the ${tier} tier's limit of ${limit.maxOpenPositions} concurrent open positions`,
      };
    }

    const currentNotional = rows.reduce(
      (sum, p) => sum + liveNotional({ symbol: p.symbol, quantity: parseFloat(p.quantity), entryPrice: parseFloat(p.entryPrice) }),
      0,
    );
    const projectedNotional = currentNotional + incomingNotional;

    if (projectedNotional > limit.maxNotionalUsd) {
      return {
        ok:     false,
        reason: "CLIENT_EXPOSURE_LIMIT_EXCEEDED",
        detail: `Opening this position would bring total exposure to ${projectedNotional.toFixed(2)} USD, exceeding the ${tier} tier's cap of ${limit.maxNotionalUsd} USD`,
      };
    }

    return { ok: true };
  }
}

export const clientExposureLimits = new ClientExposureLimitsChecker();
