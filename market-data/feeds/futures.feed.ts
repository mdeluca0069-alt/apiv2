/**
 * Futures Feed — metadata module.
 *
 * No dedicated futures instruments are currently in the IGFX symbol list.
 * Energy contracts (WTI, BRENT) are covered by commodities.feed.ts.
 * Live prices are delivered via the TwelveData WebSocket feed.
 * Historical candles are seeded at boot by historical.seeder.ts.
 */

export const FUTURES_SYMBOLS: readonly string[] = [] as const;

export const TWELVEDATA_FUTURES: readonly string[] = [] as const;

export type FuturesFeedStatus = {
  status:   "live";
  provider: "TwelveData";
  symbols:  readonly string[];
};

export function getFuturesFeedStatus(): FuturesFeedStatus {
  return {
    status:   "live",
    provider: "TwelveData",
    symbols:  FUTURES_SYMBOLS,
  };
}

export default getFuturesFeedStatus;
