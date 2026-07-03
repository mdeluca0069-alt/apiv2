export type CandlesGeneratorResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createCandlesGenerator(): CandlesGeneratorResult {
  return {
    module: "Candles Generator",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const CandlesGenerator = createCandlesGenerator();

export default CandlesGenerator;
