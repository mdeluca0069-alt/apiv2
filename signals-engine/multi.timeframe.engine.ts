import { EMAEngine } from "../indicator-engine/ema.engine.js";
import { RSIEngine, type RSIResult } from "../indicator-engine/rsi.engine.js";
import { MACDEngine, type MACDResult } from "../indicator-engine/macd.engine.js";
import { VolatilityEngine, type VolatilityResult } from "../ai-core/volatility.engine.js";
import { ConfidenceEngine, type ConfluenceFactors } from "../ai-core/confidence.engine.js";
import { MarketStructureEngine, type StructureResult } from "./market.structure.js";
import { getCandles, type Candle } from "../market-data/candle.aggregator.js";

export type TimeframeKey = "1D" | "4H" | "1H" | "15M" | "5M";

export type DataQuality = "FULL" | "PARTIAL" | "INSUFFICIENT";

export type TimeframeScore = {
  timeframe: TimeframeKey;
  trend: number;
  momentum: number;
  structure: number;
  volatility: number;
  direction: "BUY" | "SELL" | "NEUTRAL";
  dataQuality: DataQuality;
  candleCount: number;
};

export type MultiTimeframeResult = {
  timeframes: TimeframeScore[];
  alignmentCount: number;
  dominantDirection: "BUY" | "SELL" | "NEUTRAL";
  mtfConfidenceMultiplier: number;
  sufficientAlignment: boolean;
  degradedTimeframes: TimeframeKey[];
};

const TIMEFRAME_KEYS: TimeframeKey[] = ["1D", "4H", "1H", "15M", "5M"];

// Candles needed before a timeframe is trusted at full weight. Daily/4H are
// gated behind the historical seeder (ENABLE_HISTORICAL_SEED) and accumulate
// slowly from live ticks alone — below this, the timeframe is still scored
// but flagged and excluded from the "never alone" alignment vote.
const MIN_CANDLES: Record<TimeframeKey, number> = {
  "1D": 50,
  "4H": 100,
  "1H": 200,
  "15M": 200,
  "5M": 200,
};

// Below this floor there isn't even enough data to warm up RSI(14) — scoring
// would be meaningless noise, not just "partial."
const MIN_USABLE_CANDLES = 20;

const CANDLE_FETCH_LIMIT = 250;

type TfEngineBundle = {
  ema50: EMAEngine;
  ema200: EMAEngine;
  rsi: RSIEngine;
  macd: MACDEngine;
  volatility: VolatilityEngine;
  structure: MarketStructureEngine;
  lastFedTime: number;
  lastRsi: RSIResult | null;
  lastMacd: MACDResult | null;
  lastVol: VolatilityResult | null;
  lastStructure: StructureResult | null;
};

export class MultiTimeframeEngine {
  private readonly confidence = new ConfidenceEngine();
  private readonly bundles = new Map<string, Map<TimeframeKey, TfEngineBundle>>();

  evaluate(symbol: string, signalSide: "BUY" | "SELL"): MultiTimeframeResult {
    const timeframes = TIMEFRAME_KEYS.map((tf) => this._scoreTimeframe(symbol, tf, signalSide));

    const usable = timeframes.filter((t) => t.dataQuality !== "INSUFFICIENT");
    const degradedTimeframes = timeframes
      .filter((t) => t.dataQuality === "INSUFFICIENT")
      .map((t) => t.timeframe);

    const buyCount  = usable.filter((t) => t.direction === "BUY").length;
    const sellCount = usable.filter((t) => t.direction === "SELL").length;
    const dominantDirection: "BUY" | "SELL" | "NEUTRAL" =
      buyCount > sellCount ? "BUY" : sellCount > buyCount ? "SELL" : "NEUTRAL";
    const alignmentCount = Math.max(buyCount, sellCount);

    const sideCount = usable.filter((t) => t.direction === signalSide).length;
    // "Never signal from one timeframe alone" — require a strict majority of
    // whichever timeframes actually have usable data (not a fixed "4 of 5",
    // which would block all signals platform-wide before Daily/4H backfill).
    const sufficientAlignment = usable.length >= 2 && sideCount > usable.length / 2;

    const agreementRatio = usable.length ? sideCount / usable.length : 0;
    const mtfConfidenceMultiplier = sufficientAlignment
      ? Math.min(1.15, 0.85 + agreementRatio * 0.3)
      : Math.max(0.5, 0.5 + agreementRatio * 0.3);

    return {
      timeframes,
      alignmentCount,
      dominantDirection,
      mtfConfidenceMultiplier,
      sufficientAlignment,
      degradedTimeframes,
    };
  }

  private _getBundle(symbol: string, tf: TimeframeKey): TfEngineBundle {
    const bySymbol = this.bundles.get(symbol) ?? new Map<TimeframeKey, TfEngineBundle>();
    if (!this.bundles.has(symbol)) this.bundles.set(symbol, bySymbol);

    let bundle = bySymbol.get(tf);
    if (!bundle) {
      bundle = {
        ema50:      new EMAEngine(50),
        ema200:     new EMAEngine(200),
        rsi:        new RSIEngine(14),
        macd:       new MACDEngine(12, 26, 9),
        volatility: new VolatilityEngine(14, 21),
        structure:  new MarketStructureEngine(),
        lastFedTime: -Infinity,
        lastRsi: null,
        lastMacd: null,
        lastVol: null,
        lastStructure: null,
      };
      bySymbol.set(tf, bundle);
    }
    return bundle;
  }

  private _scoreTimeframe(symbol: string, tf: TimeframeKey, signalSide: "BUY" | "SELL"): TimeframeScore {
    const bundle  = this._getBundle(symbol, tf);
    const candles = getCandles(symbol, tf, CANDLE_FETCH_LIMIT);

    // Only feed candles that arrived since the last evaluation — a 1D bundle
    // only needs feeding once/day, not on every 60s signal-generator tick.
    const newCandles = candles.filter((c) => c.time > bundle.lastFedTime);
    this._feed(bundle, newCandles);

    const candleCount = candles.length;
    // MARKET_DATA_FREEZE.md §0.4: dataQuality must reflect real market data,
    // not a count that synthetic-seeded placeholder candles (indistinguishable
    // from real ones before the Candle.synthetic flag existed) could trivially
    // satisfy from the very first evaluation after a restart. A timeframe
    // whose history is majority-synthetic is never reported "FULL".
    const realCandleCount = candles.filter((c) => !c.synthetic).length;
    const dataQuality: DataQuality =
      realCandleCount === 0 || realCandleCount < MIN_USABLE_CANDLES ? "INSUFFICIENT"
      : realCandleCount < MIN_CANDLES[tf] ? "PARTIAL"
      : "FULL";

    if (dataQuality === "INSUFFICIENT") {
      return { timeframe: tf, trend: 50, momentum: 50, structure: 50, volatility: 50, direction: "NEUTRAL", dataQuality, candleCount };
    }

    const ema50v  = bundle.ema50.value;
    const ema200v = bundle.ema200.value;
    const lastClose = candles[candles.length - 1]?.close ?? 0;

    const direction = this._direction(ema50v, ema200v, bundle.lastStructure);

    const factors: ConfluenceFactors = {
      signalSide,
      regime: "RANGING",
      priceVsEma200: ema200v !== null && lastClose < ema200v ? "below" : "above",
      ema50VsEma200: ema50v !== null && ema200v !== null && ema50v < ema200v ? "below" : "above",
      rsi: bundle.lastRsi,
      macd: bundle.lastMacd,
      bollinger: null,
      volatilityLevel: bundle.lastVol?.level ?? "MEDIUM",
      volumeAboveAverage: false,
      sessionHour: 8,
      macroEventIn4h: false,
      structure: bundle.lastStructure,
      // Per-timeframe scoring only needs the trend/momentum/volatility scorers,
      // none of which read multiTimeframe/correlation — left null, also avoiding
      // infinite recursion (this IS the engine that produces multiTimeframe for
      // the top-level factors).
      multiTimeframe: null,
      correlation: null,
    };

    return {
      timeframe: tf,
      trend:      this.confidence.scoreTrend(factors),
      momentum:   this.confidence.scoreMomentum(factors),
      structure:  bundle.structure.structureScoreFor(signalSide),
      volatility: this.confidence.scoreVolatility(factors),
      direction,
      dataQuality,
      candleCount,
    };
  }

  private _feed(bundle: TfEngineBundle, newCandles: Candle[]): void {
    if (!newCandles.length) return;

    let rsi  = bundle.lastRsi;
    let macd = bundle.lastMacd;
    let vol  = bundle.lastVol;
    let structure = bundle.lastStructure;

    for (const c of newCandles) {
      bundle.ema50.next(c.close);
      bundle.ema200.next(c.close);
      rsi  = bundle.rsi.next(c.close)   ?? rsi;
      macd = bundle.macd.next(c.close)  ?? macd;
      vol  = bundle.volatility.next(c)  ?? vol;
      structure = bundle.structure.next(c, { atrExpanding: vol?.expanding });
    }

    bundle.lastRsi = rsi;
    bundle.lastMacd = macd;
    bundle.lastVol = vol;
    bundle.lastStructure = structure;
    bundle.lastFedTime = newCandles[newCandles.length - 1].time;
  }

  private _direction(
    ema50: number | null,
    ema200: number | null,
    structure: StructureResult | null,
  ): "BUY" | "SELL" | "NEUTRAL" {
    if (ema50 !== null && ema200 !== null && ema50 !== ema200) {
      return ema50 > ema200 ? "BUY" : "SELL";
    }
    if (structure?.bullishStructure) return "BUY";
    if (structure?.bearishStructure) return "SELL";
    return "NEUTRAL";
  }

  /** True once a bundle exists for the (symbol, timeframe) pair — used by tests. */
  hasBundle(symbol: string, tf: TimeframeKey): boolean {
    return this.bundles.get(symbol)?.has(tf) ?? false;
  }

  /** Exposed for tests — how many candles were last fed into a bundle (cache-skip verification). */
  lastFedTimeFor(symbol: string, tf: TimeframeKey): number | null {
    return this.bundles.get(symbol)?.get(tf)?.lastFedTime ?? null;
  }
}

export const multiTimeframeEngine = new MultiTimeframeEngine();
export default MultiTimeframeEngine;
