export type RSIResult = {
  value: number;
  zone: "oversold" | "neutral" | "overbought";
};

export class RSIEngine {
  private prev: number | null = null;
  private avgGain = 0;
  private avgLoss = 0;
  private seedGains: number[] = [];
  private seedLosses: number[] = [];
  private initialized = false;

  constructor(readonly period: number = 14) {
    if (period < 2) throw new Error("RSI period must be >= 2");
  }

  /** Feed one close price. Returns null while warming up (< period samples). */
  next(price: number): RSIResult | null {
    if (this.prev === null) {
      this.prev = price;
      return null;
    }

    const change = price - this.prev;
    this.prev = price;

    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);

    if (!this.initialized) {
      this.seedGains.push(gain);
      this.seedLosses.push(loss);

      if (this.seedGains.length < this.period) return null;

      // Initial SMA seed (Wilder's method)
      this.avgGain = this.seedGains.reduce((a, b) => a + b, 0) / this.period;
      this.avgLoss = this.seedLosses.reduce((a, b) => a + b, 0) / this.period;
      this.initialized = true;
    } else {
      // Wilder's smoothing: NOT a simple moving average
      this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
      this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
    }

    const rsi = this.avgLoss === 0 ? 100 : 100 - 100 / (1 + this.avgGain / this.avgLoss);
    return {
      value: Number(rsi.toFixed(2)),
      zone:  rsi < 30 ? "oversold" : rsi > 70 ? "overbought" : "neutral",
    };
  }

  get ready(): boolean {
    return this.initialized;
  }

  reset(): void {
    this.prev = null;
    this.avgGain = 0;
    this.avgLoss = 0;
    this.seedGains = [];
    this.seedLosses = [];
    this.initialized = false;
  }

  static compute(closes: number[], period = 14): (RSIResult | null)[] {
    const engine = new RSIEngine(period);
    return closes.map((p) => engine.next(p));
  }
}

export default RSIEngine;
