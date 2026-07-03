/**
 * SignalAnalytics — quantitative performance measurement for OLOS signals.
 *
 * All metrics are computed from the SignalTelemetry table, which captures
 * every generated signal, its market context, and its eventual outcome.
 *
 * Metrics implemented:
 *   Win Rate          — % of executed signals that closed as WIN
 *   Profit Factor     — gross wins / gross losses (> 1.0 = net positive)
 *   Expectancy        — avg P&L per trade = (WR × avgWin) − (LR × avgLoss)
 *   Sharpe Ratio      — mean return / stdDev of returns (annualised)
 *   Regime breakdown  — win rate + profit factor per market regime
 *   Symbol breakdown  — top/bottom performing symbols
 *   Monthly P&L       — calendar view of cumulative PNL
 *   Confidence bands  — win rate per confidence decile (60–70, 70–80, 80–90, 90+)
 *   MFE/MAE averages  — how far trades went in favour/against before close
 *   Consecutive runs  — max win/loss streaks
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── Filter type ──────────────────────────────────────────────────────────────

export type AnalyticsFilter = {
  symbol?:      string;
  regime?:      string;
  timeframe?:   string;
  signalType?:  "BUY" | "SELL";
  fromDate?:    Date;
  toDate?:      Date;
};

// ─── Result types ─────────────────────────────────────────────────────────────

export type CoreMetrics = {
  totalSignals:        number;
  executedSignals:     number;
  executionRate:       number;       // % of signals executed by autopilot
  winCount:            number;
  lossCount:           number;
  breakevenCount:      number;
  expiredCount:        number;
  pendingCount:        number;
  winRate:             number;       // % (0-100)
  profitFactor:        number;       // gross wins / gross losses
  expectancy:          number;       // avg PNL per closed trade
  sharpeRatio:         number;       // annualised, using daily PNL series
  avgWin:              number;
  avgLoss:             number;
  largestWin:          number;
  largestLoss:         number;
  avgDurationSeconds:  number;
  avgMFE:              number;
  avgMAE:              number;
  avgRiskRewardRatio:  number;
  maxWinStreak:        number;
  maxLossStreak:       number;
};

export type RegimePerformance = {
  regime:       string;
  signals:      number;
  executed:     number;
  winRate:      number;
  profitFactor: number;
  expectancy:   number;
  avgConfidence: number;
};

export type SymbolPerformance = {
  symbol:        string;
  signals:       number;
  executed:      number;
  winRate:       number;
  totalPnl:      number;
  profitFactor:  number;
  expectancy:    number;
  avgMFE:        number;
  avgMAE:        number;
};

export type MonthlyPerformance = {
  month:         string;   // "YYYY-MM"
  signals:       number;
  wins:          number;
  losses:        number;
  winRate:       number;
  totalPnl:      number;
  profitFactor:  number;
};

export type ConfidenceBand = {
  band:         string;    // "60-70", "70-80", "80-90", "90+"
  count:        number;
  winRate:      number;
  avgPnl:       number;
  profitFactor: number;
};

export type DashboardSummary = {
  core:               CoreMetrics;
  regimes:            RegimePerformance[];
  topSymbols:         SymbolPerformance[];
  worstSymbols:       SymbolPerformance[];
  monthly:            MonthlyPerformance[];
  confidenceBands:    ConfidenceBand[];
  computedAt:         string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function buildWhere(filter: AnalyticsFilter) {
  return {
    ...(filter.symbol    ? { symbol:     filter.symbol }    : {}),
    ...(filter.regime    ? { marketRegime: filter.regime }  : {}),
    ...(filter.timeframe ? { timeframe:  filter.timeframe } : {}),
    ...(filter.signalType ? { signalType: filter.signalType } : {}),
    ...(filter.fromDate || filter.toDate ? {
      generatedAt: {
        ...(filter.fromDate ? { gte: filter.fromDate } : {}),
        ...(filter.toDate   ? { lte: filter.toDate }   : {}),
      },
    } : {}),
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class SignalAnalyticsService {

  async getCoreMetrics(filter: AnalyticsFilter = {}): Promise<CoreMetrics> {
    if (!IS_PERSISTENT || !prisma) return this._emptyCore();

    const db  = prisma as NonNullable<typeof prisma>;
    const where = buildWhere(filter);

    const rows = await db.signalTelemetry.findMany({
      where,
      select: {
        outcome:               true,
        pnl:                   true,
        durationSeconds:       true,
        maxFavorableExcursion: true,
        maxAdverseExcursion:   true,
        riskRewardRatio:       true,
        positionId:            true,
        confidence:            true,
        generatedAt:           true,
        closedAt:              true,
      },
      orderBy: { closedAt: "asc" },
    });

    const total       = rows.length;
    const executed    = rows.filter(r => r.positionId !== null).length;
    const closed      = rows.filter(r => ["WIN","LOSS","BREAKEVEN"].includes(r.outcome));
    const wins        = closed.filter(r => r.outcome === "WIN");
    const losses      = closed.filter(r => r.outcome === "LOSS");
    const breakevens  = closed.filter(r => r.outcome === "BREAKEVEN");
    const expired     = rows.filter(r => r.outcome === "EXPIRED").length;
    const pending     = rows.filter(r => r.outcome === "PENDING").length;

    const grossWins   = wins.reduce((s, r)   => s + Math.abs(toNum(r.pnl)), 0);
    const grossLosses = losses.reduce((s, r) => s + Math.abs(toNum(r.pnl)), 0);
    const totalPnl    = closed.reduce((s, r) => s + toNum(r.pnl), 0);

    const winRate     = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0;
    const expectancy   = closed.length > 0 ? totalPnl / closed.length : 0;

    const avgWin  = wins.length   > 0 ? grossWins   / wins.length   : 0;
    const avgLoss = losses.length > 0 ? grossLosses / losses.length : 0;

    const pnlValues   = closed.map(r => toNum(r.pnl));
    const sharpeRatio = this._computeSharpe(pnlValues);

    const durations  = closed.filter(r => r.durationSeconds !== null).map(r => r.durationSeconds!);
    const mfeValues  = closed.filter(r => r.maxFavorableExcursion !== null).map(r => toNum(r.maxFavorableExcursion));
    const maeValues  = closed.filter(r => r.maxAdverseExcursion   !== null).map(r => toNum(r.maxAdverseExcursion));

    const largestWin  = wins.length   > 0 ? Math.max(...wins.map(r => toNum(r.pnl)))    : 0;
    const largestLoss = losses.length > 0 ? Math.min(...losses.map(r => toNum(r.pnl)))  : 0;

    const { maxWinStreak, maxLossStreak } = this._computeStreaks(closed.map(r => r.outcome));

    return {
      totalSignals:       total,
      executedSignals:    executed,
      executionRate:      total > 0 ? (executed / total) * 100 : 0,
      winCount:           wins.length,
      lossCount:          losses.length,
      breakevenCount:     breakevens.length,
      expiredCount:       expired,
      pendingCount:       pending,
      winRate:            Number(winRate.toFixed(2)),
      profitFactor:       Number(profitFactor.toFixed(3)),
      expectancy:         Number(expectancy.toFixed(4)),
      sharpeRatio:        Number(sharpeRatio.toFixed(3)),
      avgWin:             Number(avgWin.toFixed(4)),
      avgLoss:            Number(avgLoss.toFixed(4)),
      largestWin:         Number(largestWin.toFixed(4)),
      largestLoss:        Number(largestLoss.toFixed(4)),
      avgDurationSeconds: durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      avgMFE:             mfeValues.length > 0
        ? Number((mfeValues.reduce((a, b) => a + b, 0) / mfeValues.length).toFixed(6)) : 0,
      avgMAE:             maeValues.length > 0
        ? Number((maeValues.reduce((a, b) => a + b, 0) / maeValues.length).toFixed(6)) : 0,
      avgRiskRewardRatio: closed.length > 0
        ? Number((closed.reduce((s, r) => s + r.riskRewardRatio, 0) / closed.length).toFixed(2)) : 0,
      maxWinStreak,
      maxLossStreak,
    };
  }

  async getRegimePerformance(filter: AnalyticsFilter = {}): Promise<RegimePerformance[]> {
    if (!IS_PERSISTENT || !prisma) return [];

    const db  = prisma as NonNullable<typeof prisma>;
    const rows = await db.signalTelemetry.findMany({
      where: buildWhere(filter),
      select: {
        marketRegime: true, outcome: true, pnl: true,
        positionId: true, confidence: true,
      },
    });

    const byRegime = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = byRegime.get(row.marketRegime) ?? [];
      group.push(row);
      byRegime.set(row.marketRegime, group);
    }

    const result: RegimePerformance[] = [];
    for (const [regime, group] of byRegime) {
      const executed = group.filter(r => r.positionId !== null).length;
      const closed   = group.filter(r => ["WIN","LOSS","BREAKEVEN"].includes(r.outcome));
      const wins     = closed.filter(r => r.outcome === "WIN");
      const losses   = closed.filter(r => r.outcome === "LOSS");

      const grossWins   = wins.reduce((s, r)   => s + Math.abs(toNum(r.pnl)), 0);
      const grossLosses = losses.reduce((s, r) => s + Math.abs(toNum(r.pnl)), 0);
      const totalPnl    = closed.reduce((s, r) => s + toNum(r.pnl), 0);

      result.push({
        regime,
        signals:      group.length,
        executed,
        winRate:      closed.length > 0 ? Number(((wins.length / closed.length) * 100).toFixed(2)) : 0,
        profitFactor: grossLosses > 0   ? Number((grossWins / grossLosses).toFixed(3))              : (grossWins > 0 ? 999 : 0),
        expectancy:   closed.length > 0 ? Number((totalPnl / closed.length).toFixed(4))             : 0,
        avgConfidence: group.length > 0  ? Number((group.reduce((s, r) => s + r.confidence, 0) / group.length).toFixed(1)) : 0,
      });
    }

    return result.sort((a, b) => b.winRate - a.winRate);
  }

  async getSymbolPerformance(filter: AnalyticsFilter = {}): Promise<SymbolPerformance[]> {
    if (!IS_PERSISTENT || !prisma) return [];

    const db   = prisma as NonNullable<typeof prisma>;
    const rows = await db.signalTelemetry.findMany({
      where: buildWhere(filter),
      select: {
        symbol: true, outcome: true, pnl: true, positionId: true,
        maxFavorableExcursion: true, maxAdverseExcursion: true,
      },
    });

    const bySymbol = new Map<string, typeof rows>();
    for (const row of rows) {
      const g = bySymbol.get(row.symbol) ?? [];
      g.push(row);
      bySymbol.set(row.symbol, g);
    }

    const result: SymbolPerformance[] = [];
    for (const [symbol, group] of bySymbol) {
      const executed = group.filter(r => r.positionId !== null).length;
      const closed   = group.filter(r => ["WIN","LOSS","BREAKEVEN"].includes(r.outcome));
      const wins     = closed.filter(r => r.outcome === "WIN");
      const losses   = closed.filter(r => r.outcome === "LOSS");

      const grossWins   = wins.reduce((s, r)   => s + Math.abs(toNum(r.pnl)), 0);
      const grossLosses = losses.reduce((s, r) => s + Math.abs(toNum(r.pnl)), 0);
      const totalPnl    = closed.reduce((s, r) => s + toNum(r.pnl), 0);
      const mfeArr      = closed.filter(r => r.maxFavorableExcursion !== null).map(r => toNum(r.maxFavorableExcursion));
      const maeArr      = closed.filter(r => r.maxAdverseExcursion   !== null).map(r => toNum(r.maxAdverseExcursion));

      result.push({
        symbol,
        signals:     group.length,
        executed,
        winRate:     closed.length > 0 ? Number(((wins.length / closed.length) * 100).toFixed(2)) : 0,
        totalPnl:    Number(totalPnl.toFixed(4)),
        profitFactor: grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(3)) : (grossWins > 0 ? 999 : 0),
        expectancy:  closed.length > 0 ? Number((totalPnl / closed.length).toFixed(4)) : 0,
        avgMFE:      mfeArr.length > 0 ? Number((mfeArr.reduce((a, b) => a + b, 0) / mfeArr.length).toFixed(6)) : 0,
        avgMAE:      maeArr.length > 0 ? Number((maeArr.reduce((a, b) => a + b, 0) / maeArr.length).toFixed(6)) : 0,
      });
    }

    return result.sort((a, b) => b.totalPnl - a.totalPnl);
  }

  async getMonthlyPerformance(filter: AnalyticsFilter = {}): Promise<MonthlyPerformance[]> {
    if (!IS_PERSISTENT || !prisma) return [];

    const db   = prisma as NonNullable<typeof prisma>;
    const rows = await db.signalTelemetry.findMany({
      where: { ...buildWhere(filter), outcome: { in: ["WIN","LOSS","BREAKEVEN"] } },
      select: { outcome: true, pnl: true, closedAt: true },
      orderBy: { closedAt: "asc" },
    });

    const byMonth = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!row.closedAt) continue;
      const key = row.closedAt.toISOString().slice(0, 7); // "YYYY-MM"
      const g   = byMonth.get(key) ?? [];
      g.push(row);
      byMonth.set(key, g);
    }

    const result: MonthlyPerformance[] = [];
    for (const [month, group] of byMonth) {
      const wins   = group.filter(r => r.outcome === "WIN");
      const losses = group.filter(r => r.outcome === "LOSS");
      const grossW = wins.reduce((s, r)   => s + Math.abs(toNum(r.pnl)), 0);
      const grossL = losses.reduce((s, r) => s + Math.abs(toNum(r.pnl)), 0);
      const totalPnl = group.reduce((s, r) => s + toNum(r.pnl), 0);

      result.push({
        month,
        signals:     group.length,
        wins:        wins.length,
        losses:      losses.length,
        winRate:     group.length > 0 ? Number(((wins.length / group.length) * 100).toFixed(2)) : 0,
        totalPnl:    Number(totalPnl.toFixed(4)),
        profitFactor: grossL > 0 ? Number((grossW / grossL).toFixed(3)) : (grossW > 0 ? 999 : 0),
      });
    }

    return result.sort((a, b) => a.month.localeCompare(b.month));
  }

  async getConfidenceBands(filter: AnalyticsFilter = {}): Promise<ConfidenceBand[]> {
    if (!IS_PERSISTENT || !prisma) return [];

    const db   = prisma as NonNullable<typeof prisma>;
    const rows = await db.signalTelemetry.findMany({
      where: { ...buildWhere(filter), outcome: { in: ["WIN","LOSS","BREAKEVEN"] } },
      select: { confidence: true, outcome: true, pnl: true },
    });

    const bands: Array<{ label: string; min: number; max: number }> = [
      { label: "60-70", min: 60, max: 70 },
      { label: "70-80", min: 70, max: 80 },
      { label: "80-90", min: 80, max: 90 },
      { label: "90+",   min: 90, max: 101 },
    ];

    return bands.map(({ label, min, max }) => {
      const group  = rows.filter(r => r.confidence >= min && r.confidence < max);
      const wins   = group.filter(r => r.outcome === "WIN");
      const losses = group.filter(r => r.outcome === "LOSS");
      const grossW = wins.reduce((s, r)   => s + Math.abs(toNum(r.pnl)), 0);
      const grossL = losses.reduce((s, r) => s + Math.abs(toNum(r.pnl)), 0);
      const total  = group.reduce((s, r) => s + toNum(r.pnl), 0);

      return {
        band:        label,
        count:       group.length,
        winRate:     group.length > 0 ? Number(((wins.length / group.length) * 100).toFixed(2)) : 0,
        avgPnl:      group.length > 0 ? Number((total / group.length).toFixed(4)) : 0,
        profitFactor: grossL > 0 ? Number((grossW / grossL).toFixed(3)) : (grossW > 0 ? 999 : 0),
      };
    });
  }

  async getDashboardSummary(filter: AnalyticsFilter = {}): Promise<DashboardSummary> {
    const [core, regimes, symbolPerf, monthly, confidenceBands] = await Promise.all([
      this.getCoreMetrics(filter),
      this.getRegimePerformance(filter),
      this.getSymbolPerformance(filter),
      this.getMonthlyPerformance(filter),
      this.getConfidenceBands(filter),
    ]);

    const top5    = symbolPerf.slice(0, 5);
    const worst5  = [...symbolPerf].sort((a, b) => a.totalPnl - b.totalPnl).slice(0, 5);

    return {
      core,
      regimes,
      topSymbols:      top5,
      worstSymbols:    worst5,
      monthly,
      confidenceBands,
      computedAt:      new Date().toISOString(),
    };
  }

  // ── Private math helpers ──────────────────────────────────────────────────

  private _computeSharpe(pnlValues: number[]): number {
    if (pnlValues.length < 2) return 0;
    const mean   = pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length;
    const sd     = stdDev(pnlValues);
    if (sd === 0) return 0;
    // Annualise assuming ~252 trading days, normalised to per-trade frequency
    const annualisedFactor = Math.sqrt(252);
    return Number(((mean / sd) * annualisedFactor).toFixed(3));
  }

  private _computeStreaks(outcomes: string[]): { maxWinStreak: number; maxLossStreak: number } {
    let maxWinStreak = 0, maxLossStreak = 0;
    let curWin = 0, curLoss = 0;

    for (const o of outcomes) {
      if (o === "WIN") {
        curWin++;
        curLoss = 0;
        if (curWin > maxWinStreak) maxWinStreak = curWin;
      } else if (o === "LOSS") {
        curLoss++;
        curWin = 0;
        if (curLoss > maxLossStreak) maxLossStreak = curLoss;
      } else {
        curWin = 0;
        curLoss = 0;
      }
    }

    return { maxWinStreak, maxLossStreak };
  }

  private _emptyCore(): CoreMetrics {
    return {
      totalSignals: 0, executedSignals: 0, executionRate: 0,
      winCount: 0, lossCount: 0, breakevenCount: 0, expiredCount: 0, pendingCount: 0,
      winRate: 0, profitFactor: 0, expectancy: 0, sharpeRatio: 0,
      avgWin: 0, avgLoss: 0, largestWin: 0, largestLoss: 0,
      avgDurationSeconds: 0, avgMFE: 0, avgMAE: 0,
      avgRiskRewardRatio: 0, maxWinStreak: 0, maxLossStreak: 0,
    };
  }
}

export const signalAnalytics = new SignalAnalyticsService();
