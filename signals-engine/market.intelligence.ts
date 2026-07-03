/**
 * MarketIntelligence — read-only context aggregator. Never generates
 * signals, never scores a BUY/SELL hypothesis. Pulls together what already
 * exists (session timing, liquidity/slippage, volatility, economic
 * calendar, cross-asset correlation clusters) plus three genuinely new
 * metrics (Relative Strength, Market Breadth, DOM imbalance), each using the
 * simplest standard textbook formula rather than anything invented.
 *
 * "Confidence Context" and deep "News Context" are intentionally NOT
 * duplicated here: confidence scoring already lives in ai-core/confidence.engine.ts
 * and signals-engine/signal.explainer.ts, and news/sentiment beyond the
 * economic calendar is signals-engine/sentiment.analyzer.ts — an empty stub,
 * out of scope per Task 12's plan and unchanged here.
 */
import { sessionScoreForHour } from "../ai-core/confidence.engine.js";
import { VolatilityEngine, type VolatilityLevel } from "../ai-core/volatility.engine.js";
import { EMAEngine } from "../indicator-engine/ema.engine.js";
import { getCandles, type Timeframe } from "../market-data/candle.aggregator.js";
import { quoteCache } from "../market-data/quote.cache.js";
import { LiquidityProvider, assetClassOf } from "../liquidity-engine/liquidity.provider.js";
import { virtualOrderbook } from "../liquidity-engine/virtual.orderbook.js";
import { economicEventService } from "../economic-calendar/economic.event.service.js";
import { PEER_INSTRUMENTS } from "./correlation.engine.js";
import { buildCorrelationGraph, correlatedClusters } from "../risk-service/correlation.graph.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LiquidityContext = {
  assetClass: string;
  spreadBps: number | null;
  /** InternalLiquidityProvider.calculateFill()'s deterministic slippage at REFERENCE_UNITS — not a universal cross-asset-comparable figure, just the existing fill model's reused output. */
  referenceSlippage: number | null;
  /** (bidVolume - askVolume) / (bidVolume + askVolume) off the existing synthetic depth book — the standard order-book imbalance ratio. Positive = bid-heavy. */
  domImbalance: number | null;
};

export type VolatilityContext = {
  level: VolatilityLevel;
  atrNormalized: number;
} | null;

export type EconomicContext = {
  macroEventIn4h: boolean;
  recentHighImpactEvent: boolean;
};

export type RelativeStrengthContext = {
  benchmark: string;
  /** Price-relative ratio (Dorsey/Mansfield RS): symbol's N-period return / benchmark's N-period return. */
  ratio: number;
} | null;

export type MarketBreadthContext = {
  universeSize: number;
  /** % of the platform's tracked instruments currently trading above their own EMA200 — the standard "% above 200-MA" breadth proxy, applied to this platform's instrument list instead of an index's constituents. */
  pctAboveEma200: number;
} | null;

export type CrossAssetContext = {
  /** Symbols joined into a cluster by Phase 3's correlatedClusters() at the default 0.75 threshold — reused, not recomputed. */
  correlatedClusters: string[][];
};

export type MarketIntelligenceSnapshot = {
  symbol: string;
  generatedAt: string;
  session: { hourUtc: number; score: number };
  liquidity: LiquidityContext;
  volatility: VolatilityContext;
  economicContext: EconomicContext;
  relativeStrength: RelativeStrengthContext;
  marketBreadth: MarketBreadthContext;
  crossAsset: CrossAssetContext;
};

export type MarketIntelligenceOptions = {
  timeframe?: Timeframe;
  lookback?: number;
  /** N-period return window for Relative Strength. */
  rsWindow?: number;
  benchmark?: string;
  /** Reference unit size fed into InternalLiquidityProvider.calculateFill() for the reused slippage figure. */
  referenceUnits?: number;
};

const DEFAULT_TIMEFRAME: Timeframe = "1H";
const DEFAULT_LOOKBACK = 60;
const DEFAULT_RS_WINDOW = 20;
const DEFAULT_BENCHMARK = "US500";
const DEFAULT_REFERENCE_UNITS = 100_000;
// EMA200 needs 200 sequential samples to become ready — independent of
// whatever shorter lookback the other metrics in this file use.
const EMA200_LOOKBACK = 210;

function closesOf(symbol: string, timeframe: Timeframe, lookback: number): number[] {
  return getCandles(symbol, timeframe, lookback).map((c) => c.close);
}

/** Replays recent candles through a fresh VolatilityEngine — same pull-on-demand pattern as CorrelationEngine/CorrelationGraph, not coupled to SignalGenerator's live per-symbol instances. */
function currentVolatility(symbol: string, timeframe: Timeframe, lookback: number): VolatilityContext {
  const candles = getCandles(symbol, timeframe, lookback);
  if (candles.length === 0) return null;

  const engine = new VolatilityEngine();
  let last = null;
  for (const c of candles) last = engine.next(c) ?? last;
  if (!last) return null;
  return { level: last.level, atrNormalized: last.atrNormalized };
}

/** True once close > EMA200, replayed fresh from candle history — only what Market Breadth needs, not a full RegimeEngine classification. */
function priceAboveEma200(symbol: string, timeframe: Timeframe, lookback: number): boolean | null {
  const closes = closesOf(symbol, timeframe, lookback);
  if (closes.length === 0) return null;

  const ema = new EMAEngine(200);
  let value = NaN;
  for (const c of closes) value = ema.next(c);
  if (!ema.ready) return null;
  return closes[closes.length - 1]! > value;
}

function nPeriodReturn(closes: number[], window: number): number | null {
  if (closes.length < window + 1) return null;
  const start = closes[closes.length - 1 - window]!;
  const end = closes[closes.length - 1]!;
  if (start === 0) return null;
  return (end - start) / start;
}

export class MarketIntelligenceEngine {
  assemble(symbol: string, options: MarketIntelligenceOptions = {}): MarketIntelligenceSnapshot {
    const timeframe = options.timeframe ?? DEFAULT_TIMEFRAME;
    const lookback = options.lookback ?? DEFAULT_LOOKBACK;

    return {
      symbol,
      generatedAt: new Date().toISOString(),
      session: this._session(),
      liquidity: this._liquidity(symbol, options.referenceUnits ?? DEFAULT_REFERENCE_UNITS),
      volatility: currentVolatility(symbol, timeframe, lookback),
      economicContext: this._economicContext(symbol),
      relativeStrength: this._relativeStrength(symbol, options.benchmark ?? DEFAULT_BENCHMARK, options.rsWindow ?? DEFAULT_RS_WINDOW, timeframe, lookback),
      marketBreadth: this._marketBreadth(timeframe),
      crossAsset: this._crossAsset(),
    };
  }

  private _session(): { hourUtc: number; score: number } {
    const hourUtc = new Date().getUTCHours();
    return { hourUtc, score: sessionScoreForHour(hourUtc) };
  }

  private _liquidity(symbol: string, referenceUnits: number): LiquidityContext {
    const assetClass = assetClassOf(symbol);
    const quote = quoteCache.get(symbol);
    if (!quote) {
      return { assetClass, spreadBps: null, referenceSlippage: null, domImbalance: null };
    }

    const book = LiquidityProvider.buildBook(quote);
    const fill = LiquidityProvider.calculateFill({ symbol, bid: quote.bid, ask: quote.ask }, "BUY", referenceUnits);

    const depthBook = virtualOrderbook.build({
      symbol, bid: quote.bid, ask: quote.ask, mid: quote.mid, spread: quote.spread,
      changePct: quote.changePct, assetClass,
    });
    const totalBidVol = depthBook.bids[depthBook.bids.length - 1]?.cumulativeVolume ?? 0;
    const totalAskVol = depthBook.asks[depthBook.asks.length - 1]?.cumulativeVolume ?? 0;
    const domImbalance = (totalBidVol + totalAskVol) > 0
      ? Number(((totalBidVol - totalAskVol) / (totalBidVol + totalAskVol)).toFixed(4))
      : null;

    return { assetClass, spreadBps: book.spreadBps, referenceSlippage: fill.slippage, domImbalance };
  }

  private _economicContext(symbol: string): EconomicContext {
    return {
      macroEventIn4h: economicEventService.macroEventInNext4Hours(symbol),
      recentHighImpactEvent: economicEventService.hasRecentHighImpactEvent(symbol),
    };
  }

  private _relativeStrength(symbol: string, benchmark: string, window: number, timeframe: Timeframe, lookback: number): RelativeStrengthContext {
    if (symbol === benchmark) return null;
    const symbolCloses = closesOf(symbol, timeframe, Math.max(lookback, window + 1));
    const benchmarkCloses = closesOf(benchmark, timeframe, Math.max(lookback, window + 1));

    const symbolReturn = nPeriodReturn(symbolCloses, window);
    const benchmarkReturn = nPeriodReturn(benchmarkCloses, window);
    if (symbolReturn === null || benchmarkReturn === null || benchmarkReturn === 0) return null;

    return { benchmark, ratio: Number((symbolReturn / benchmarkReturn).toFixed(4)) };
  }

  private _marketBreadth(timeframe: Timeframe): MarketBreadthContext {
    const reads = PEER_INSTRUMENTS.map((s) => priceAboveEma200(s, timeframe, EMA200_LOOKBACK)).filter((v): v is boolean => v !== null);
    if (reads.length === 0) return null;

    const above = reads.filter((v) => v).length;
    return { universeSize: reads.length, pctAboveEma200: Number(((above / reads.length) * 100).toFixed(1)) };
  }

  private _crossAsset(): CrossAssetContext {
    const graph = buildCorrelationGraph(PEER_INSTRUMENTS);
    return { correlatedClusters: correlatedClusters(graph, 0.75) };
  }
}

export const marketIntelligence = new MarketIntelligenceEngine();
export default MarketIntelligenceEngine;
