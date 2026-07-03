export type LatencyMonitorResult = {
  module: string;
  status: "ready";
  generatedAt: string;
};

export function createLatencyMonitor(): LatencyMonitorResult {
  return {
    module: "Latency Monitor",
    status: "ready",
    generatedAt: new Date().toISOString(),
  };
}

export const LatencyMonitor = createLatencyMonitor();

export default LatencyMonitor;
