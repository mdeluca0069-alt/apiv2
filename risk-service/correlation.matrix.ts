/**
 * CorrelationMatrix — live cross-asset portfolio correlation engine.
 *
 * Computes Pearson correlation coefficients between all open positions using
 * the last N daily closing prices. Used for:
 *   - Portfolio diversification scoring
 *   - Risk concentration warnings (pairs with |r| > 0.85)
 *   - Hedging opportunity detection (pairs with r < -0.5)
 *   - VaR adjustment (correlated positions amplify tail risk)
 *
 * Correlation scale: -1 (perfect inverse) → 0 (no correlation) → +1 (perfect).
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CorrelationPair = {
  symbolA:     string;
  symbolB:     string;
  correlation: number;    // [-1, 1]
  strength:    "strong_positive" | "moderate_positive" | "weak" | "moderate_negative" | "strong_negative";
  warning:     string | null;
  dataPoints:  number;
};

export type CorrelationMatrix = {
  symbols:      string[];
  matrix:       number[][];             // matrix[i][j] = corr(symbols[i], symbols[j])
  pairs:        CorrelationPair[];
  highRiskPairs:CorrelationPair[];      // |r| > 0.75
  hedgePairs:   CorrelationPair[];      // r < -0.5
  diversity:    number;                 // 0-100 portfolio diversity score
  generatedAt:  string;
  windowDays:   number;
};

// ─── Math helpers ─────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export function pearson(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

export function returns(prices: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    r.push((prices[i]! - prices[i - 1]!) / prices[i - 1]!);
  }
  return r;
}

function strengthLabel(r: number): CorrelationPair["strength"] {
  if (r > 0.75)  return "strong_positive";
  if (r > 0.35)  return "moderate_positive";
  if (r < -0.75) return "strong_negative";
  if (r < -0.35) return "moderate_negative";
  return "weak";
}

function warningMessage(r: number, a: string, b: string): string | null {
  if (r > 0.85)  return `High correlation: ${a}/${b} move together — doubling risk`;
  if (r < -0.85) return `Strong hedge: ${a}/${b} move inversely — natural offset`;
  if (r > 0.75)  return `${a} and ${b} are highly correlated`;
  return null;
}

// ─── Result cache ─────────────────────────────────────────────────────────────
// correlationWithOpenPositions() is called on every autopilot signal. Caching
// for 60 s eliminates repeated DB round-trips when multiple symbols are
// evaluated in the same signal cycle. Cache key: userId:newSymbol.

const CORR_CACHE_TTL_MS = 60_000;
type CorrCacheEntry = { pairs: CorrelationPair[]; expiresAt: number };
const _corrCache = new Map<string, CorrCacheEntry>();

// ─── CorrelationMatrix ────────────────────────────────────────────────────────

export class CorrelationMatrixEngine {

  async compute(userId: string, windowDays = 30): Promise<CorrelationMatrix> {
    if (!IS_PERSISTENT) {
      return this._sandboxMatrix(windowDays);
    }

    const db = prisma as NonNullable<typeof prisma>;

    // Get open positions
    const positions = await db.position.findMany({
      where:  { userId, status: "OPEN" },
      select: { symbol: true },
    });

    const symbols = [...new Set(positions.map(p => p.symbol))];
    if (symbols.length < 2) {
      return this._emptyMatrix(symbols, windowDays);
    }

    // Fetch historical daily closes from TradeAudit (OHLCV not in schema — use mark price log)
    const since = new Date(Date.now() - windowDays * 86_400_000);

    const priceSeriesMap = new Map<string, number[]>();

    for (const sym of symbols) {
      const rows = await db.tradeAudit.findMany({
        where:   { userId, symbol: sym, closedAt: { gte: since } },
        orderBy: { closedAt: "asc" },
        select:  { exitPrice: true },
      });

      const prices = rows
        .map(r => Number(r.exitPrice ?? 0))
        .filter(p => p > 0);

      if (prices.length >= 5) {
        priceSeriesMap.set(sym, prices);
      }
    }

    const validSymbols = Array.from(priceSeriesMap.keys());
    return this._buildMatrix(validSymbols, priceSeriesMap, windowDays);
  }

  /**
   * Correlation between a symbol not yet open (about to be traded) and every
   * symbol the user currently has an OPEN position in. Unlike compute(), the
   * new symbol doesn't need an open position — only historical TradeAudit
   * closes. Used by the autopilot to avoid stacking correlated risk before
   * placing a new order. Returns [] (never throws) when there's insufficient
   * history — correlation-awareness must never block a trade on missing data.
   */
  async correlationWithOpenPositions(
    userId: string,
    newSymbol: string,
    windowDays = 30,
  ): Promise<CorrelationPair[]> {
    if (!IS_PERSISTENT) return [];

    const cacheKey = `${userId}:${newSymbol}`;
    const cached = _corrCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.pairs;

    const db = prisma as NonNullable<typeof prisma>;

    const openPositions = await db.position.findMany({
      where:  { userId, status: "OPEN" },
      select: { symbol: true },
    });
    const openSymbols = [...new Set(openPositions.map((p) => p.symbol))].filter((s) => s !== newSymbol);
    if (openSymbols.length === 0) return [];

    const since = new Date(Date.now() - windowDays * 86_400_000);
    const allSymbols = [newSymbol, ...openSymbols];

    // Batch all symbols into a single query (eliminates N+1: was one query per symbol).
    // Group results by symbol in memory — same data, one round-trip instead of N.
    const allRows = await db.tradeAudit.findMany({
      where:   { userId, symbol: { in: allSymbols }, closedAt: { gte: since } },
      orderBy: { closedAt: "asc" },
      select:  { symbol: true, exitPrice: true },
    });

    const priceSeriesMap = new Map<string, number[]>();
    for (const row of allRows) {
      const price = Number(row.exitPrice ?? 0);
      if (price <= 0) continue;
      let arr = priceSeriesMap.get(row.symbol);
      if (!arr) { arr = []; priceSeriesMap.set(row.symbol, arr); }
      arr.push(price);
    }
    // Remove symbols with fewer than 5 data points — insufficient for correlation
    for (const [sym, prices] of priceSeriesMap) {
      if (prices.length < 5) priceSeriesMap.delete(sym);
    }

    if (!priceSeriesMap.has(newSymbol)) return [];

    const pairs: CorrelationPair[] = [];
    for (const sym of openSymbols) {
      if (!priceSeriesMap.has(sym)) continue;
      const ra  = returns(priceSeriesMap.get(newSymbol)!);
      const rb  = returns(priceSeriesMap.get(sym)!);
      const len = Math.min(ra.length, rb.length);
      if (len < 2) continue;
      const r = Math.round(pearson(ra.slice(-len), rb.slice(-len)) * 1000) / 1000;
      pairs.push({
        symbolA:     newSymbol,
        symbolB:     sym,
        correlation: r,
        strength:    strengthLabel(r),
        warning:     warningMessage(r, newSymbol, sym),
        dataPoints:  len,
      });
    }

    _corrCache.set(cacheKey, { pairs, expiresAt: Date.now() + CORR_CACHE_TTL_MS });
    return pairs;
  }

  private _buildMatrix(
    symbols:   string[],
    priceMap:  Map<string, number[]>,
    windowDays:number,
  ): CorrelationMatrix {
    const n      = symbols.length;
    const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const pairs:  CorrelationPair[] = [];

    for (let i = 0; i < n; i++) {
      matrix[i]![i] = 1; // self-correlation = 1
      for (let j = i + 1; j < n; j++) {
        const ra    = returns(priceMap.get(symbols[i]!)!);
        const rb    = returns(priceMap.get(symbols[j]!)!);
        const len   = Math.min(ra.length, rb.length);
        const corr  = len >= 2 ? pearson(ra.slice(-len), rb.slice(-len)) : 0;
        const r     = Math.round(corr * 1000) / 1000;

        matrix[i]![j] = r;
        matrix[j]![i] = r;

        pairs.push({
          symbolA:     symbols[i]!,
          symbolB:     symbols[j]!,
          correlation: r,
          strength:    strengthLabel(r),
          warning:     warningMessage(r, symbols[i]!, symbols[j]!),
          dataPoints:  len,
        });
      }
    }

    // Diversity score: 100 - average absolute correlation across pairs
    const avgAbsCorr = pairs.length > 0
      ? pairs.reduce((s, p) => s + Math.abs(p.correlation), 0) / pairs.length
      : 0;
    const diversity = Math.round((1 - avgAbsCorr) * 100);

    const highRiskPairs = pairs.filter(p => Math.abs(p.correlation) > 0.75);
    const hedgePairs    = pairs.filter(p => p.correlation < -0.5);

    return {
      symbols,
      matrix,
      pairs,
      highRiskPairs,
      hedgePairs,
      diversity,
      generatedAt: new Date().toISOString(),
      windowDays,
    };
  }

  private _emptyMatrix(symbols: string[], windowDays: number): CorrelationMatrix {
    return {
      symbols, matrix: [[1]], pairs: [],
      highRiskPairs: [], hedgePairs: [],
      diversity: 100,
      generatedAt: new Date().toISOString(),
      windowDays,
    };
  }

  private _sandboxMatrix(windowDays: number): CorrelationMatrix {
    const symbols = ["EURUSD", "GBPUSD", "XAUUSD", "BTCUSD", "US500"];
    const priceMap = new Map<string, number[]>([
      ["EURUSD", [1.08,1.081,1.083,1.079,1.085,1.088,1.086,1.090,1.093,1.091]],
      ["GBPUSD", [1.26,1.261,1.264,1.259,1.267,1.271,1.268,1.275,1.279,1.276]],
      ["XAUUSD", [1980,1995,1990,2005,2010,2008,2020,2035,2025,2040]],
      ["BTCUSD", [62000,63000,61500,64000,65500,63000,67000,69000,66000,70000]],
      ["US500",  [4800,4820,4790,4850,4880,4860,4900,4930,4910,4950]],
    ]);
    return this._buildMatrix(symbols, priceMap, windowDays);
  }
}

export const correlationMatrix = new CorrelationMatrixEngine();
