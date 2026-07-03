import { EMAEngine } from "../indicator-engine/ema.engine.js";
import type { OHLCV } from "./volatility.engine.js";

export type MarketRegime =
  | "BULLISH_TREND"
  | "BEARISH_TREND"
  | "RANGING"
  | "COMPRESSION"
  | "EXPANSION"
  | "RISK_OFF"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "NEWS_DRIVEN"
  | "TREND_EXHAUSTION"
  | "ACCUMULATION"
  | "DISTRIBUTION"
  | "PANIC"
  | "RECOVERY";

export type RegimeContext = {
  /** Normalized ATR (atr/close*100) from VolatilityEngine */
  atrNormalized?:      number;
  /** True when recent ATR > prior ATR * 1.1 (VolatilityEngine.expanding) */
  atrExpanding?:       boolean;
  /** ATR percentile in range 0-100 (0 = lowest ATR in lookback, 100 = highest) */
  atrPercentile?:      number;
  /** Bollinger Band bandwidth = (upper-lower)/middle*100 */
  bollingerBandwidth?: number;
  /** True when bandwidth < 4 (Bollinger squeeze) */
  bollingerSqueeze?:   boolean;
  /** True when a high-impact macro event fired within the last 60 minutes */
  recentNewsEvent?:    boolean;
  /**
   * MarketStructureEngine's current phase (StructureResult.phase), passed in
   * by duck-typed string rather than an imported type — keeps ai-core from
   * depending on signals-engine. Lets ACCUMULATION/DISTRIBUTION reuse
   * Structure's already-computed phase instead of redefining the concept.
   */
  structurePhase?:     "ACCUMULATION" | "DISTRIBUTION" | "EXPANSION" | "RANGE" | "TRENDING_UP" | "TRENDING_DOWN" | "UNDEFINED";
};

/**
 * Heuristic-only regime confidence. `probability`/`confidence` are a distance-
 * to-decision-boundary normalization (NOT a calibrated probability — there is
 * no historical backtest behind this number, same self-aware convention as
 * MarketStructureEngine's neutral-50 scores). `reliability` reflects how much
 * ADX history backs the read. `transitionProbability` is a genuine empirical
 * first-order Markov transition matrix built from this engine's own observed
 * regime sequence — empty until enough history of leaving the current regime
 * has actually been observed (no fabricated uniform prior).
 */
export type RegimeProbability = {
  probability:            number;
  confidence:             number;
  reliability:            number;
  transitionProbability:  Partial<Record<MarketRegime, number>>;
};

export type RegimeResult = {
  regime:           MarketRegime;
  adx:              number;
  adxSlope:         number;         // positive = strengthening, negative = exhausting
  ema50AboveEma200: boolean;
  priceAboveEma200: boolean;
  trending:         boolean;
  description:      string;
  /** Additive — optional so existing destructuring callers are unaffected. */
  probabilistic?:   RegimeProbability;
};

// ─── ADX engine with Wilder smoothing + slope tracking ────────────────────────

class ADXEngine {
  private prevHigh:  number | null = null;
  private prevLow:   number | null = null;
  private prevClose: number | null = null;
  private smoothedTR  = 0;
  private smoothedPDM = 0;
  private smoothedNDM = 0;
  private dxValues:  number[] = [];
  private adxHistory: number[] = []; // rolling window for slope detection
  private _adx  = 0;
  private _samples = 0;

  private readonly ADX_HISTORY_WINDOW = 6; // candles used for slope calculation

  constructor(private readonly period = 14) {}

  next(candle: OHLCV): number | null {
    if (this.prevHigh === null) {
      this.prevHigh  = candle.high;
      this.prevLow   = candle.low;
      this.prevClose = candle.close;
      return null;
    }

    const tr  = Math.max(
      candle.high  - candle.low,
      Math.abs(candle.high - this.prevClose!),
      Math.abs(candle.low  - this.prevClose!),
    );
    const pdm = candle.high - this.prevHigh > this.prevLow! - candle.low
      ? Math.max(candle.high - this.prevHigh, 0) : 0;
    const ndm = this.prevLow! - candle.low > candle.high - this.prevHigh
      ? Math.max(this.prevLow! - candle.low, 0)  : 0;

    this._samples++;
    if (this._samples <= this.period) {
      this.smoothedTR  += tr;
      this.smoothedPDM += pdm;
      this.smoothedNDM += ndm;
    } else {
      this.smoothedTR  = this.smoothedTR  - this.smoothedTR  / this.period + tr;
      this.smoothedPDM = this.smoothedPDM - this.smoothedPDM / this.period + pdm;
      this.smoothedNDM = this.smoothedNDM - this.smoothedNDM / this.period + ndm;
    }

    this.prevHigh  = candle.high;
    this.prevLow   = candle.low;
    this.prevClose = candle.close;

    if (this._samples < this.period) return null;

    const pdi      = this.smoothedTR > 0 ? (this.smoothedPDM / this.smoothedTR) * 100 : 0;
    const ndi      = this.smoothedTR > 0 ? (this.smoothedNDM / this.smoothedTR) * 100 : 0;
    const dxDenom  = pdi + ndi;
    const dx       = dxDenom > 0 ? (Math.abs(pdi - ndi) / dxDenom) * 100 : 0;

    this.dxValues.push(dx);
    if (this.dxValues.length > this.period) this.dxValues.shift();

    this._adx = this.dxValues.reduce((a, b) => a + b, 0) / this.dxValues.length;

    this.adxHistory.push(this._adx);
    if (this.adxHistory.length > this.ADX_HISTORY_WINDOW) this.adxHistory.shift();

    return this._adx;
  }

  /** Linear regression slope of recent ADX values. Positive = strengthening. */
  get slope(): number {
    const n = this.adxHistory.length;
    if (n < 3) return 0;
    // Simple linear regression y ~ a + b*x; we return b (slope per candle)
    const xs = Array.from({ length: n }, (_, i) => i);
    const ys = this.adxHistory;
    const xMean = (n - 1) / 2;
    const yMean = ys.reduce((a, b) => a + b, 0) / n;
    const num   = xs.reduce((s, x, i) => s + (x - xMean) * (ys[i] - yMean), 0);
    const den   = xs.reduce((s, x)    => s + (x - xMean) ** 2, 0);
    return den > 0 ? num / den : 0;
  }

  /** ADX peak: highest value in recent history. */
  get peak(): number {
    return this.adxHistory.length ? Math.max(...this.adxHistory) : this._adx;
  }

  get value():  number  { return this._adx; }
  get ready():  boolean { return this._samples >= this.period * 2; }

  /** Heuristic 0-100 measure of how much history backs the current ADX read — saturates at 4x the minimum warm-up period. */
  get reliability(): number {
    return Math.min(100, Math.round((this._samples / (this.period * 4)) * 100));
  }
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const ATR_HIGH_VOL_THRESHOLD  = 1.5;  // atrNormalized > 1.5% = notable volatility
const ATR_LOW_VOL_THRESHOLD   = 0.3;  // atrNormalized < 0.3% = very low volatility
const ATR_HIGH_PERCENTILE     = 75;   // ATR in top quartile
const ADX_LOW_VOL_MAX         = 20;   // ADX < 20 to confirm low-vol
const ADX_EXHAUSTION_MIN      = 25;   // must have been trending to exhaust
const ADX_SLOPE_EXHAUSTION    = -0.4; // declining fast enough to flag exhaustion
const PANIC_ADX_MIN           = 35;   // must already be trending hard for a violent reversal to count as panic
const PANIC_ADX_SLOPE_MAX     = -1.0; // much sharper than TREND_EXHAUSTION's -0.4 — a violent reversal, not a gentle fade
const PANIC_RECOVERY_WINDOW   = 40;   // candles after a PANIC during which a positive ADX slope counts as re-basing
const RECOVERY_ADX_MAX        = 45;   // a little above PANIC_ADX_MIN — recovery starts as the panic intensity comes off, not only once fully back under the entry bar
const REGIME_HISTORY_CAP      = 200;  // bounded memory for the empirical transition matrix

function distanceConfidence(value: number, boundary: number, scale: number): number {
  return Math.max(0, Math.min(100, Math.round(Math.abs(value - boundary) * scale)));
}

// ─── RegimeEngine ─────────────────────────────────────────────────────────────

export class RegimeEngine {
  private readonly ema50:  EMAEngine;
  private readonly ema200: EMAEngine;
  private readonly adx:    ADXEngine;

  private regimeHistory: MarketRegime[] = [];
  private panicCooldown = 0;

  constructor() {
    this.ema50  = new EMAEngine(50);
    this.ema200 = new EMAEngine(200);
    this.adx    = new ADXEngine(14);
  }

  /**
   * @param candle  - current OHLCV candle
   * @param context - optional enrichment from Volatility / Bollinger / economic calendar
   */
  next(candle: OHLCV, context?: RegimeContext): RegimeResult | null {
    const ema50  = this.ema50.next(candle.close);
    const ema200 = this.ema200.next(candle.close);
    const adxVal = this.adx.next(candle);

    if (!this.ema50.ready || !this.ema200.ready) return null;

    const currentADX      = adxVal ?? this.adx.value;
    const adxSlope        = this.adx.slope;
    const ema50AboveEma200 = ema50 > ema200;
    const priceAboveEma200 = candle.close > ema200;
    const trending         = currentADX > 25;

    const atrNormalized      = context?.atrNormalized      ?? null;
    const atrExpanding       = context?.atrExpanding       ?? false;
    const atrPercentile      = context?.atrPercentile      ?? null;
    const bollingerBandwidth = context?.bollingerBandwidth ?? null;
    const bollingerSqueeze   = context?.bollingerSqueeze   ?? false;
    const recentNewsEvent    = context?.recentNewsEvent    ?? false;

    let regime: MarketRegime;

    // ── Priority ordering (most specific first) ────────────────────────────────

    // 1. NEWS_DRIVEN — active macro event overrides structural classification
    if (recentNewsEvent) {
      regime = "NEWS_DRIVEN";
    }

    // 1b. PANIC — a violent ADX reversal (much sharper than TREND_EXHAUSTION)
    // combined with an expanding volatility shock. Takes priority over
    // RISK_OFF because panic is about the speed/violence of the move, not
    // just its bearish structural direction.
    else if (
      currentADX >= PANIC_ADX_MIN &&
      adxSlope <= PANIC_ADX_SLOPE_MAX &&
      atrNormalized !== null &&
      atrNormalized > ATR_HIGH_VOL_THRESHOLD &&
      atrExpanding
    ) {
      regime = "PANIC";
    }

    // 1c. RECOVERY — ADX re-basing with positive slope within a short window
    // after a PANIC regime, before a clean directional trend has
    // re-established (still below the PANIC threshold itself).
    else if (this.panicCooldown > 0 && adxSlope > 0 && currentADX < RECOVERY_ADX_MAX) {
      regime = "RECOVERY";
    }

    // 2. RISK_OFF — strong bearish structural breakdown
    else if (currentADX > 40 && !ema50AboveEma200 && !priceAboveEma200) {
      regime = "RISK_OFF";
    }

    // 3. HIGH_VOLATILITY — ATR spike above threshold AND expanding
    else if (
      atrNormalized !== null &&
      atrNormalized > ATR_HIGH_VOL_THRESHOLD &&
      atrExpanding &&
      (atrPercentile === null || atrPercentile >= ATR_HIGH_PERCENTILE)
    ) {
      regime = "HIGH_VOLATILITY";
    }

    // 4. TREND_EXHAUSTION — was trending but ADX now declining from peak
    else if (
      trending &&
      currentADX >= ADX_EXHAUSTION_MIN &&
      adxSlope <= ADX_SLOPE_EXHAUSTION &&
      this.adx.peak - currentADX >= 4   // fell at least 4 points from peak
    ) {
      regime = "TREND_EXHAUSTION";
    }

    // 5. COMPRESSION / LOW_VOLATILITY / ACCUMULATION / DISTRIBUTION — no momentum.
    // ACCUMULATION/DISTRIBUTION are a structure-confirmed refinement of this
    // same low-ADX condition — when MarketStructureEngine's phase agrees, the
    // label gets more specific; with no structurePhase passed in (legacy
    // callers), behavior is byte-identical to before this phase's change.
    else if (currentADX < 15) {
      if (context?.structurePhase === "ACCUMULATION") {
        regime = "ACCUMULATION";
      } else if (context?.structurePhase === "DISTRIBUTION") {
        regime = "DISTRIBUTION";
      }
      // If low ATR confirms, call it LOW_VOLATILITY; otherwise structural COMPRESSION
      else if (
        atrNormalized !== null &&
        atrNormalized < ATR_LOW_VOL_THRESHOLD &&
        currentADX < ADX_LOW_VOL_MAX
      ) {
        regime = "LOW_VOLATILITY";
      } else if (bollingerSqueeze || bollingerBandwidth !== null && bollingerBandwidth < 4) {
        regime = "COMPRESSION";
      } else {
        regime = "COMPRESSION";
      }
    }

    // 6. Directional trends
    else if (trending && ema50AboveEma200 && priceAboveEma200) {
      regime = "BULLISH_TREND";
    } else if (trending && !ema50AboveEma200 && !priceAboveEma200) {
      regime = "BEARISH_TREND";
    }

    // 7. EXPANSION — strong directional momentum without full trend alignment
    else if (currentADX > 30) {
      regime = "EXPANSION";
    }

    // 8. Default: no clear structure
    else {
      regime = "RANGING";
    }

    const descriptions: Record<MarketRegime, string> = {
      BULLISH_TREND:    `ADX ${currentADX.toFixed(1)} — strong uptrend. Price > EMA200, EMA50 > EMA200.`,
      BEARISH_TREND:    `ADX ${currentADX.toFixed(1)} — strong downtrend. Price < EMA200, EMA50 < EMA200.`,
      RANGING:          `ADX ${currentADX.toFixed(1)} — no clear trend. Price oscillating.`,
      COMPRESSION:      `ADX ${currentADX.toFixed(1)} — volatility compression. Breakout imminent.`,
      EXPANSION:        `ADX ${currentADX.toFixed(1)} — volatility expansion. Directional move in progress.`,
      RISK_OFF:         `ADX ${currentADX.toFixed(1)} — strong bearish momentum with structural breakdown.`,
      HIGH_VOLATILITY:  `ATR ${(atrNormalized ?? 0).toFixed(2)}% — elevated volatility, expanding range. Exercise caution.`,
      LOW_VOLATILITY:   `ADX ${currentADX.toFixed(1)}, ATR ${(atrNormalized ?? 0).toFixed(2)}% — dormant market. Avoid breakouts.`,
      NEWS_DRIVEN:      `High-impact macro event active. Price action unreliable until event clears.`,
      TREND_EXHAUSTION: `ADX ${currentADX.toFixed(1)} declining (slope ${adxSlope.toFixed(2)}) — trend losing strength. Watch for reversal.`,
      ACCUMULATION:     `ADX ${currentADX.toFixed(1)} — low-momentum base, structure confirms accumulation. Possible markup ahead.`,
      DISTRIBUTION:     `ADX ${currentADX.toFixed(1)} — low-momentum base, structure confirms distribution. Possible markdown ahead.`,
      PANIC:            `ADX ${currentADX.toFixed(1)} reversing violently (slope ${adxSlope.toFixed(2)}) with a volatility shock — disorderly market.`,
      RECOVERY:         `ADX ${currentADX.toFixed(1)} re-basing (slope ${adxSlope.toFixed(2)}) after a panic move — stabilizing, no clean trend yet.`,
    };

    const probabilistic: RegimeProbability = {
      ...this._heuristicConfidence(regime, currentADX, adxSlope, atrNormalized),
      reliability: this.adx.reliability,
      transitionProbability: this._computeTransitionProbability(regime),
    };

    this.regimeHistory.push(regime);
    if (this.regimeHistory.length > REGIME_HISTORY_CAP) this.regimeHistory.shift();
    if (regime === "PANIC") this.panicCooldown = PANIC_RECOVERY_WINDOW;
    else if (this.panicCooldown > 0) this.panicCooldown--;

    return {
      regime,
      adx:             Number(currentADX.toFixed(2)),
      adxSlope:        Number(adxSlope.toFixed(3)),
      ema50AboveEma200,
      priceAboveEma200,
      trending,
      description:     descriptions[regime],
      probabilistic,
    };
  }

  /** Heuristic distance-to-decision-boundary confidence — not a calibrated probability. See RegimeProbability's doc comment. */
  private _heuristicConfidence(
    regime: MarketRegime, currentADX: number, adxSlope: number, atrNormalized: number | null,
  ): { probability: number; confidence: number } {
    let heuristic: number;
    switch (regime) {
      case "NEWS_DRIVEN":
        heuristic = 100; // a hard override, not a threshold zone
        break;
      case "RISK_OFF":
        heuristic = distanceConfidence(currentADX, 40, 4);
        break;
      case "BULLISH_TREND":
      case "BEARISH_TREND":
      case "RANGING":
        heuristic = distanceConfidence(currentADX, 25, 4);
        break;
      case "ACCUMULATION":
      case "DISTRIBUTION":
      case "COMPRESSION":
      case "LOW_VOLATILITY":
        heuristic = distanceConfidence(currentADX, 15, 4);
        break;
      case "EXPANSION":
        heuristic = distanceConfidence(currentADX, 30, 4);
        break;
      case "TREND_EXHAUSTION":
        heuristic = distanceConfidence(adxSlope, ADX_SLOPE_EXHAUSTION, 50);
        break;
      case "PANIC":
        heuristic = distanceConfidence(adxSlope, PANIC_ADX_SLOPE_MAX, 50);
        break;
      case "RECOVERY":
        heuristic = distanceConfidence(adxSlope, 0, 50);
        break;
      case "HIGH_VOLATILITY":
        heuristic = atrNormalized !== null ? distanceConfidence(atrNormalized, ATR_HIGH_VOL_THRESHOLD, 30) : 50;
        break;
      default:
        heuristic = 50;
    }
    return { probability: heuristic, confidence: heuristic };
  }

  /**
   * Empirical first-order Markov transition matrix from this engine's own
   * observed regime sequence — counts what this regime has actually
   * transitioned to historically. Returns {} (not a fabricated uniform
   * prior) when this regime has never been left before.
   */
  private _computeTransitionProbability(fromRegime: MarketRegime): Partial<Record<MarketRegime, number>> {
    const counts: Partial<Record<MarketRegime, number>> = {};
    let total = 0;
    for (let i = 0; i < this.regimeHistory.length - 1; i++) {
      if (this.regimeHistory[i] !== fromRegime) continue;
      const to = this.regimeHistory[i + 1];
      counts[to] = (counts[to] ?? 0) + 1;
      total++;
    }
    if (total === 0) return {};

    const probs: Partial<Record<MarketRegime, number>> = {};
    for (const [k, v] of Object.entries(counts)) {
      probs[k as MarketRegime] = Number((v! / total).toFixed(3));
    }
    return probs;
  }

  get ready(): boolean {
    return this.ema200.ready;
  }

  reset(): void {
    this.ema50.reset();
    this.ema200.reset();
    this.regimeHistory = [];
    this.panicCooldown = 0;
  }
}

export default RegimeEngine;
