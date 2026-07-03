/**
 * TradingAnalyticsService — computes real performance metrics from TradeAudit.
 *
 * Metrics:
 *   • dailyPnl / weeklyPnl / monthlyPnl  — net realized P&L by period
 *   • totalPnl                            — all-time realized P&L
 *   • winRate                             — % of closed trades with pnl > 0
 *   • avgWin / avgLoss                    — average profit/loss per winning/losing trade
 *   • profitFactor                        — |totalWins| / |totalLosses|
 *   • expectancy                          — winRate×avgWin − lossRate×avgLoss
 *   • maxDrawdown                         — largest peak-to-trough equity decline
 *   • sharpeRatio                         — daily returns Sharpe (252-annualised)
 *   • avgTradeDurationMs                  — mean hold time in milliseconds
 *   • totalTrades                         — total closed trades
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";

export type TradingStats = {
  dailyPnl:            number;
  weeklyPnl:           number;
  monthlyPnl:          number;
  totalPnl:            number;
  winRate:             number;
  avgWin:              number;
  avgLoss:             number;
  profitFactor:        number;
  expectancy:          number;
  maxDrawdown:         number;
  sharpeRatio:         number;
  avgTradeDurationMs:  number;
  totalTrades:         number;
  bestTrade:           number;
  worstTrade:          number;
  totalFees:           number;
};

function emptyStats(): TradingStats {
  return {
    dailyPnl: 0, weeklyPnl: 0, monthlyPnl: 0, totalPnl: 0,
    winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0,
    expectancy: 0, maxDrawdown: 0, sharpeRatio: 0,
    avgTradeDurationMs: 0, totalTrades: 0, bestTrade: 0, worstTrade: 0, totalFees: 0,
  };
}

function computeMaxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length < 2) return 0;
  let peak      = equityCurve[0]!;
  let maxDD     = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD * 100; // as percentage
}

function computeSharpe(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  return (mean / stdDev) * Math.sqrt(252); // annualised
}

export class TradingAnalyticsService {

  async getStats(userId: string): Promise<TradingStats> {
    if (!IS_PERSISTENT) return emptyStats();

    const now     = new Date();
    const dayAgo  = new Date(now.getTime() - 86_400_000);
    const weekAgo = new Date(now.getTime() - 7  * 86_400_000);
    const monAgo  = new Date(now.getFullYear(), now.getMonth(), 1);

    // Fetch all CLOSED trade audits for this user
    const audits = await prisma.tradeAudit.findMany({
      where: {
        userId,
        tradeStatus: { in: ["CLOSED", "PARTIAL"] },
        closedAt:    { not: null },
      },
      orderBy: { closedAt: "asc" },
      select: {
        pnlRealized: true,
        fees:        true,
        createdAt:   true,
        closedAt:    true,
      },
    });

    if (audits.length === 0) {
      // If no TradeAudit rows, try LedgerEntry PnL entries as fallback
      return this._statsFromLedger(userId, now, dayAgo, weekAgo, monAgo);
    }

    return this._statsFromAudits(audits, now, dayAgo, weekAgo, monAgo);
  }

  private _statsFromAudits(
    audits: { pnlRealized: unknown; fees: unknown; createdAt: Date; closedAt: Date | null }[],
    _now:    Date,
    dayAgo:  Date,
    weekAgo: Date,
    monAgo:  Date,
  ): TradingStats {
    let totalPnl  = 0, dailyPnl = 0, weeklyPnl = 0, monthlyPnl = 0;
    let totalWins = 0, totalLosses = 0;
    let sumWin    = 0, sumLoss  = 0;
    let best = -Infinity, worst = Infinity;
    let totalFees = 0;
    let totalDurationMs = 0;

    const equityCurve: number[] = [];
    let   runningEquity = 0;
    const dailyReturnMap = new Map<string, number>();

    for (const a of audits) {
      const pnl  = Number(a.pnlRealized ?? 0);
      const fee  = Number(a.fees ?? 0);
      const net  = pnl - fee;
      const closed = a.closedAt!;

      totalPnl  += net;
      totalFees += fee;

      if (a.createdAt && closed) {
        totalDurationMs += closed.getTime() - a.createdAt.getTime();
      }

      if (net > 0) { totalWins++;   sumWin  += net; }
      else         { totalLosses++; sumLoss += Math.abs(net); }

      if (net > best)  best  = net;
      if (net < worst) worst = net;

      if (closed >= dayAgo)  dailyPnl   += net;
      if (closed >= weekAgo) weeklyPnl  += net;
      if (closed >= monAgo)  monthlyPnl += net;

      // equity curve for drawdown
      runningEquity += net;
      equityCurve.push(runningEquity);

      // daily return bucket
      const dayKey = closed.toISOString().slice(0, 10);
      dailyReturnMap.set(dayKey, (dailyReturnMap.get(dayKey) ?? 0) + net);
    }

    const totalTrades  = audits.length;
    const winRate      = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
    const avgWin       = totalWins   > 0 ? sumWin  / totalWins   : 0;
    const avgLoss      = totalLosses > 0 ? sumLoss / totalLosses : 0;
    const profitFactor = avgLoss > 0     ? sumWin  / sumLoss     : sumWin > 0 ? 999 : 0;
    const lossRate     = 100 - winRate;
    const expectancy   = (winRate / 100) * avgWin - (lossRate / 100) * avgLoss;
    const maxDrawdown  = computeMaxDrawdown(equityCurve);
    const dailyReturns = Array.from(dailyReturnMap.values());
    const sharpeRatio  = computeSharpe(dailyReturns);
    const avgTradeDurationMs = totalTrades > 0 ? totalDurationMs / totalTrades : 0;

    return {
      dailyPnl, weeklyPnl, monthlyPnl, totalPnl,
      winRate:   Math.round(winRate * 100) / 100,
      avgWin,   avgLoss,   profitFactor,
      expectancy,
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      sharpeRatio: Math.round(sharpeRatio * 1000) / 1000,
      avgTradeDurationMs,
      totalTrades,
      bestTrade:  best  === -Infinity ? 0 : best,
      worstTrade: worst ===  Infinity ? 0 : worst,
      totalFees,
    };
  }

  private async _statsFromLedger(
    userId: string,
    _now: Date, dayAgo: Date, weekAgo: Date, monAgo: Date,
  ): Promise<TradingStats> {
    const entries = await prisma.ledgerEntry.findMany({
      where:   { userId, type: { in: ["PNL_CREDIT", "PNL_DEBIT", "PNL_SETTLEMENT"] }, status: "COMPLETED" },
      orderBy: { createdAt: "asc" },
      select:  { amount: true, createdAt: true },
    });

    if (entries.length === 0) return emptyStats();

    let totalPnl = 0, dailyPnl = 0, weeklyPnl = 0, monthlyPnl = 0;
    let wins = 0, losses = 0, sumW = 0, sumL = 0;
    let best = -Infinity, worst = Infinity;
    const curve: number[] = [];
    let running = 0;
    const dayMap = new Map<string, number>();

    for (const e of entries) {
      const pnl = Number(e.amount);
      totalPnl += pnl;
      if (e.createdAt >= dayAgo)  dailyPnl   += pnl;
      if (e.createdAt >= weekAgo) weeklyPnl  += pnl;
      if (e.createdAt >= monAgo)  monthlyPnl += pnl;
      if (pnl > 0) { wins++;   sumW += pnl; }
      else         { losses++; sumL += Math.abs(pnl); }
      if (pnl > best)  best  = pnl;
      if (pnl < worst) worst = pnl;
      running += pnl;
      curve.push(running);
      const dk = e.createdAt.toISOString().slice(0, 10);
      dayMap.set(dk, (dayMap.get(dk) ?? 0) + pnl);
    }

    const total = entries.length;
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    const avgWin  = wins   > 0 ? sumW / wins   : 0;
    const avgLoss = losses > 0 ? sumL / losses  : 0;

    return {
      dailyPnl, weeklyPnl, monthlyPnl, totalPnl,
      winRate:   Math.round(winRate * 100) / 100,
      avgWin, avgLoss,
      profitFactor:    avgLoss > 0 ? sumW / sumL : sumW > 0 ? 999 : 0,
      expectancy:      (winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss,
      maxDrawdown:     Math.round(computeMaxDrawdown(curve) * 100) / 100,
      sharpeRatio:     Math.round(computeSharpe(Array.from(dayMap.values())) * 1000) / 1000,
      avgTradeDurationMs: 0,
      totalTrades:     total,
      bestTrade:       best  === -Infinity ? 0 : best,
      worstTrade:      worst ===  Infinity ? 0 : worst,
      totalFees:       0,
    };
  }
}

export const tradingAnalyticsService = new TradingAnalyticsService();
