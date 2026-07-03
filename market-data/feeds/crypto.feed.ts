/**
 * Crypto Feed — metadata module.
 *
 * Live prices are delivered via the TwelveData WebSocket feed
 * (twelvedata.feed.ts → aggregator.ts → InternalLiquidityCore).
 * Historical candles are seeded at boot by historical.seeder.ts.
 * This module exists to expose symbol metadata and a status helper.
 */

export const CRYPTO_SYMBOLS = ["BTCUSD", "ETHUSD"] as const;

export const TWELVEDATA_CRYPTO = ["BTC/USD", "ETH/USD"] as const;

export type CryptoFeedStatus = {
  status:   "live";
  provider: "TwelveData";
  symbols:  readonly string[];
};

export function getCryptoFeedStatus(): CryptoFeedStatus {
  return {
    status:   "live",
    provider: "TwelveData",
    symbols:  CRYPTO_SYMBOLS,
  };
}

export default getCryptoFeedStatus;
