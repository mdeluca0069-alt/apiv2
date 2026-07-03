/**
 * SignalAnalyticsService — measures real OLOS AI signal performance from DB.
 *
 * All metrics are computed from OlosSignal rows. Signal outcome is inferred
 * by cross-referencing TRIGGERED signals with TradeAudit records that share
 * the same userId + symbol + approximate timeframe window.
 *
 * Metrics:
 *   totalSignals       — all-time signals generated
 *   activeSignals      — currently ACTIVE
 *   triggeredSignals   — have been acted on
 *   winRate            — % of triggered signals that produced positive PnL
 *   avgConfidence      — mean confidence of all signals
 *   avgWinConfidence   — mean confidence of winning signals
 *   avgLossConfidence  — mean confidence of losing signals
 *   calibrationScore   — Brier score (lower = better calibrated confidence)
 *   bySymbol           — win rate and count per symbol
 *   byRegime           — win rate per market regime
 *   byTimeframe        — signal count and win rate per timeframe
 *   byType             — BUY vs SELL accuracy
 *   confidenceDeciles  — win rate for each 10% confidence bucket
 *   recentAccuracy     — 7-day rolling accuracy
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";

export type SignalPerformanceBucket = {
  count:   number;
  wins:    number;
  winRate: number;
};

export type SignalAnalytics = {
  totalSignals:       number;
  activeSignals:      number;
  triggeredSignals:   number;
  cancelledSignals:   number;
  winRate:            number;
  avgConfidence:      number;
  avgWinConfidence:   number;
  avgLossConfidence:  number;
  calibrationScore:   number;
  recentAccuracy:     number;
  bySymbol:           Record<string, SignalPerformanceBucket>;
  byRegime:           Record<string, SignalPerformanceBucket>;
  byTimeframe:        Record<string, SignalPerformanceBucket>;
  byType:             Record<string, SignalPerformanceBucket>;
  confidenceDeciles:  { bucket: string; winRate: number; count: number }[];
  generatedAt:        string;
};

function emptyAnalytics(): SignalAnalytics {
  return {
    totalSignals: 0, activeSignals: 0, triggeredSignals: 0, cancelledSignals: 0,
    winRate: 0, avgConfidence: 0, avgWinConfidence: 0, avgLossConfidence: 0,
    calibrationScore: 0, recentAccuracy: 0,
    bySymbol: {}, byRegime: {}, byTimeframe: {}, byType: {},
    confidenceDeciles: [],
    generatedAt: new Date().toISOString(),
  };
}

function addToBucket(
  map: Record<string, SignalPerformanceBucket>,
  key: string,
  win: boolean,
) {
  if (!map[key]) map[key] = { count: 0, wins: 0, winRate: 0 };
  map[key].count++;
  if (win) map[key].wins++;
}

function finalizeBuckets(map: Record<string, SignalPerformanceBucket>) {
  for (const b of Object.values(map)) {
    b.winRate = b.count > 0 ? Math.round((b.wins / b.count) * 1000) / 10 : 0;
  }
}

export class SignalAnalyticsService {

  async getAnalytics(userId?: string): Promise<SignalAnalytics> {
    if (!IS_PERSISTENT) return emptyAnalytics();

    const where = userId ? { userId } : {};

    const [signals, tradeAudits] = await Promise.all([
      prisma.olosSignal.findMany({
        where,
        select: {
          id:           true,
          symbol:       true,
          timeframe:    true,
          signalType:   true,
          confidence:   true,
          marketRegime: true,
          status:       true,
          triggeredAt:  true,
          createdAt:    true,
          userId:       true,
        },
      }),
      prisma.tradeAudit.findMany({
        where: { ...where, tradeStatus: "CLOSED", closedAt: { not: null } },
        select: { userId: true, symbol: true, pnlRealized: true, createdAt: true, closedAt: true },
      }),
    ]);

    if (signals.length === 0) return emptyAnalytics();

    const totalSignals      = signals.length;
    const activeSignals     = signals.filter((s) => s.status === "ACTIVE").length;
    const triggeredSignals  = signals.filter((s) => s.status === "TRIGGERED").length;
    const cancelledSignals  = signals.filter((s) => s.status === "CANCELLED").length;

    // Match triggered signals to trade outcomes via symbol + user + time proximity (±4 hours)
    const WINDOW_MS = 4 * 60 * 60 * 1000;
    const triggered = signals.filter((s) => s.status === "TRIGGERED" && s.triggeredAt);

    let wins = 0, losses = 0;
    let sumWinConf = 0, sumLossConf = 0;
    let brierSum = 0;

    const bySymbol:    Record<string, SignalPerformanceBucket> = {};
    const byRegime:    Record<string, SignalPerformanceBucket> = {};
    const byTimeframe: Record<string, SignalPerformanceBucket> = {};
    const byType:      Record<string, SignalPerformanceBucket> = {};

    // 10 confidence deciles: 0-10%, 10-20%, ..., 90-100%
    const decileMap: Record<number, { count: number; wins: number }> = {};
    for (let d = 0; d < 10; d++) decileMap[d] = { count: 0, wins: 0 };

    for (const sig of triggered) {
      const conf    = sig.confidence.toNumber();
      const tAt     = sig.triggeredAt!.getTime();
      const decile  = Math.min(9, Math.floor(conf / 10));

      // Find the closest trade audit within the time window
      const match = tradeAudits.find(
        (t) =>
          t.userId  === sig.userId &&
          t.symbol  === sig.symbol &&
          Math.abs(t.createdAt.getTime() - tAt) < WINDOW_MS
      );

      if (!match) {
        // No matching trade — treat as unresolved
        decileMap[decile].count++;
        continue;
      }

      const pnl = Number(match.pnlRealized ?? 0);
      const win = pnl > 0;

      if (win) { wins++; sumWinConf  += conf; }
      else     { losses++; sumLossConf += conf; }

      decileMap[decile].count++;
      if (win) decileMap[decile].wins++;

      // Brier score component: (confidence_fraction - outcome)²
      brierSum += Math.pow(conf / 100 - (win ? 1 : 0), 2);

      addToBucket(bySymbol,    sig.symbol,         win);
      addToBucket(byRegime,    sig.marketRegime,    win);
      addToBucket(byTimeframe, sig.timeframe,       win);
      addToBucket(byType,      sig.signalType,      win);
    }

    finalizeBuckets(bySymbol);
    finalizeBuckets(byRegime);
    finalizeBuckets(byTimeframe);
    finalizeBuckets(byType);

    const resolved       = wins + losses;
    const winRate        = resolved > 0 ? Math.round((wins / resolved) * 1000) / 10 : 0;
    const avgWinConf     = wins   > 0 ? sumWinConf  / wins   : 0;
    const avgLossConf    = losses > 0 ? sumLossConf / losses  : 0;
    const calibScore     = resolved > 0 ? Math.round((brierSum / resolved) * 10000) / 10000 : 0;
    const avgConfidence  = totalSignals > 0
      ? signals.reduce((s, sig) => s + sig.confidence.toNumber(), 0) / totalSignals : 0;

    // 7-day rolling accuracy
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const recentResolved = triggered.filter(
      (s) => s.triggeredAt && s.triggeredAt >= sevenDaysAgo
    );
    const recentWins = recentResolved.filter((s) => {
      const m = tradeAudits.find(
        (t) => t.userId === s.userId && t.symbol === s.symbol &&
               Math.abs(t.createdAt.getTime() - s.triggeredAt!.getTime()) < WINDOW_MS
      );
      return m && Number(m.pnlRealized ?? 0) > 0;
    }).length;
    const recentAccuracy = recentResolved.length > 0
      ? Math.round((recentWins / recentResolved.length) * 1000) / 10 : 0;

    const confidenceDeciles = Object.entries(decileMap).map(([d, v]) => ({
      bucket:  `${Number(d) * 10}–${Number(d) * 10 + 10}%`,
      winRate: v.count > 0 ? Math.round((v.wins / v.count) * 1000) / 10 : 0,
      count:   v.count,
    }));

    return {
      totalSignals, activeSignals, triggeredSignals, cancelledSignals,
      winRate,
      avgConfidence:     Math.round(avgConfidence * 10) / 10,
      avgWinConfidence:  Math.round(avgWinConf  * 10) / 10,
      avgLossConfidence: Math.round(avgLossConf * 10) / 10,
      calibrationScore:  calibScore,
      recentAccuracy,
      bySymbol, byRegime, byTimeframe, byType,
      confidenceDeciles,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const signalAnalyticsService = new SignalAnalyticsService();
