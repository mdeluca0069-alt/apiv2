/**
 * CorrelationGuard — blocks a manual/API order that would compound
 * correlated directional exposure beyond a safe threshold.
 *
 * RISK_ENGINE_FREEZE.md §3.3: correlationMatrix.correlationWithOpenPositions()
 * was real (Pearson on historical closed-trade prices) but only ever
 * consulted by the autopilot pipeline (soft 50% size halving above |r|=0.75,
 * autopilot.pipeline.ts step 7b) -- manual and API orders, the majority of
 * trading volume, had zero correlation awareness.
 *
 * Unlike autopilot, a manual/API order's quantity is a client-specified
 * contract (the client asked for exactly N units) -- silently halving it the
 * way autopilot does would violate that contract. This is a hard reject
 * instead, using the same "compounding" semantics autopilot already
 * established: a pair only blocks when it would genuinely compound net
 * directional exposure (positive correlation + same direction as an open
 * position, or negative correlation + opposite direction) -- a natural hedge
 * never triggers this.
 *
 * Advisory-safe: like autopilot, any correlation-lookup failure or
 * insufficient historical data fails OPEN (never blocks a trade on a data
 * problem) -- this is a risk-quality improvement, not a new hard capital
 * safety invariant, so availability of the correlation subsystem must never
 * become a trading outage.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { correlationMatrix }     from "./correlation.matrix.js";

const COMPOUNDING_CORRELATION_THRESHOLD = 0.75;

export type CorrelationCheckResult =
  | { ok: true }
  | { ok: false; reason: "CORRELATION_RISK_LIMIT_EXCEEDED"; detail: string };

class CorrelationGuard {
  async check(userId: string, symbol: string, side: "BUY" | "SELL"): Promise<CorrelationCheckResult> {
    if (!IS_PERSISTENT) return { ok: true };

    try {
      const corrPairs = await correlationMatrix.correlationWithOpenPositions(userId, symbol);
      if (corrPairs.length === 0) return { ok: true };

      const openPositions = await prisma!.position.findMany({
        where:  { userId, status: "OPEN", symbol: { in: corrPairs.map((p) => p.symbolB) } },
        select: { symbol: true, side: true },
      });
      const sideBySymbol = new Map(openPositions.map((p) => [p.symbol, p.side]));

      const compounding = corrPairs.find((p) => {
        const otherSide = sideBySymbol.get(p.symbolB);
        if (!otherSide) return false;
        const sameDirection = otherSide === side;
        return (p.correlation > COMPOUNDING_CORRELATION_THRESHOLD && sameDirection)
            || (p.correlation < -COMPOUNDING_CORRELATION_THRESHOLD && !sameDirection);
      });

      if (!compounding) return { ok: true };

      return {
        ok:     false,
        reason: "CORRELATION_RISK_LIMIT_EXCEEDED",
        detail: `${symbol} is ${(compounding.correlation * 100).toFixed(0)}% correlated with your open ${compounding.symbolB} position in a way that compounds net directional exposure`,
      };
    } catch {
      // advisory-only: never block a trade on a correlation-subsystem failure
      return { ok: true };
    }
  }
}

export const correlationGuard = new CorrelationGuard();
