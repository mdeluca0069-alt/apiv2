/**
 * Forex Feed — metadata module.
 *
 * Live prices are delivered via the TwelveData WebSocket feed
 * (twelvedata.feed.ts → aggregator.ts → InternalLiquidityCore).
 * Historical candles are seeded at boot by historical.seeder.ts.
 * This module exists to expose symbol metadata and a status helper.
 */

export const FOREX_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "AUDUSD"] as const;

export const TWELVEDATA_FOREX = ["EUR/USD", "GBP/USD", "USD/JPY", "EUR/GBP", "AUD/USD"] as const;

export type ForexFeedStatus = {
  status:   "live";
  provider: "TwelveData";
  symbols:  readonly string[];
};

export function getForexFeedStatus(): ForexFeedStatus {
  return {
    status:   "live",
    provider: "TwelveData",
    symbols:  FOREX_SYMBOLS,
  };
}

export default getForexFeedStatus;
