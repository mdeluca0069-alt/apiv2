export type LiquiditySelectorResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createLiquiditySelector(): LiquiditySelectorResult {
  return {
    module: "Liquidity Selector",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const LiquiditySelector = createLiquiditySelector();

export default LiquiditySelector;
