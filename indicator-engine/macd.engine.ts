import { EMAEngine } from "./ema.engine.js";

export type MACDResult = {
  macd: number;
  signal: number;
  histogram: number;
  previousHistogram: number;
  bias: "bullish" | "bearish" | "neutral";
  crossover: "bullish_cross" | "bearish_cross" | "none";
};

export class MACDEngine {
  private readonly fastEMA: EMAEngine;
  private readonly slowEMA: EMAEngine;
  private readonly signalEMA: EMAEngine;
  private prevHistogram: number | null = null;
  private macdValues: number[] = [];
  private initialized = false;

  constructor(
    readonly fastPeriod = 12,
    readonly slowPeriod = 26,
    readonly signalPeriod = 9
  ) {
    this.fastEMA   = new EMAEngine(fastPeriod);
    this.slowEMA   = new EMAEngine(slowPeriod);
    this.signalEMA = new EMAEngine(signalPeriod);
  }

  next(price: number): MACDResult | null {
    const fast = this.fastEMA.next(price);
    const slow = this.slowEMA.next(price);

    if (!this.slowEMA.ready) return null;

    const macdLine = fast - slow;

    // Warm up signal EMA with macd values
    if (!this.initialized) {
      this.macdValues.push(macdLine);
      if (this.macdValues.length < this.signalPeriod) return null;
      // Feed all accumulated values
      for (const v of this.macdValues) this.signalEMA.next(v);
      this.initialized = true;
    } else {
      this.signalEMA.next(macdLine);
    }

    const signalLine = this.signalEMA.value!;
    const histogram  = macdLine - signalLine;

    const crossover: MACDResult["crossover"] =
      this.prevHistogram !== null && this.prevHistogram <= 0 && histogram > 0
        ? "bullish_cross"
        : this.prevHistogram !== null && this.prevHistogram >= 0 && histogram < 0
          ? "bearish_cross"
          : "none";

    const prevHisto = this.prevHistogram ?? 0;
    this.prevHistogram = histogram;

    return {
      macd:              Number(macdLine.toFixed(6)),
      signal:            Number(signalLine.toFixed(6)),
      histogram:         Number(histogram.toFixed(6)),
      previousHistogram: Number(prevHisto.toFixed(6)),
      bias:              macdLine > signalLine ? "bullish" : macdLine < signalLine ? "bearish" : "neutral",
      crossover,
    };
  }

  get ready(): boolean {
    return this.initialized;
  }

  reset(): void {
    this.fastEMA.reset();
    this.slowEMA.reset();
    this.signalEMA.reset();
    this.prevHistogram = null;
    this.macdValues = [];
    this.initialized = false;
  }
}

export default MACDEngine;
