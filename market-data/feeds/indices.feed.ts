/**
 * Indices Feed — metadata module.
 *
 * Live prices are delivered via the TwelveData WebSocket feed
 * (twelvedata.feed.ts → aggregator.ts → InternalLiquidityCore).
 * Historical candles are seeded at boot by historical.seeder.ts.
 * This module exists to expose symbol metadata and a status helper.
 */

export const INDICES_SYMBOLS = ["US500", "US100", "DE40", "UK100"] as const;

export const TWELVEDATA_INDICES = ["SPX", "NDX", "DAX", "FTSE"] as const;

export type IndicesFeedStatus = {
  status:   "live";
  provider: "TwelveData";
  symbols:  readonly string[];
};

export function getIndicesFeedStatus(): IndicesFeedStatus {
  return {
    status:   "live",
    provider: "TwelveData",
    symbols:  INDICES_SYMBOLS,
  };
}

export default getIndicesFeedStatus;
