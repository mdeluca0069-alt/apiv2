export type MarketCacheResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createMarketCache(): MarketCacheResult {
  return {
    module: "Market Cache",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const MarketCache = createMarketCache();

export default MarketCache;
