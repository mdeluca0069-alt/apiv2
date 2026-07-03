/**
 * Stocks Feed — metadata module.
 *
 * Live prices are delivered via the TwelveData WebSocket feed
 * (twelvedata.feed.ts → aggregator.ts → InternalLiquidityCore).
 * Historical candles are seeded at boot by historical.seeder.ts.
 * This module exists to expose symbol metadata and a status helper.
 */

export const STOCKS_SYMBOLS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"] as const;

export const TWELVEDATA_STOCKS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"] as const;

export type StocksFeedStatus = {
  status:   "live";
  provider: "TwelveData";
  symbols:  readonly string[];
};

export function getStocksFeedStatus(): StocksFeedStatus {
  return {
    status:   "live",
    provider: "TwelveData",
    symbols:  STOCKS_SYMBOLS,
  };
}

export default getStocksFeedStatus;
