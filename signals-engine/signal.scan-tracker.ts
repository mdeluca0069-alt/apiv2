/**
 * Tracks the real wall-clock cadence of the live signal-evaluation loop (main.ts),
 * so API consumers can report an honest "next scan" ETA instead of a fake number
 * when no qualifying signal currently exists.
 */
let intervalMs = 60_000;
let cycleLength = 1;
let lastScanAt = 0;

export function configureScanSchedule(evaluationIntervalMs: number, symbolCount: number): void {
  intervalMs = evaluationIntervalMs;
  cycleLength = Math.max(1, symbolCount);
}

export function recordScan(): void {
  lastScanAt = Date.now();
}

export function getScanSchedule(): { lastScanAt: string | null; nextScanInSec: number } {
  const cycleMs = intervalMs * cycleLength;
  if (!lastScanAt) return { lastScanAt: null, nextScanInSec: Math.round(cycleMs / 1000) };

  const elapsedInCycle = (Date.now() - lastScanAt) % cycleMs;
  return {
    lastScanAt: new Date(lastScanAt).toISOString(),
    nextScanInSec: Math.max(0, Math.round((cycleMs - elapsedInCycle) / 1000)),
  };
}
