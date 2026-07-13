/**
 * RiskSnapshotService — computes DB-backed risk metrics for the dashboard Risk Center.
 *
 * Metrics:
 *   riskScore          — composite 0-100 score derived from margin, drawdown, concentration
 *   marginLevelPct     — (equity / marginUsed) × 100  [ESMA: stop-out at 50%]
 *   leverage           — effective leverage = notional exposure / equity
 *   marginUtilization  — (locked / balance) × 100
 *   concentrationRisk  — (largest position margin / equity) × 100
 *   varEstimate        — parametric 1-day 95% VaR in USD
 *   maxDrawdown        — peak-to-trough from TradingAnalyticsService
 *   stopOutDistance    — pct distance from ESMA 50% stop-out floor
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { tradingAnalyticsService } from "../analytics/trading.analytics.service.js";
import { quoteCache } from "../market-data/quote.cache.js";
import { pnlCalculator } from "../trading-service/pnl.calculator.js";

export type RiskSnapshot = {
  riskScore:          number;
  marginLevelPct:     number;
  leverage:           number;
  marginUtilization:  number;
  concentrationRisk:  number;
  varEstimate:        number;
  maxDrawdown:        number;
  stopOutDistance:    number;
};

function sandboxSnapshot(): RiskSnapshot {
  return {
    riskScore:         18,
    marginLevelPct:    842,
    leverage:          5.2,
    marginUtilization: 12.1,
    concentrationRisk: 8.4,
    varEstimate:       1240,
    maxDrawdown:       1.8,
    stopOutDistance:   94.1,
  };
}

export class RiskSnapshotService {

  async getSnapshot(userId: string): Promise<RiskSnapshot> {
    if (!IS_PERSISTENT) return sandboxSnapshot();

    // Parallel fetch: wallet account + open positions + trading stats
    const [wallet, positions, stats] = await Promise.all([
      prisma.walletAccount.findUnique({ where: { userId } }),
      prisma.position.findMany({
        where:  { userId, status: "OPEN" },
        select: { marginUsed: true, quantity: true, entryPrice: true, side: true, symbol: true },
      }),
      tradingAnalyticsService.getStats(userId).catch(() => null),
    ]);

    if (!wallet) return sandboxSnapshot();

    const balance  = Number(wallet.balance);
    const locked   = Number(wallet.locked);

    // FASE 4.2 (RISK_ENGINE_FREEZE.md Bug #2): wallet.equity is never written
    // anywhere in this codebase, so the `||` fallback below always ran --
    // and it summed the persisted Position.pnl column, which can go stale/
    // frozen (see margin.controller.ts's getMarginState for the full
    // mechanism). Live-recompute from current quotes instead, same as the
    // pre-trade margin gate, so the dashboard risk score a client/compliance
    // sees is never stale relative to what actually gates their orders.
    const unrealizedPnl = positions.reduce((sum, p) => {
      const quote = quoteCache.get(p.symbol);
      if (!quote) return sum;
      const { rawPnl } = pnlCalculator.unrealized(
        p.side as "BUY" | "SELL", Number(p.quantity), Number(p.entryPrice), quote.bid, quote.ask,
      );
      return sum + rawPnl;
    }, 0);
    const equity = balance + unrealizedPnl;

    const marginUsed = positions.reduce((s, p) => s + Number(p.marginUsed), 0);
    const totalNotional = positions.reduce((s, p) => s + Number(p.quantity) * Number(p.entryPrice), 0);

    // Margin level: ESMA defines stop-out at 50%
    const marginLevelPct = marginUsed > 0 ? (equity / marginUsed) * 100 : Infinity;

    // Leverage: notional / equity
    const leverage = equity > 0 ? totalNotional / equity : 0;

    // Margin utilisation: locked/balance
    const marginUtilization = balance > 0 ? (locked / balance) * 100 : 0;

    // Concentration risk: largest single position's margin / equity
    const largestMargin = positions.reduce(
      (max, p) => Math.max(max, Number(p.marginUsed)), 0
    );
    const concentrationRisk = equity > 0 ? (largestMargin / equity) * 100 : 0;

    // Parametric VaR (95%, 1-day): σ × 1.645 × equity
    // Use asset-class average daily vol as proxy (conservative)
    const avgDailyVol = 0.012; // 1.2% for a mixed portfolio
    const varEstimate = equity * avgDailyVol * 1.645;

    // Max drawdown from analytics service
    const maxDrawdown = stats?.maxDrawdown ?? 0;

    // Stop-out distance: how far we are from the 50% ESMA floor, as % of current level
    const stopOutDistance = Number.isFinite(marginLevelPct)
      ? Math.max(0, ((marginLevelPct - 50) / marginLevelPct) * 100)
      : 100;

    // Composite risk score (0-100): higher = riskier
    const marginScore  = Number.isFinite(marginLevelPct)
      ? Math.max(0, 100 - ((marginLevelPct - 50) / 10))
      : 0;
    const ddScore      = Math.min(100, maxDrawdown * 3);
    const concScore    = Math.min(100, concentrationRisk * 1.5);
    const utilScore    = marginUtilization;
    const riskScore    = Math.round(
      0.35 * marginScore + 0.25 * ddScore + 0.20 * concScore + 0.20 * utilScore
    );

    return {
      riskScore:          Math.min(100, Math.max(0, riskScore)),
      marginLevelPct:     Number.isFinite(marginLevelPct) ? Math.round(marginLevelPct * 10) / 10 : 9999,
      leverage:           Math.round(leverage * 100) / 100,
      marginUtilization:  Math.round(marginUtilization * 10) / 10,
      concentrationRisk:  Math.round(concentrationRisk * 10) / 10,
      varEstimate:        Math.round(varEstimate * 100) / 100,
      maxDrawdown:        stats?.maxDrawdown ?? 0,
      stopOutDistance:    Math.round(stopOutDistance * 10) / 10,
    };
  }
}

export const riskSnapshotService = new RiskSnapshotService();
