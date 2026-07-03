export class EMAEngine {
  private prev: number | null = null;
  private readonly k: number;
  private samplesProcessed = 0;

  constructor(readonly period: number) {
    if (period < 1) throw new Error("EMA period must be >= 1");
    this.k = 2 / (period + 1);
  }

  /** Feed one price tick. Returns current EMA (null until first value). */
  next(price: number): number {
    if (this.prev === null) {
      this.prev = price;
    } else {
      this.prev = price * this.k + this.prev * (1 - this.k);
    }
    this.samplesProcessed++;
    return this.prev;
  }

  /** Current EMA value without advancing. */
  get value(): number | null {
    return this.prev;
  }

  /** True once enough samples for the EMA to be statistically meaningful. */
  get ready(): boolean {
    return this.samplesProcessed >= this.period;
  }

  reset(): void {
    this.prev = null;
    this.samplesProcessed = 0;
  }

  /** Compute EMA over a complete price array (batch mode). */
  static compute(prices: number[], period: number): number[] {
    const engine = new EMAEngine(period);
    return prices.map((p) => engine.next(p));
  }
}

export default EMAEngine;
