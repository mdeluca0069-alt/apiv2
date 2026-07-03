export type SignalRankerResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createSignalRanker(): SignalRankerResult {
  return {
    module: "Signal Ranker",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const SignalRanker = createSignalRanker();

export default SignalRanker;
