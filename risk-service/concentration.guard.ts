/**
 * ConcentrationGuard — blocks an order that would push a client's own
 * portfolio concentration (HHI) beyond a safe threshold.
 *
 * RISK_ENGINE_FREEZE.md §3.5: analytics/exposure.analytics.ts already
 * computes a correct Herfindahl-Hirschman Index per client
 * (ExposureAnalytics.concentrationRisk, 0-100 scale: sum of squared
 * per-symbol notional weights x100), but it was exposed for display only
 * (client dashboard) -- zero order was ever gated on it. This mirrors the
 * same formula against the *projected* portfolio (current open positions
 * plus the order being evaluated) and rejects before the position opens,
 * rather than only ever reporting concentration after the fact.
 *
 * Exempts a client's first two positions: HHI is trivially 100 with a
 * single position (weight = 1.0), so gating from position #1 would block
 * every client's very first trade. Enforcement only begins once a client
 * would hold 3+ concurrent positions -- this is about continuing to stack
 * into too few symbols despite having the portfolio size to diversify, not
 * about blocking someone from opening their first position(s).
 *
 * MAX_CONCENTRATION_HHI_PCT = 40 sits between the equal-3-position
 * benchmark (33.3) and the equal-2-position benchmark (50) on this scale --
 * a client whose book is more concentrated than roughly "2.5 equal-weighted
 * positions" is blocked from concentrating further.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { liveNotional } from "../market-data/position.valuation.js";

const MIN_POSITIONS_BEFORE_ENFORCEMENT = 3;
const MAX_CONCENTRATION_HHI_PCT        = 40; // same 0-100 scale as exposure.analytics.ts's concentrationRisk

export type ConcentrationCheckResult =
  | { ok: true }
  | { ok: false; reason: "CONCENTRATION_LIMIT_EXCEEDED"; detail: string };

class ConcentrationGuard {
  async check(userId: string, symbol: string, incomingNotional: number): Promise<ConcentrationCheckResult> {
    if (!IS_PERSISTENT) return { ok: true };

    const positions = await prisma!.position.findMany({
      where:  { userId, status: "OPEN" },
      select: { symbol: true, quantity: true, entryPrice: true },
    });

    if (positions.length + 1 < MIN_POSITIONS_BEFORE_ENFORCEMENT) return { ok: true };

    // MARKET_DATA_FREEZE.md §0.3: live quoteCache valuation, not the
    // Position.markPrice DB column -- see market-data/position.valuation.ts.
    const bySymbol = new Map<string, number>();
    for (const p of positions) {
      const notional = liveNotional({ symbol: p.symbol, quantity: p.quantity.toNumber(), entryPrice: p.entryPrice.toNumber() });
      bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + notional);
    }
    bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + incomingNotional);

    const grossTotal = [...bySymbol.values()].reduce((sum, n) => sum + n, 0);
    if (grossTotal <= 0) return { ok: true };

    const hhi = [...bySymbol.values()].reduce((sum, n) => sum + (n / grossTotal) ** 2, 0);
    const concentrationPct = Math.round(hhi * 10000) / 100;

    if (concentrationPct > MAX_CONCENTRATION_HHI_PCT) {
      return {
        ok:     false,
        reason: "CONCENTRATION_LIMIT_EXCEEDED",
        detail: `Opening this position would bring portfolio concentration (HHI) to ${concentrationPct.toFixed(1)}, exceeding the ${MAX_CONCENTRATION_HHI_PCT} limit`,
      };
    }
    return { ok: true };
  }
}

export const concentrationGuard = new ConcentrationGuard();
