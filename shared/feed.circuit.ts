/**
 * Feed circuit breaker — shared singleton.
 *
 * Written by FeedManager when all data sources are offline.
 * Read by OrderController to block new order placement during outages.
 * Existing positions continue to be monitored using last known prices.
 *
 * Also tracks real (non-fabricated) process uptime: the % of time since this
 * process booted during which the circuit was CLOSED (feeds healthy). Resets
 * on deploy/restart — that is honest behaviour for a per-instance metric.
 */

let _circuitOpen  = false;
let _openedAt: number | null = null;
let _totalOpenMs  = 0;
const _bootTime    = Date.now();

export const feedCircuit = {
  open(): void {
    if (!_circuitOpen) { _circuitOpen = true; _openedAt = Date.now(); }
  },
  close(): void {
    if (_circuitOpen && _openedAt !== null) {
      _totalOpenMs += Date.now() - _openedAt;
      _openedAt = null;
    }
    _circuitOpen = false;
  },
  isOpen(): boolean { return _circuitOpen; },

  /** Real uptime % since process boot — based on actual circuit-open time, never fabricated. */
  getUptimeStats(): { uptimePercent: number; bootTime: string; totalDowntimeMs: number } {
    const now           = Date.now();
    const liveOpenMs     = _circuitOpen && _openedAt !== null ? now - _openedAt : 0;
    const totalDowntimeMs = _totalOpenMs + liveOpenMs;
    const elapsedMs      = Math.max(1, now - _bootTime);
    const uptimePercent  = Math.max(0, Math.min(100, 100 - (totalDowntimeMs / elapsedMs) * 100));
    return {
      uptimePercent: Number(uptimePercent.toFixed(2)),
      bootTime:      new Date(_bootTime).toISOString(),
      totalDowntimeMs,
    };
  },
};
