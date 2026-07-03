/**
 * SpreadStore — records and retrieves the last observed real bid/ask spread
 * for each instrument.
 *
 * Values are sourced exclusively from TwelveData paid-plan ticks that carry
 * real bid/ask fields (isRealSpread = true).  No synthetic, hardcoded, or
 * volatility-derived spreads are generated.
 *
 * Usage in InternalLiquidityCore:
 *   - Call recordRealSpread() on every ingestExternalPrice() that has real bid/ask.
 *   - Call getLastRealSpread() to derive bid/ask from mid when the feed provides
 *     only a mid price (free plan).  Returns null if no real spread has been
 *     recorded yet — callers must handle null by using mid±0 (zero spread) until
 *     a real spread is available.
 */

export class SpreadStore {
  private readonly lastRealSpread = new Map<string, number>();

  /** Record a real spread observed from the TwelveData paid-plan feed. */
  recordRealSpread(symbol: string, bid: number, ask: number): void {
    const spread = Number((ask - bid).toFixed(8));
    if (spread > 0 && isFinite(spread)) {
      this.lastRealSpread.set(symbol.toUpperCase(), spread);
    }
  }

  /**
   * Returns the last real spread observed for a symbol, or null if none
   * has been recorded yet.  Callers must not fabricate a spread if null —
   * use mid±0 (zero spread) and accept that execution quality reflects the
   * absence of real bid/ask data.
   */
  getLastRealSpread(symbol: string): number | null {
    return this.lastRealSpread.get(symbol.toUpperCase()) ?? null;
  }

  getAll(): Record<string, number> {
    return Object.fromEntries(this.lastRealSpread);
  }
}

export const spreadStore = new SpreadStore();
