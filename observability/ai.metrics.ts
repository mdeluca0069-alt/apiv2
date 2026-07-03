/**
 * observability/ai.metrics.ts
 */

import { EventEmitter }  from "node:events";
import { eventBus }      from "../events-bus/event.bus.js";
import { metrics }       from "../shared/metrics.js";

const _eb = eventBus as EventEmitter;

export function initAIMetrics(): void {

  // ── AI service requests (custom events not in BrokerEventMap) ─────────────

  _eb.on("ai.request.started", (evt: { type?: string }) => {
    metrics.incL("igfx_ai_requests_total", { type: evt.type ?? "chat", status: "started" });
  });

  _eb.on("ai.request.completed", (evt: { type?: string; durationMs?: number; inputTokens?: number; outputTokens?: number }) => {
    const opType = evt.type ?? "chat";
    metrics.incL("igfx_ai_requests_total", { type: opType, status: "completed" });
    if (typeof evt.durationMs === "number") {
      metrics.observeL("igfx_ai_latency_ms", { type: opType }, evt.durationMs);
    }
    if (typeof evt.inputTokens  === "number") metrics.incL("igfx_ai_tokens_total", { direction: "input",  type: opType }, evt.inputTokens);
    if (typeof evt.outputTokens === "number") metrics.incL("igfx_ai_tokens_total", { direction: "output", type: opType }, evt.outputTokens);
  });

  _eb.on("ai.request.error", (evt: { type?: string; errorType?: string }) => {
    metrics.incL("igfx_ai_errors_total",   { type: evt.type ?? "chat", error: evt.errorType ?? "unknown" });
    metrics.incL("igfx_ai_requests_total", { type: evt.type ?? "chat", status: "error" });
  });

  _eb.on("ai.cache.hit", (evt: { type?: string }) => {
    metrics.incL("igfx_ai_cache_hits_total", { type: evt.type ?? "unknown" });
  });

  // ── OLOS Signal generation (existing typed event) ──────────────────────────

  eventBus.on("signal.generated", (evt) => {
    const e = evt as unknown as { symbol?: string; signalType?: string; confidence?: number; marketRegime?: string };
    metrics.incL("igfx_signals_generated_total", {
      symbol: e.symbol ?? "UNKNOWN",
      type:   e.signalType ?? "BUY",
      regime: e.marketRegime ?? "UNKNOWN",
    });
    if (typeof e.confidence === "number") {
      metrics.observeL("igfx_signal_confidence", { symbol: e.symbol ?? "UNKNOWN", type: e.signalType ?? "BUY" }, e.confidence);
    }
  });

  // ── Signal outcomes (custom events) ──────────────────────────────────────

  _eb.on("signal.outcome.win",  (evt: { symbol?: string }) => { metrics.incL("igfx_signal_win_total",  { symbol: evt.symbol ?? "UNKNOWN" }); });
  _eb.on("signal.outcome.loss", (evt: { symbol?: string }) => { metrics.incL("igfx_signal_loss_total", { symbol: evt.symbol ?? "UNKNOWN" }); });
}
