import { pearson, returns } from "../risk-service/correlation.matrix.js";
import { getCandles, type Timeframe } from "../market-data/candle.aggregator.js";

export type CorrelationDataQuality = "FULL" | "PARTIAL" | "INSUFFICIENT";

export type CorrelationPairSnapshot = {
  symbolB: string;
  correlation: number;
  dataPoints: number;
};

export type CorrelationSnapshot = {
  symbol: string;
  signalSide: "BUY" | "SELL";
  pairs: CorrelationPairSnapshot[];
  dxyCorrelation: number | null;
  dxyDataPoints: number;
  consistentCount: number;
  usableCount: number;
  correlationScore: number;
  dataQuality: CorrelationDataQuality;
};

// The platform's 5 live signal instruments (matches main.ts's SIGNAL_SYMBOLS) —
// cross-checked against each other for directional confirmation. Exported so
// other read-only consumers (e.g. market.intelligence.ts) share one definition
// of "the platform's instrument universe" instead of hardcoding a second list.
export const PEER_INSTRUMENTS = ["EURUSD", "GBPUSD", "XAUUSD", "US500", "BTCUSD"];

// No DXY feed exists on this platform — synthesized as a weighted return
// series from the live USD-basket legs available (EURUSD/GBPUSD/USDJPY/
// USDCHF). Weights are the real DXY index's EUR/GBP/JPY/CHF shares
// (57.6/11.9/13.6/3.6), renormalized to these four since CAD/SEK aren't live
// instruments here. EURUSD/GBPUSD quote USD-per-foreign-unit (rising = USD
// weaker → negative DXY contribution); USDJPY/USDCHF quote foreign-per-USD
// (rising = USD stronger → positive contribution).
const DXY_BASKET: { symbol: string; weight: number }[] = [
  { symbol: "EURUSD", weight: -0.664 },
  { symbol: "USDJPY", weight: 0.157 },
  { symbol: "GBPUSD", weight: -0.137 },
  { symbol: "USDCHF", weight: 0.042 },
];

const TIMEFRAME: Timeframe = "1H";
const LOOKBACK_CANDLES = 60;
const MIN_DATA_POINTS = 10; // minimum return-pairs before a correlation reading is trusted

/** Max achievable usable slots: all peers except self (if the candidate is itself one of them), plus DXY. */
function maxUsableSlots(symbol: string): number {
  return PEER_INSTRUMENTS.includes(symbol) ? PEER_INSTRUMENTS.length : PEER_INSTRUMENTS.length + 1;
}

function closesOf(symbol: string): number[] {
  return getCandles(symbol, TIMEFRAME, LOOKBACK_CANDLES).map((c) => c.close);
}

/** Per-evaluate() memoization — EURUSD/GBPUSD are both PEER_INSTRUMENTS and DXY_BASKET legs, so without this every evaluate() call would fetch+map their candles twice. */
type ClosesLookup = (symbol: string) => number[];

function makeClosesLookup(): ClosesLookup {
  const cache = new Map<string, number[]>();
  return (symbol: string) => {
    let closes = cache.get(symbol);
    if (!closes) {
      closes = closesOf(symbol);
      cache.set(symbol, closes);
    }
    return closes;
  };
}

type Direction = "UP" | "DOWN" | "FLAT";

function shortTermDirection(closes: number[]): Direction {
  if (closes.length < 2) return "FLAT";
  const recent = closes.slice(-5);
  const delta = recent[recent.length - 1]! - recent[0]!;
  return delta > 0 ? "UP" : delta < 0 ? "DOWN" : "FLAT";
}

/** Synthesizes a DXY-proxy return series from the live USD-basket legs. Empty when any leg lacks history. */
function dxyReturns(closes: ClosesLookup): { series: number[]; dataPoints: number } {
  const legs = DXY_BASKET.map((leg) => ({ weight: leg.weight, rets: returns(closes(leg.symbol)) }));
  const len = Math.min(...legs.map((l) => l.rets.length));
  if (!Number.isFinite(len) || len < 2) return { series: [], dataPoints: 0 };

  const series: number[] = [];
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (const leg of legs) sum += leg.weight * leg.rets[leg.rets.length - len + i]!;
    series.push(sum);
  }
  return { series, dataPoints: len };
}

function dxyDirection(series: number[]): Direction {
  if (!series.length) return "FLAT";
  const sum = series.slice(-5).reduce((a, b) => a + b, 0);
  return sum > 0 ? "UP" : sum < 0 ? "DOWN" : "FLAT";
}

/**
 * Cross-asset correlation confirmation — reuses pearson()/returns() from
 * risk-service/correlation.matrix.ts rather than reimplementing the math.
 * Stateless and window-based (consistent with how that engine already
 * computes correlation), unlike the incrementally-fed indicator engines.
 */
export class CorrelationEngine {
  evaluate(symbol: string, signalSide: "BUY" | "SELL"): CorrelationSnapshot {
    const closes = makeClosesLookup();
    const ownReturns = returns(closes(symbol));

    const pairs: CorrelationPairSnapshot[] = [];
    let consistentCount = 0;
    let usableCount = 0;

    for (const peer of PEER_INSTRUMENTS) {
      if (peer === symbol) continue;
      const peerCloses = closes(peer);
      const peerReturns = returns(peerCloses);
      const len = Math.min(ownReturns.length, peerReturns.length);
      if (len < MIN_DATA_POINTS) continue;

      const r = Math.round(pearson(ownReturns.slice(-len), peerReturns.slice(-len)) * 1000) / 1000;
      pairs.push({ symbolB: peer, correlation: r, dataPoints: len });

      usableCount++;
      if (this._isConsistent(r, shortTermDirection(peerCloses), signalSide)) consistentCount++;
    }

    const { series: dxySeries, dataPoints: dxyDataPoints } = dxyReturns(closes);
    let dxyCorrelation: number | null = null;
    if (dxyDataPoints >= MIN_DATA_POINTS && ownReturns.length >= MIN_DATA_POINTS) {
      const len = Math.min(ownReturns.length, dxySeries.length);
      dxyCorrelation = Math.round(pearson(ownReturns.slice(-len), dxySeries.slice(-len)) * 1000) / 1000;
      usableCount++;
      if (this._isConsistent(dxyCorrelation, dxyDirection(dxySeries), signalSide)) consistentCount++;
    }

    const dataQuality: CorrelationDataQuality =
      usableCount === 0 ? "INSUFFICIENT"
      : usableCount < maxUsableSlots(symbol) ? "PARTIAL"
      : "FULL";

    // Neutral 50 on insufficient data — same graceful-degradation convention as
    // MarketStructureEngine.structureScoreFor / MultiTimeframeEngine.evaluate.
    const correlationScore = usableCount === 0 ? 50 : Math.round((consistentCount / usableCount) * 100);

    return {
      symbol,
      signalSide,
      pairs,
      dxyCorrelation,
      dxyDataPoints,
      consistentCount,
      usableCount,
      correlationScore,
      dataQuality,
    };
  }

  /**
   * A peer confirms the candidate's side when its own recent direction,
   * projected through the sign of the historical correlation, points the
   * same way as the candidate's hypothesis (positive correlation → same
   * direction; negative correlation → opposite direction).
   */
  private _isConsistent(correlation: number, peerDirection: Direction, signalSide: "BUY" | "SELL"): boolean {
    if (peerDirection === "FLAT" || correlation === 0) return false;
    const peerSign = peerDirection === "UP" ? 1 : -1;
    const predictedSign = Math.sign(correlation) * peerSign;
    const signalSign = signalSide === "BUY" ? 1 : -1;
    return predictedSign === signalSign;
  }
}

export const correlationEngine = new CorrelationEngine();
export default CorrelationEngine;
