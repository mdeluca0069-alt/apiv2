/**
 * Bonds Feed — metadata module.
 *
 * No dedicated bond instruments are currently in the IGFX symbol list.
 * Live prices are delivered via the TwelveData WebSocket feed.
 * Historical candles are seeded at boot by historical.seeder.ts.
 */

export const BONDS_SYMBOLS: readonly string[] = [] as const;

export const TWELVEDATA_BONDS: readonly string[] = [] as const;

export type BondsFeedStatus = {
  status:   "live";
  provider: "TwelveData";
  symbols:  readonly string[];
};

export function getBondsFeedStatus(): BondsFeedStatus {
  return {
    status:   "live",
    provider: "TwelveData",
    symbols:  BONDS_SYMBOLS,
  };
}

export default getBondsFeedStatus;
