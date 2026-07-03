/**
 * TradingAnalyticsCenter — MyFxBook-grade analytics engine.
 *
 * Computes every metric from raw TradeAudit rows; no stubs, no Math.random.
 *
 * Output structure mirrors the frontend TradingAnalyticsPage expectations.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── Output types ─────────────────────────────────────────────────────────────

export type AnalyticsTrade = {
  id:         string;
  symbol:     string;
  side:       string;
  pnl:        number;
  fees:       number;
  durationMs: number;
  openedAt:   string;
  closedAt:   string;
  entryPrice: number;
  exitPrice:  number;
};

export type EquityPoint = {
  date:      string;   // "YYYY-MM-DD"
  dailyPnl:  number;   // net PnL on that day
  cumPnl:    number;   // cumulative PnL from first trade
  drawdown:  number;   // drawdown % from peak (negative or zero)
};

export type SymbolStat = {
  symbol:       string;
  trades:       number;
  wins:         number;
  losses:       number;
  pnl:          number;
  winRate:      number;
  profitFactor: number;
  avgPnl:       number;
  avgWin:       number;
  avgLoss:      number;
};

export type HourStat = {
  hour:     number;    // 0–23 UTC
  trades:   number;
  pnl:      number;
  wins:     number;
  winRate:  number;
};

export type DowStat = {
  dow:      number;    // 0=Mon … 4=Fri
  day:      string;
  trades:   number;
  pnl:      number;
  winRate:  number;
};

export type MonthStat = {
  month:    string;    // "2026-01"
  label:    string;    // "Jan '26"
  pnl:      number;
  trades:   number;
  winRate:  number;
};

export type StreakStats = {
  maxWinStreak:      number;
  maxLossStreak:     number;
  currentStreak:     number;
  currentStreakType: "WIN" | "LOSS" | "NONE";
};

export type PnlBucket = {
  label:      string;
  count:      number;
  pnl:        number;
  isPositive: boolean;
};

export type AnalyticsSummary = {
  totalTrades:        number;
  winRate:            number;
  lossRate:           number;
  profitFactor:       number;
  expectancy:         number;
  totalPnl:           number;
  totalFees:          number;
  maxDrawdown:        number;     // %
  maxDrawdownUsd:     number;
  sharpeRatio:        number;
  sortinoRatio:       number;
  calmarRatio:        number;
  avgWin:             number;
  avgLoss:            number;
  bestTrade:          number;
  worstTrade:         number;
  avgHoldTimeMs:      number;
  avgHoldTimeWinMs:   number;
  avgHoldTimeLossMs:  number;
  dailyPnl:           number;
  weeklyPnl:          number;
  monthlyPnl:         number;
  annualizedReturn:   number;
  annualizedVol:      number;
  recoveryFactor:     number;    // totalPnl / maxDrawdownUsd
  cagr:               number;    // compound annual growth rate (%)
};

export type TradingAnalyticsReport = {
  period:          { days: number; from: string; to: string };
  summary:         AnalyticsSummary;
  equityCurve:     EquityPoint[];
  trades:          AnalyticsTrade[];
  symbolBreakdown: SymbolStat[];
  hourlyBreakdown: HourStat[];
  dowBreakdown:    DowStat[];
  monthlyBreakdown: MonthStat[];
  streaks:         StreakStats;
  pnlDistribution: PnlBucket[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────


function computeSharpe(dailyPnls: number[]): number {
  if (dailyPnls.length < 2) return 0;
  const mean = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
  const variance = dailyPnls.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyPnls.length - 1);
  const std = Math.sqrt(variance);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(252);
}

function computeSortino(dailyPnls: number[]): number {
  if (dailyPnls.length < 2) return 0;
  const mean          = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
  const negativeReturns = dailyPnls.filter((r) => r < 0);
  if (negativeReturns.length === 0) return mean > 0 ? 999 : 0;
  const downsideVar   = negativeReturns.reduce((s, r) => s + r ** 2, 0) / dailyPnls.length;
  const downsideStd   = Math.sqrt(downsideVar);
  return downsideStd === 0 ? 0 : (mean / downsideStd) * Math.sqrt(252);
}

function computeStreaks(pnls: number[]): StreakStats {
  let maxWin = 0, maxLoss = 0, cur = 0;
  let curType: "WIN" | "LOSS" | "NONE" = "NONE";

  for (const pnl of pnls) {
    const isWin = pnl > 0;
    if (pnl === 0) continue;

    if (curType === "NONE") {
      cur     = 1;
      curType = isWin ? "WIN" : "LOSS";
    } else if ((isWin && curType === "WIN") || (!isWin && curType === "LOSS")) {
      cur++;
    } else {
      if (curType === "WIN")  maxWin  = Math.max(maxWin,  cur);
      if (curType === "LOSS") maxLoss = Math.max(maxLoss, cur);
      cur     = 1;
      curType = isWin ? "WIN" : "LOSS";
    }
  }
  if (curType === "WIN")  maxWin  = Math.max(maxWin,  cur);
  if (curType === "LOSS") maxLoss = Math.max(maxLoss, cur);

  return {
    maxWinStreak:      maxWin,
    maxLossStreak:     maxLoss,
    currentStreak:     cur,
    currentStreakType: curType,
  };
}

function buildPnlHistogram(pnls: number[]): PnlBucket[] {
  if (pnls.length === 0) return [];
  const min    = Math.min(...pnls);
  const max    = Math.max(...pnls);
  const range  = max - min;
  if (range === 0) return [{ label: `$${min.toFixed(0)}`, count: pnls.length, pnl: min, isPositive: min >= 0 }];

  const BUCKETS = 12;
  const step    = range / BUCKETS;
  const buckets: PnlBucket[] = Array.from({ length: BUCKETS }, (_, i) => {
    const lo  = min + i * step;
    const hi  = min + (i + 1) * step;
    const mid = (lo + hi) / 2;
    return {
      label:      `$${lo >= 0 ? "+" : ""}${lo.toFixed(0)}`,
      count:      0,
      pnl:        mid,
      isPositive: mid >= 0,
    };
  });

  for (const pnl of pnls) {
    const idx = Math.min(Math.floor((pnl - min) / step), BUCKETS - 1);
    buckets[idx]!.count++;
  }
  return buckets;
}

function monthLabel(ym: string): string {
  const [year, mon] = ym.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(mon) - 1]} '${String(year).slice(2)}`;
}

function emptyReport(from: Date, to: Date): TradingAnalyticsReport {
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  return {
    period:          { days, from: from.toISOString(), to: to.toISOString() },
    summary:         {
      totalTrades: 0, winRate: 0, lossRate: 0, profitFactor: 0, expectancy: 0,
      totalPnl: 0, totalFees: 0, maxDrawdown: 0, maxDrawdownUsd: 0,
      sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0,
      avgWin: 0, avgLoss: 0, bestTrade: 0, worstTrade: 0,
      avgHoldTimeMs: 0, avgHoldTimeWinMs: 0, avgHoldTimeLossMs: 0,
      dailyPnl: 0, weeklyPnl: 0, monthlyPnl: 0,
      annualizedReturn: 0, annualizedVol: 0, recoveryFactor: 0, cagr: 0,
    },
    equityCurve:      [],
    trades:           [],
    symbolBreakdown:  [],
    hourlyBreakdown:  Array.from({ length: 24 }, (_, h) => ({ hour: h, trades: 0, pnl: 0, wins: 0, winRate: 0 })),
    dowBreakdown:     ["Mon","Tue","Wed","Thu","Fri"].map((day, dow) => ({ dow, day, trades: 0, pnl: 0, winRate: 0 })),
    monthlyBreakdown: [],
    streaks:          { maxWinStreak: 0, maxLossStreak: 0, currentStreak: 0, currentStreakType: "NONE" },
    pnlDistribution:  [],
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class TradingAnalyticsCenter {

  async getReport(userId: string, from: Date, to: Date): Promise<TradingAnalyticsReport> {
    if (!IS_PERSISTENT) return emptyReport(from, to);

    const days = Math.max(Math.round((to.getTime() - from.getTime()) / 86_400_000), 1);

    const [audits, startSnapshot] = await Promise.all([
      prisma.tradeAudit.findMany({
        where: {
          userId,
          tradeStatus: { in: ["CLOSED", "PARTIAL"] },
          closedAt:    { not: null, gte: from, lte: to },
        },
        orderBy: { closedAt: "asc" },
        select: {
          id:          true,
          symbol:      true,
          side:        true,
          pnlRealized: true,
          fees:        true,
          entryPrice:  true,
          exitPrice:   true,
          createdAt:   true,
          closedAt:    true,
        },
      }),
      // Nearest balance snapshot at or before the start of the window (for CAGR)
      prisma.accountDailySnapshot.findFirst({
        where:   { userId, snapshotDate: { lte: from } },
        orderBy: { snapshotDate: "desc" },
        select:  { balance: true },
      }).catch(() => null),
    ]);

    if (audits.length === 0) return emptyReport(from, to);

    // ── Normalize trades ──────────────────────────────────────────────────────
    type Trade = {
      id: string; symbol: string; side: string;
      pnl: number; fees: number; durationMs: number;
      openedAt: Date; closedAt: Date;
      entryPrice: number; exitPrice: number;
    };

    const trades: Trade[] = audits.map((a) => ({
      id:         a.id,
      symbol:     a.symbol,
      side:       a.side,
      pnl:        Number(a.pnlRealized ?? 0) - Number(a.fees ?? 0),
      fees:       Number(a.fees ?? 0),
      durationMs: a.closedAt ? a.closedAt.getTime() - a.createdAt.getTime() : 0,
      openedAt:   a.createdAt,
      closedAt:   a.closedAt!,
      entryPrice: Number(a.entryPrice ?? 0),
      exitPrice:  Number(a.exitPrice  ?? 0),
    }));

    const dayAgo  = new Date(to.getTime() -  1 * 86_400_000);
    const weekAgo = new Date(to.getTime() -  7 * 86_400_000);
    const monAgo  = new Date(to.getFullYear(), to.getMonth(), 1);

    // ── Summary aggregation ───────────────────────────────────────────────────
    let totalPnl = 0, totalFees = 0;
    let wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
    let best = -Infinity, worst = Infinity;
    let totalDurMs = 0, winDurMs = 0, lossDurMs = 0;
    let dailyPnl = 0, weeklyPnl = 0, monthlyPnl = 0;

    for (const t of trades) {
      totalPnl  += t.pnl;
      totalFees += t.fees;

      if (t.pnl > 0) { wins++;   sumWin  += t.pnl; winDurMs  += t.durationMs; }
      else            { losses++; sumLoss += Math.abs(t.pnl); lossDurMs += t.durationMs; }

      if (t.pnl > best)  best  = t.pnl;
      if (t.pnl < worst) worst = t.pnl;

      totalDurMs += t.durationMs;

      if (t.closedAt >= dayAgo)  dailyPnl   += t.pnl;
      if (t.closedAt >= weekAgo) weeklyPnl  += t.pnl;
      if (t.closedAt >= monAgo)  monthlyPnl += t.pnl;
    }

    const totalTrades  = trades.length;
    const winRate      = (wins  / totalTrades) * 100;
    const lossRate     = (losses / totalTrades) * 100;
    const avgWin       = wins   > 0 ? sumWin  / wins   : 0;
    const avgLoss      = losses > 0 ? sumLoss / losses : 0;
    const profitFactor = sumLoss > 0 ? sumWin / sumLoss : sumWin > 0 ? 999 : 0;
    const expectancy   = (winRate / 100) * avgWin - (lossRate / 100) * avgLoss;
    const avgHoldTimeMs      = totalDurMs / totalTrades;
    const avgHoldTimeWinMs   = wins   > 0 ? winDurMs  / wins   : 0;
    const avgHoldTimeLossMs  = losses > 0 ? lossDurMs / losses : 0;

    // ── Daily buckets for equity curve + Sharpe ───────────────────────────────
    const dayBucket = new Map<string, number>();
    for (const t of trades) {
      const dk = t.closedAt.toISOString().slice(0, 10);
      dayBucket.set(dk, (dayBucket.get(dk) ?? 0) + t.pnl);
    }
    const sortedDays = [...dayBucket.keys()].sort();
    const dailyPnls  = sortedDays.map((d) => dayBucket.get(d)!);

    // Fill in missing days with 0 so the curve is continuous
    const allDays: string[] = [];
    if (sortedDays.length > 0) {
      const startDate = new Date(sortedDays[0]!);
      const endDate   = new Date(sortedDays[sortedDays.length - 1]!);
      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        allDays.push(d.toISOString().slice(0, 10));
      }
    }

    let cumPnl = 0;
    let peak   = 0;
    let maxDDPct = 0;
    let maxDDUsd = 0;
    const equityCurve: EquityPoint[] = allDays.map((date) => {
      const dp = dayBucket.get(date) ?? 0;
      cumPnl += dp;
      if (cumPnl > peak) peak = cumPnl;
      const dd    = peak - cumPnl;
      const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
      if (ddPct > maxDDPct) { maxDDPct = ddPct; maxDDUsd = dd; }
      return { date, dailyPnl: dp, cumPnl, drawdown: -ddPct };
    });

    const sharpeRatio  = computeSharpe(dailyPnls);
    const sortinoRatio = computeSortino(dailyPnls);

    const annualizedReturn = (totalPnl / days) * 252;
    const dailyStd         = dailyPnls.length > 1
      ? Math.sqrt(dailyPnls.reduce((s, r) => s + (r - totalPnl / dailyPnls.length) ** 2, 0) / (dailyPnls.length - 1))
      : 0;
    const annualizedVol    = dailyStd * Math.sqrt(252);
    const calmarRatio      = maxDDPct > 0 ? (annualizedReturn / maxDDUsd) : 0;
    const recoveryFactor   = maxDDUsd > 0 ? totalPnl / maxDDUsd : 0;

    // CAGR — compound annual growth rate using the nearest preceding balance snapshot
    const startBalance = startSnapshot ? Number(startSnapshot.balance) : null;
    const cagr = startBalance && startBalance > 0
      ? (Math.pow((startBalance + totalPnl) / startBalance, 365.25 / days) - 1) * 100
      : 0;

    // ── Symbol breakdown ──────────────────────────────────────────────────────
    const symMap = new Map<string, { wins: number; losses: number; pnl: number; sumW: number; sumL: number }>();
    for (const t of trades) {
      let s = symMap.get(t.symbol);
      if (!s) { s = { wins: 0, losses: 0, pnl: 0, sumW: 0, sumL: 0 }; symMap.set(t.symbol, s); }
      s.pnl += t.pnl;
      if (t.pnl > 0) { s.wins++; s.sumW += t.pnl; }
      else            { s.losses++; s.sumL += Math.abs(t.pnl); }
    }
    const symbolBreakdown: SymbolStat[] = [...symMap.entries()]
      .map(([symbol, s]) => {
        const tot = s.wins + s.losses;
        return {
          symbol,
          trades:       tot,
          wins:         s.wins,
          losses:       s.losses,
          pnl:          s.pnl,
          winRate:      tot > 0 ? (s.wins / tot) * 100 : 0,
          profitFactor: s.sumL > 0 ? s.sumW / s.sumL : s.sumW > 0 ? 999 : 0,
          avgPnl:       tot > 0 ? s.pnl / tot : 0,
          avgWin:       s.wins > 0 ? s.sumW / s.wins : 0,
          avgLoss:      s.losses > 0 ? s.sumL / s.losses : 0,
        };
      })
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

    // ── Hourly breakdown ──────────────────────────────────────────────────────
    const hourMap = new Map<number, { trades: number; pnl: number; wins: number }>();
    for (const t of trades) {
      const h = t.closedAt.getUTCHours();
      let hb = hourMap.get(h);
      if (!hb) { hb = { trades: 0, pnl: 0, wins: 0 }; hourMap.set(h, hb); }
      hb.trades++;
      hb.pnl += t.pnl;
      if (t.pnl > 0) hb.wins++;
    }
    const hourlyBreakdown: HourStat[] = Array.from({ length: 24 }, (_, h) => {
      const hb = hourMap.get(h) ?? { trades: 0, pnl: 0, wins: 0 };
      return { hour: h, trades: hb.trades, pnl: hb.pnl, wins: hb.wins, winRate: hb.trades > 0 ? (hb.wins / hb.trades) * 100 : 0 };
    });

    // ── Day-of-week breakdown (0=Mon … 6=Sun) ────────────────────────────────
    const dowMap = new Map<number, { trades: number; pnl: number; wins: number }>();
    for (const t of trades) {
      const jsDay = t.closedAt.getUTCDay(); // 0=Sun
      const dow   = jsDay === 0 ? 6 : jsDay - 1; // 0=Mon
      let db = dowMap.get(dow);
      if (!db) { db = { trades: 0, pnl: 0, wins: 0 }; dowMap.set(dow, db); }
      db.trades++;
      db.pnl += t.pnl;
      if (t.pnl > 0) db.wins++;
    }
    const dowLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const dowBreakdown: DowStat[] = Array.from({ length: 7 }, (_, dow) => {
      const db = dowMap.get(dow) ?? { trades: 0, pnl: 0, wins: 0 };
      return { dow, day: dowLabels[dow]!, trades: db.trades, pnl: db.pnl, winRate: db.trades > 0 ? (db.wins / db.trades) * 100 : 0 };
    });

    // ── Monthly breakdown ─────────────────────────────────────────────────────
    const monMap = new Map<string, { pnl: number; trades: number; wins: number }>();
    for (const t of trades) {
      const ym = t.closedAt.toISOString().slice(0, 7);
      let mb = monMap.get(ym);
      if (!mb) { mb = { pnl: 0, trades: 0, wins: 0 }; monMap.set(ym, mb); }
      mb.pnl += t.pnl;
      mb.trades++;
      if (t.pnl > 0) mb.wins++;
    }
    const monthlyBreakdown: MonthStat[] = [...monMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ym, mb]) => ({
        month:    ym,
        label:    monthLabel(ym),
        pnl:      mb.pnl,
        trades:   mb.trades,
        winRate:  mb.trades > 0 ? (mb.wins / mb.trades) * 100 : 0,
      }));

    // ── Streaks ───────────────────────────────────────────────────────────────
    const streaks = computeStreaks(trades.map((t) => t.pnl));

    // ── PnL distribution histogram ────────────────────────────────────────────
    const pnlDistribution = buildPnlHistogram(trades.map((t) => t.pnl));

    return {
      period:   { days, from: from.toISOString(), to: to.toISOString() },
      summary:  {
        totalTrades, winRate, lossRate, profitFactor, expectancy,
        totalPnl, totalFees,
        maxDrawdown:        maxDDPct,
        maxDrawdownUsd:     maxDDUsd,
        sharpeRatio, sortinoRatio, calmarRatio,
        avgWin, avgLoss,
        bestTrade:  best  === -Infinity ? 0 : best,
        worstTrade: worst ===  Infinity ? 0 : worst,
        avgHoldTimeMs, avgHoldTimeWinMs, avgHoldTimeLossMs,
        dailyPnl, weeklyPnl, monthlyPnl,
        annualizedReturn, annualizedVol, recoveryFactor, cagr,
      },
      equityCurve,
      trades:  trades.slice(-200).map((t) => ({
        id:         t.id,
        symbol:     t.symbol,
        side:       t.side,
        pnl:        t.pnl,
        fees:       t.fees,
        durationMs: t.durationMs,
        openedAt:   t.openedAt.toISOString(),
        closedAt:   t.closedAt.toISOString(),
        entryPrice: t.entryPrice,
        exitPrice:  t.exitPrice,
      })),
      symbolBreakdown,
      hourlyBreakdown,
      dowBreakdown,
      monthlyBreakdown,
      streaks,
      pnlDistribution,
    };
  }
}

export const tradingAnalyticsCenter = new TradingAnalyticsCenter();
