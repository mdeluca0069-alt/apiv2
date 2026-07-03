/**
 * PortfolioAnalyticsService — institutional-grade portfolio analytics.
 *
 * Computes from AccountDailySnapshot (for equity curve, volatility, Sortino)
 * and TradeAudit (for trade-level metrics).
 *
 * Metrics:
 *   equityCurve        — daily equity points for charting
 *   dailyReturns       — percentage daily returns
 *   annualizedReturn   — CAGR from first to last snapshot
 *   annualizedVol      — annualized standard deviation of daily returns
 *   sharpeRatio        — (annualReturn - rfr) / annualVol  [rfr = 5%]
 *   sortinoRatio       — uses downside deviation only
 *   calmarRatio        — annualReturn / maxDrawdown
 *   maxDrawdown        — peak-to-trough as %
 *   maxDrawdownUsd     — peak-to-trough in USD
 *   winRate            — % profitable days
 *   profitFactor       — sum(profits) / |sum(losses)|
 *   expectancy         — expected return per trade in USD
 *   avgWin / avgLoss   — average winning/losing day USD
 *   currentStreak      — consecutive winning/losing days
 *   monthlyBreakdown   — PnL per calendar month (last 12)
 *   annualBreakdown    — PnL per calendar year
 *   bestDay / worstDay — peak single-day USD P&L
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";

const RISK_FREE_RATE = 0.05; // 5% annualised (ECB/Fed-inspired)
const TRADING_DAYS   = 252;

export type EquityPoint = { date: string; equity: number; balance: number; dailyPnl: number };

export type MonthlyPnl = { month: string; pnl: number; trades: number };

export type AnnualPnl  = { year: string; pnl: number };

export type PortfolioAnalytics = {
  equityCurve:       EquityPoint[];
  annualizedReturn:  number;
  annualizedVol:     number;
  sharpeRatio:       number;
  sortinoRatio:      number;
  calmarRatio:       number;
  maxDrawdown:       number;
  maxDrawdownUsd:    number;
  winRate:           number;
  profitFactor:      number;
  expectancy:        number;
  avgWin:            number;
  avgLoss:           number;
  bestDay:           number;
  worstDay:          number;
  currentStreak:     number;
  streakType:        "winning" | "losing" | "none";
  monthlyBreakdown:  MonthlyPnl[];
  annualBreakdown:   AnnualPnl[];
  totalRealizedPnl:  number;
  totalFees:         number;
  dataPoints:        number;
  generatedAt:       string;
};

function emptyAnalytics(): PortfolioAnalytics {
  return {
    equityCurve: [], annualizedReturn: 0, annualizedVol: 0,
    sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0,
    maxDrawdown: 0, maxDrawdownUsd: 0,
    winRate: 0, profitFactor: 0, expectancy: 0,
    avgWin: 0, avgLoss: 0, bestDay: 0, worstDay: 0,
    currentStreak: 0, streakType: "none",
    monthlyBreakdown: [], annualBreakdown: [],
    totalRealizedPnl: 0, totalFees: 0, dataPoints: 0,
    generatedAt: new Date().toISOString(),
  };
}

function computeSortino(dailyReturns: number[], rfr: number): number {
  if (dailyReturns.length < 2) return 0;
  const dailyRfr = rfr / TRADING_DAYS;
  const excess   = dailyReturns.map((r) => r - dailyRfr);
  const mean     = excess.reduce((s, r) => s + r, 0) / excess.length;
  const downsideVar = excess.reduce((s, r) => s + Math.pow(Math.min(0, r), 2), 0) / excess.length;
  const downsideDev = Math.sqrt(downsideVar);
  return downsideDev === 0 ? 0 : (mean / downsideDev) * Math.sqrt(TRADING_DAYS);
}

function computeMaxDrawdown(equities: number[]): { pct: number; usd: number } {
  if (equities.length < 2) return { pct: 0, usd: 0 };
  let peak = equities[0]!;
  let maxPct = 0;
  let maxUsd = 0;
  for (const eq of equities) {
    if (eq > peak) peak = eq;
    const dd    = peak - eq;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (ddPct > maxPct) { maxPct = ddPct; maxUsd = dd; }
  }
  return { pct: Math.round(maxPct * 100) / 100, usd: Math.round(maxUsd * 100) / 100 };
}

export class PortfolioAnalyticsService {

  async getAnalytics(userId: string, days = 365): Promise<PortfolioAnalytics> {
    if (!IS_PERSISTENT) return emptyAnalytics();

    const since = new Date(Date.now() - days * 86_400_000);

    // Fetch daily snapshots ordered chronologically
    const snapshots = await prisma.accountDailySnapshot.findMany({
      where:   { userId, snapshotDate: { gte: since } },
      orderBy: { snapshotDate: "asc" },
      select: {
        snapshotDate:   true,
        equity:         true,
        balance:        true,
        realizedPnlDay: true,
        totalFeesDay:   true,
      },
    });

    if (snapshots.length < 2) return emptyAnalytics();

    const equityCurve: EquityPoint[] = snapshots.map((s) => ({
      date:     s.snapshotDate.toISOString().slice(0, 10),
      equity:   s.equity.toNumber(),
      balance:  s.balance.toNumber(),
      dailyPnl: s.realizedPnlDay.toNumber(),
    }));

    const equities = equityCurve.map((p) => p.equity);
    const dailyPnls = equityCurve.map((p) => p.dailyPnl);

    // Daily returns as fractions
    const dailyReturns: number[] = [];
    for (let i = 1; i < equities.length; i++) {
      const prev = equities[i - 1]!;
      dailyReturns.push(prev > 0 ? (equities[i]! - prev) / prev : 0);
    }

    // Annualised return (CAGR)
    const firstEq = equities[0]!;
    const lastEq  = equities[equities.length - 1]!;
    const yearsHeld = snapshots.length / TRADING_DAYS;
    const annualizedReturn = firstEq > 0 && yearsHeld > 0
      ? (Math.pow(lastEq / firstEq, 1 / yearsHeld) - 1) * 100 : 0;

    // Annualised volatility
    const meanReturn = dailyReturns.reduce((s, r) => s + r, 0) / (dailyReturns.length || 1);
    const variance   = dailyReturns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / (dailyReturns.length || 1);
    const annualizedVol = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS) * 100;

    // Sharpe
    const dailyRfr    = RISK_FREE_RATE / TRADING_DAYS;
    const sharpeDaily = dailyReturns.length > 0
      ? (meanReturn - dailyRfr) / (Math.sqrt(variance) || 1) : 0;
    const sharpeRatio = Math.round(sharpeDaily * Math.sqrt(TRADING_DAYS) * 1000) / 1000;

    // Sortino
    const sortinoRatio = Math.round(computeSortino(dailyReturns, RISK_FREE_RATE) * 1000) / 1000;

    // Max drawdown
    const { pct: maxDrawdown, usd: maxDrawdownUsd } = computeMaxDrawdown(equities);

    // Calmar
    const calmarRatio = maxDrawdown > 0 ? Math.round((annualizedReturn / maxDrawdown) * 1000) / 1000 : 0;

    // Win/loss day stats
    const winDays  = dailyPnls.filter((p) => p > 0);
    const lossDays = dailyPnls.filter((p) => p < 0);
    const winRate  = dailyPnls.length > 0 ? Math.round((winDays.length / dailyPnls.length) * 1000) / 10 : 0;
    const sumWins  = winDays.reduce((s, v) => s + v, 0);
    const sumLoss  = Math.abs(lossDays.reduce((s, v) => s + v, 0));
    const profitFactor = sumLoss > 0 ? Math.round((sumWins / sumLoss) * 1000) / 1000 : sumWins > 0 ? 999 : 0;
    const avgWin   = winDays.length  > 0 ? Math.round((sumWins / winDays.length) * 100) / 100 : 0;
    const avgLoss  = lossDays.length > 0 ? Math.round((sumLoss / lossDays.length) * 100) / 100 : 0;
    const expectancy = Math.round(
      ((winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss) * 100
    ) / 100;
    const bestDay  = Math.max(...dailyPnls, 0);
    const worstDay = Math.min(...dailyPnls, 0);

    // Current streak
    let streak = 0;
    let streakType: PortfolioAnalytics["streakType"] = "none";
    for (let i = dailyPnls.length - 1; i >= 0; i--) {
      const p = dailyPnls[i]!;
      if (streak === 0) {
        if (p > 0)      { streak = 1; streakType = "winning"; }
        else if (p < 0) { streak = 1; streakType = "losing";  }
        else break;
      } else if (streakType === "winning" && p > 0) {
        streak++;
      } else if (streakType === "losing" && p < 0) {
        streak++;
      } else {
        break;
      }
    }

    // Monthly breakdown (last 12 months)
    const monthMap = new Map<string, number>();
    for (const s of snapshots) {
      const key = s.snapshotDate.toISOString().slice(0, 7); // "YYYY-MM"
      monthMap.set(key, (monthMap.get(key) ?? 0) + s.realizedPnlDay.toNumber());
    }
    const monthlyBreakdown: MonthlyPnl[] = Array.from(monthMap.entries())
      .map(([month, pnl]) => ({ month, pnl: Math.round(pnl * 100) / 100, trades: 0 }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12);

    // Annual breakdown
    const yearMap = new Map<string, number>();
    for (const s of snapshots) {
      const year = s.snapshotDate.toISOString().slice(0, 4);
      yearMap.set(year, (yearMap.get(year) ?? 0) + s.realizedPnlDay.toNumber());
    }
    const annualBreakdown: AnnualPnl[] = Array.from(yearMap.entries())
      .map(([year, pnl]) => ({ year, pnl: Math.round(pnl * 100) / 100 }))
      .sort((a, b) => a.year.localeCompare(b.year));

    const totalRealizedPnl = Math.round(dailyPnls.reduce((s, v) => s + v, 0) * 100) / 100;
    const totalFees = Math.round(snapshots.reduce((s, snap) => s + snap.totalFeesDay.toNumber(), 0) * 100) / 100;

    return {
      equityCurve,
      annualizedReturn: Math.round(annualizedReturn * 100) / 100,
      annualizedVol:    Math.round(annualizedVol * 100) / 100,
      sharpeRatio,
      sortinoRatio,
      calmarRatio,
      maxDrawdown,
      maxDrawdownUsd,
      winRate,
      profitFactor,
      expectancy,
      avgWin,
      avgLoss,
      bestDay:          Math.round(bestDay  * 100) / 100,
      worstDay:         Math.round(worstDay * 100) / 100,
      currentStreak:    streak,
      streakType,
      monthlyBreakdown,
      annualBreakdown,
      totalRealizedPnl,
      totalFees,
      dataPoints:       snapshots.length,
      generatedAt:      new Date().toISOString(),
    };
  }
}

export const portfolioAnalyticsService = new PortfolioAnalyticsService();
