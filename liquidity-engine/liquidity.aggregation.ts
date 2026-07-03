export type LiquidityAggregationResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createLiquidityAggregation(): LiquidityAggregationResult {
  return {
    module: "Liquidity Aggregation",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const LiquidityAggregation = createLiquidityAggregation();

export default LiquidityAggregation;
