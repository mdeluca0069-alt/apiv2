/**
 * ConfidenceOptimizer — fine-grained performance analysis across four dimensions:
 *
 *   • Symbol  — per-instrument win rate, profit factor, expectancy
 *   • Session — Asian / London / New York / London-NY Overlap
 *   • Regime  — every MarketRegime bucket
 *   • Confidence bucket — 10-point bands (50-59, 60-69, 70-79, 80-89, 90-100)
 *
 * Produces a structured PerformanceMatrix used by SelfOptimizerService and
 * the Signal Intelligence Center (admin routes).
 *
 * Max-drawdown is computed from the chronological PnL equity curve per symbol.
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionLabel = "Asian" | "London" | "NewYork" | "LondonNY";

export type SliceMetrics = {
  trades:       number;
  wins:         number;
  losses:       number;
  winRate:      number;     // 0-1
  profitFactor: number;     // gross profit / gross loss; Infinity when no losses
  expectancy:   number;     // avg(pnl per trade)
  avgWin:       number;
  avgLoss:      number;     // negative number
  totalPnl:     number;
};

export type SymbolMetrics = SliceMetrics & {
  symbol:      string;
  maxDrawdown: number;  // worst peak-to-trough in PnL units
  enabled:     boolean; // false = auto-blacklisted
};

export type SessionMetrics = SliceMetrics & {
  session: SessionLabel;
};

export type RegimeMetrics = SliceMetrics & {
  regime: string;
};

export type ConfidenceBucketMetrics = {
  bucket:         string;   // e.g. "70-79"
  lo:             number;
  hi:             number;
  trades:         number;
  wins:           number;
  actualWinRate:  number;   // observed win rate in this bucket
  targetWinRate:  number;   // centre of bucket / 100
  calibrationGap: number;   // actualWinRate - targetWinRate (positive = over-confident)
  avgPnl:         number;
};

export type MFEMAEStats = {
  avgMFE:  number;
  avgMAE:  number;
  mfeMaeRatio: number;
};

export type PerformanceMatrix = {
  overall:             SliceMetrics;
  bySymbol:            SymbolMetrics[];
  bySession:           SessionMetrics[];
  byRegime:            RegimeMetrics[];
  byConfidenceBucket:  ConfidenceBucketMetrics[];
  mfeMae:              MFEMAEStats;
  generatedAt:         Date;
  sampleSize:          number;
  lookbackDays:        number;
};

// ─── Session detection ────────────────────────────────────────────────────────

function detectSession(utcHour: number): SessionLabel {
  // London-NY overlap takes priority when both are active
  if (utcHour >= 13 && utcHour < 16) return "LondonNY";
  if (utcHour >=  8 && utcHour < 16) return "London";
  if (utcHour >= 13 && utcHour < 21) return "NewYork";
  if (utcHour >=  0 && utcHour <  8) return "Asian";
  return "NewYork"; // 21-23 UTC → late NY
}

// ─── Metric calculation helpers ───────────────────────────────────────────────

type RawTrade = {
  outcome:              string;
  pnl:                  number | null;
  maxFavorableExcursion: number | null;
  maxAdverseExcursion:   number | null;
};

function computeSlice(trades: RawTrade[]): SliceMetrics {
  const resolved = trades.filter((t) => t.outcome === "WIN" || t.outcome === "LOSS" || t.outcome === "BREAKEVEN");
  const wins     = resolved.filter((t) => t.outcome === "WIN");
  const losses   = resolved.filter((t) => t.outcome === "LOSS");

  const n = resolved.length;
  if (n === 0) return { trades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, expectancy: 0, avgWin: 0, avgLoss: 0, totalPnl: 0 };

  const grossProfit = wins.reduce((s, t)   => s + (t.pnl ?? 0), 0);
  const grossLoss   = losses.reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0);
  const totalPnl    = resolved.reduce((s, t) => s + (t.pnl ?? 0), 0);

  return {
    trades:       n,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      wins.length / n,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    expectancy:   totalPnl / n,
    avgWin:       wins.length   ? grossProfit / wins.length   : 0,
    avgLoss:      losses.length ? -(grossLoss / losses.length) : 0,
    totalPnl,
  };
}

function computeMaxDrawdown(pnls: number[]): number {
  let peak = 0;
  let equity = 0;
  let maxDD = 0;
  for (const pnl of pnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ─── Optimizer ────────────────────────────────────────────────────────────────

const AUTO_BLACKLIST_WIN_RATE   = 0.35;
const AUTO_BLACKLIST_PF         = 0.70;
const AUTO_BLACKLIST_MIN_TRADES = 10;

export class ConfidenceOptimizer {
  async buildPerformanceMatrix(lookbackDays = 28): Promise<PerformanceMatrix> {
    if (!IS_PERSISTENT) {
      return {
        overall: computeSlice([]), bySymbol: [], bySession: [], byRegime: [],
        byConfidenceBucket: [], mfeMae: { avgMFE: 0, avgMAE: 0, mfeMaeRatio: 0 },
        generatedAt: new Date(), sampleSize: 0, lookbackDays,
      };
    }

    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1_000);

    const rows = await prisma.signalTelemetry.findMany({
      where:   { generatedAt: { gte: since } },
      select:  {
        outcome:               true,
        pnl:                   true,
        symbol:                true,
        marketRegime:          true,
        confidence:            true,
        generatedAt:           true,
        maxFavorableExcursion: true,
        maxAdverseExcursion:   true,
      },
      orderBy: { generatedAt: "asc" },
    });

    const typed = rows.map((r) => ({
      outcome:               r.outcome,
      pnl:                   r.pnl ? Number(r.pnl) : null,
      symbol:                r.symbol,
      marketRegime:          r.marketRegime,
      confidence:            r.confidence,
      generatedAt:           r.generatedAt,
      maxFavorableExcursion: r.maxFavorableExcursion ? Number(r.maxFavorableExcursion) : null,
      maxAdverseExcursion:   r.maxAdverseExcursion   ? Number(r.maxAdverseExcursion)   : null,
    }));

    const overall = computeSlice(typed);

    // ── By symbol ──────────────────────────────────────────────────────────────
    const symbolGroups = _groupBy(typed, (t) => t.symbol);
    const bySymbol: SymbolMetrics[] = [];

    for (const [symbol, trades] of symbolGroups) {
      const metrics = computeSlice(trades);
      const resolvedPnls = trades
        .filter((t) => t.outcome === "WIN" || t.outcome === "LOSS" || t.outcome === "BREAKEVEN")
        .map((t) => t.pnl ?? 0);
      const maxDrawdown = computeMaxDrawdown(resolvedPnls);

      const enabled = !(
        metrics.trades >= AUTO_BLACKLIST_MIN_TRADES &&
        metrics.winRate < AUTO_BLACKLIST_WIN_RATE &&
        metrics.profitFactor < AUTO_BLACKLIST_PF
      );

      bySymbol.push({ symbol, maxDrawdown, enabled, ...metrics });
    }

    bySymbol.sort((a, b) => b.profitFactor - a.profitFactor);

    // ── By session ────────────────────────────────────────────────────────────
    const sessionGroups = _groupBy(typed, (t) => detectSession(t.generatedAt.getUTCHours()));
    const bySession: SessionMetrics[] = [];

    for (const [session, trades] of sessionGroups) {
      bySession.push({ session: session as SessionLabel, ...computeSlice(trades) });
    }

    bySession.sort((a, b) => b.winRate - a.winRate);

    // ── By regime ─────────────────────────────────────────────────────────────
    const regimeGroups = _groupBy(typed, (t) => t.marketRegime);
    const byRegime: RegimeMetrics[] = [];

    for (const [regime, trades] of regimeGroups) {
      byRegime.push({ regime, ...computeSlice(trades) });
    }

    byRegime.sort((a, b) => b.profitFactor - a.profitFactor);

    // ── By confidence bucket ──────────────────────────────────────────────────
    const BUCKETS: [number, number][] = [[50, 59], [60, 69], [70, 79], [80, 89], [90, 100]];
    const byConfidenceBucket: ConfidenceBucketMetrics[] = [];

    for (const [lo, hi] of BUCKETS) {
      const bucket = typed.filter((t) => t.confidence >= lo && t.confidence <= hi);
      const resolved = bucket.filter((t) => t.outcome === "WIN" || t.outcome === "LOSS" || t.outcome === "BREAKEVEN");
      const wins     = resolved.filter((t) => t.outcome === "WIN");
      const actualWR = resolved.length ? wins.length / resolved.length : 0;
      const targetWR = ((lo + hi) / 2) / 100;
      const avgPnl   = resolved.length ? resolved.reduce((s, t) => s + (t.pnl ?? 0), 0) / resolved.length : 0;

      byConfidenceBucket.push({
        bucket:         `${lo}-${hi}`,
        lo,
        hi,
        trades:         resolved.length,
        wins:           wins.length,
        actualWinRate:  actualWR,
        targetWinRate:  targetWR,
        calibrationGap: actualWR - targetWR,
        avgPnl,
      });
    }

    // ── MFE / MAE ─────────────────────────────────────────────────────────────
    const withMFEMAE = typed.filter(
      (t) => t.maxFavorableExcursion !== null && t.maxAdverseExcursion !== null,
    );
    const avgMFE = withMFEMAE.length
      ? withMFEMAE.reduce((s, t) => s + (t.maxFavorableExcursion ?? 0), 0) / withMFEMAE.length
      : 0;
    const avgMAE = withMFEMAE.length
      ? withMFEMAE.reduce((s, t) => s + Math.abs(t.maxAdverseExcursion ?? 0), 0) / withMFEMAE.length
      : 0;

    return {
      overall,
      bySymbol,
      bySession,
      byRegime,
      byConfidenceBucket,
      mfeMae: { avgMFE, avgMAE, mfeMaeRatio: avgMAE > 0 ? avgMFE / avgMAE : 0 },
      generatedAt: new Date(),
      sampleSize:  typed.length,
      lookbackDays,
    };
  }

  /** Best and worst symbols by win rate (min 5 trades). */
  async getBestWorstSymbols(
    lookbackDays = 28,
    minTrades    = 5,
  ): Promise<{ best: SymbolMetrics[]; worst: SymbolMetrics[] }> {
    const matrix = await this.buildPerformanceMatrix(lookbackDays);
    const eligible = matrix.bySymbol.filter((s) => s.trades >= minTrades);
    const sorted   = [...eligible].sort((a, b) => b.winRate - a.winRate);
    return {
      best:  sorted.slice(0, 5),
      worst: sorted.slice(-5).reverse(),
    };
  }

  /** Best and worst sessions by profit factor. */
  async getBestWorstSessions(lookbackDays = 28): Promise<{ best: SessionMetrics[]; worst: SessionMetrics[] }> {
    const matrix = await this.buildPerformanceMatrix(lookbackDays);
    const sorted = [...matrix.bySession].sort((a, b) => b.profitFactor - a.profitFactor);
    return {
      best:  sorted.slice(0, 2),
      worst: sorted.slice(-2).reverse(),
    };
  }
}

function _groupBy<T>(arr: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return map;
}

export const confidenceOptimizer = new ConfidenceOptimizer();
