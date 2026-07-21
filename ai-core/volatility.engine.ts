export type VolatilityLevel = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";

export type VolatilityResult = {
  atr: number;
  atrNormalized: number;
  realizedVol: number;
  level: VolatilityLevel;
  expanding: boolean;
};

export type OHLCV = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  timestamp?: string;
  /** MARKET_DATA_FREEZE.md §0.4: see Candle.synthetic (market-data/candle.aggregator.ts). */
  synthetic?: boolean;
};

export class VolatilityEngine {
  private prevATR: number | null  = null;
  private prevClose: number | null = null;
  private atrValues: number[] = [];
  private logReturns: number[] = [];

  constructor(
    private readonly atrPeriod = 14,
    private readonly volWindow = 21
  ) {}

  next(candle: OHLCV): VolatilityResult | null {
    // True Range
    const tr = this.prevClose !== null
      ? Math.max(
          candle.high - candle.low,
          Math.abs(candle.high - this.prevClose),
          Math.abs(candle.low  - this.prevClose)
        )
      : candle.high - candle.low;

    // ATR via Wilder smoothing
    const atr = this.prevATR === null
      ? tr
      : (this.prevATR * (this.atrPeriod - 1) + tr) / this.atrPeriod;

    this.atrValues.push(atr);
    if (this.atrValues.length > this.atrPeriod * 2) this.atrValues.shift();

    // Log returns for realized volatility
    if (this.prevClose !== null && this.prevClose > 0) {
      this.logReturns.push(Math.log(candle.close / this.prevClose));
      if (this.logReturns.length > this.volWindow) this.logReturns.shift();
    }

    this.prevATR   = atr;
    this.prevClose = candle.close;

    if (this.atrValues.length < this.atrPeriod) return null;

    // ATR normalized as % of close price
    const atrNormalized = candle.close > 0 ? (atr / candle.close) * 100 : 0;

    // Realized volatility: annualized std of log returns (252 trading days)
    let realizedVol = 0;
    if (this.logReturns.length >= 5) {
      const mean = this.logReturns.reduce((a, b) => a + b, 0) / this.logReturns.length;
      const variance = this.logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / this.logReturns.length;
      realizedVol = Math.sqrt(variance * 252) * 100;
    }

    // ATR expanding vs prior period
    const midpoint = Math.floor(this.atrValues.length / 2);
    const recentAvgATR = this.atrValues.slice(midpoint).reduce((a, b) => a + b, 0) / (this.atrValues.length - midpoint);
    const prevAvgATR   = this.atrValues.slice(0, midpoint).reduce((a, b) => a + b, 0) / midpoint;
    const expanding = recentAvgATR > prevAvgATR * 1.1;

    const level: VolatilityLevel =
      atrNormalized > 2.5 ? "EXTREME"
      : atrNormalized > 1.2 ? "HIGH"
      : atrNormalized > 0.4 ? "MEDIUM"
      : "LOW";

    return {
      atr:           Number(atr.toFixed(6)),
      atrNormalized: Number(atrNormalized.toFixed(4)),
      realizedVol:   Number(realizedVol.toFixed(2)),
      level,
      expanding,
    };
  }

  get ready(): boolean {
    return this.atrValues.length >= this.atrPeriod;
  }

  reset(): void {
    this.prevATR   = null;
    this.prevClose = null;
    this.atrValues = [];
    this.logReturns = [];
  }
}

export default VolatilityEngine;
