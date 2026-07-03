export type BollingerResult = {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
  percentB: number;
  squeeze: boolean;
};

/**
 * O(1) sliding-window mean and variance using the compensated sum technique.
 * Maintains mean and sum-of-squared-deviations incrementally without O(n) recalculation.
 */
class SlidingVariance {
  private readonly buf: Float64Array;
  private head    = 0;
  private count   = 0;
  private mean    = 0;
  private m2      = 0;

  constructor(private readonly period: number) {
    this.buf = new Float64Array(period);
  }

  push(value: number): void {
    if (this.count < this.period) {
      // Warm-up phase: incremental Welford
      this.count++;
      const delta  = value - this.mean;
      this.mean   += delta / this.count;
      this.m2     += delta * (value - this.mean);
      this.buf[this.head] = value;
      this.head = (this.head + 1) % this.period;
    } else {
      // Sliding phase: O(1) update via eviction of oldest value
      const evicted = this.buf[this.head];
      this.buf[this.head] = value;
      this.head = (this.head + 1) % this.period;

      const oldMean = this.mean;
      this.mean    += (value - evicted) / this.period;
      this.m2      += (value - evicted) * (value - this.mean + evicted - oldMean);

      // Numeric stability: clamp small floating-point negatives to zero
      if (this.m2 < 0) this.m2 = 0;
    }
  }

  get sma(): number { return this.mean; }

  /** Sample variance (Bessel-corrected). */
  get variance(): number {
    return this.count < 2 ? 0 : this.m2 / (this.count - 1);
  }

  get stddev(): number { return Math.sqrt(this.variance); }

  get ready(): boolean { return this.count >= this.period; }
}

export class BollingerEngine {
  private readonly calc: SlidingVariance;

  constructor(
    readonly period = 20,
    readonly multiplier = 2
  ) {
    this.calc = new SlidingVariance(period);
  }

  next(price: number): BollingerResult | null {
    this.calc.push(price);
    if (!this.calc.ready) return null;

    const middle    = this.calc.sma;
    const stddev    = this.calc.stddev;
    const upper     = middle + this.multiplier * stddev;
    const lower     = middle - this.multiplier * stddev;
    const bandwidth = middle > 0 ? ((upper - lower) / middle) * 100 : 0;
    const percentB  = upper !== lower ? (price - lower) / (upper - lower) * 100 : 50;
    const squeeze   = bandwidth < 4;

    return {
      upper:     Number(upper.toFixed(6)),
      middle:    Number(middle.toFixed(6)),
      lower:     Number(lower.toFixed(6)),
      bandwidth: Number(bandwidth.toFixed(4)),
      percentB:  Number(percentB.toFixed(2)),
      squeeze,
    };
  }

  get ready(): boolean {
    return this.calc.ready;
  }
}

export default BollingerEngine;
