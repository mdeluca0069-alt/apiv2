export type MarketNormalizerResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createMarketNormalizer(): MarketNormalizerResult {
  return {
    module: "Market Normalizer",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const MarketNormalizer = createMarketNormalizer();

export default MarketNormalizer;
