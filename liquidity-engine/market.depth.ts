export type MarketDepthResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createMarketDepth(): MarketDepthResult {
  return {
    module: "Market Depth",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const MarketDepth = createMarketDepth();

export default MarketDepth;
