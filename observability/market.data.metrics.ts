/**
 * observability/market.data.metrics.ts
 */

import { EventEmitter }      from "node:events";
import { eventBus }          from "../events-bus/event.bus.js";
import type { MarketQuoteEvent } from "../events-bus/event.bus.js";
import { metrics }           from "../shared/metrics.js";
import { feedHealthMonitor } from "../market-data/feed.health.monitor.js";

const _eb = eventBus as EventEmitter;
const _lastTickMs = new Map<string, number>();

export function initMarketDataMetrics(): void {

  eventBus.on("market.quote", (evt: MarketQuoteEvent) => {
    const now = Date.now();
    const last = _lastTickMs.get(evt.symbol);
    metrics.incL("igfx_market_ticks_total", { symbol: evt.symbol });
    metrics.inc("market_data_ticks_total");

    if (last) {
      metrics.observeL("igfx_market_tick_latency_ms", { symbol: evt.symbol }, now - last);
    }
    _lastTickMs.set(evt.symbol, now);

    const spread = (evt as unknown as { spread?: number; bid?: number; ask?: number; mid?: number }).spread;
    const q = evt as unknown as { bid?: number; ask?: number; mid?: number };
    if (q.bid != null && q.ask != null && q.mid && q.mid > 0) {
      const spreadBps = ((q.ask - q.bid) / q.mid) * 10_000;
      metrics.observeL("igfx_market_spread_bps", { symbol: evt.symbol }, spreadBps);
    } else if (spread != null) {
      metrics.observeL("igfx_market_spread_bps", { symbol: evt.symbol }, spread);
    }
  });

  _eb.on("feed.restarted", (evt: { provider?: string }) => {
    metrics.incL("igfx_feed_restarts_total", { provider: evt.provider ?? "unknown" });
    metrics.inc("market_data_feed_restarts");
  });

  _eb.on("feed.circuit_opened", (evt: { symbol?: string }) => {
    metrics.setL("igfx_feed_circuit_open", { symbol: evt.symbol ?? "ALL" }, 1);
  });

  _eb.on("feed.circuit_closed", (evt: { symbol?: string }) => {
    metrics.setL("igfx_feed_circuit_open", { symbol: evt.symbol ?? "ALL" }, 0);
  });

  // ── Periodic feed health snapshot ─────────────────────────────────────────

  setInterval(() => {
    try {
      const snapshot = feedHealthMonitor.getSnapshot();
      let stale = 0;
      for (const [symbol, health] of Object.entries(snapshot)) {
        const age = (health as { quoteAgeMs?: number }).quoteAgeMs ?? 0;
        if (age > 5_000) { stale++; metrics.setL("igfx_market_stale_symbols", { symbol }, 1); }
        else             { metrics.setL("igfx_market_stale_symbols", { symbol }, 0); }
      }
      metrics.set("igfx_market_stale_symbols", stale);
      metrics.set("market_data_stale_symbols", stale);
    } catch { /* non-fatal */ }
  }, 10_000).unref();
}
