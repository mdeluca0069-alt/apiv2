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
      // FASE 3.1: this used to do `Object.entries(snapshot)`, which iterates
      // the snapshot's own top-level keys (checkedAt, circuitOpen,
      // staleSymbols, ...) as if they were [symbol, health] pairs — none of
      // those values have a `quoteAgeMs` property, so `age` was always 0 and
      // this loop never detected a single stale symbol regardless of real
      // feed state. The real per-symbol data is `snapshot.qualityMetrics`
      // (SymbolHealth[], each with `symbol`/`ageMs`). `ageMs` is -1 when a
      // symbol has never received a quote at all — that's the most-stale
      // case, not "0ms old", so it must count as stale too.
      let stale = 0;
      for (const health of snapshot.qualityMetrics) {
        const isStale = health.ageMs < 0 || health.ageMs > 5_000;
        if (isStale) stale++;
        metrics.setL("igfx_market_stale_symbols", { symbol: health.symbol }, isStale ? 1 : 0);
      }
      metrics.set("igfx_market_stale_symbols", stale);
      metrics.set("market_data_stale_symbols", stale);
    } catch { /* non-fatal */ }
  }, 10_000).unref();
}
