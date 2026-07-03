/**
 * Commodities Feed — metadata module.
 *
 * Live prices are delivered via the TwelveData WebSocket feed
 * (twelvedata.feed.ts → aggregator.ts → InternalLiquidityCore).
 * Historical candles are seeded at boot by historical.seeder.ts.
 * This module exists to expose symbol metadata and a status helper.
 */

export const COMMODITIES_SYMBOLS = ["XAUUSD", "WTI", "BRENT"] as const;

export const TWELVEDATA_COMMODITIES = ["XAU/USD", "WTI/USD", "BRENT/USD"] as const;

export type CommoditiesFeedStatus = {
  status:   "live";
  provider: "TwelveData";
  symbols:  readonly string[];
};

export function getCommoditiesFeedStatus(): CommoditiesFeedStatus {
  return {
    status:   "live",
    provider: "TwelveData",
    symbols:  COMMODITIES_SYMBOLS,
  };
}

export default getCommoditiesFeedStatus;
