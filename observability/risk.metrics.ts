/**
 * observability/risk.metrics.ts
 */

import { EventEmitter }  from "node:events";
import { eventBus }      from "../events-bus/event.bus.js";
import { metrics }       from "../shared/metrics.js";
import { globalRiskSupervisor } from "../risk-service/global.risk.supervisor.js";

const _eb = eventBus as EventEmitter;

const SUPERVISOR_MODE_CODES: Record<string, number> = {
  NORMAL: 0, SAFE_MODE: 1, EMERGENCY_MODE: 2, FULL_AUTOPILOT_STOP: 3,
};

export function initRiskMetrics(): void {

  // ── Pre-trade risk checks (custom events) ─────────────────────────────────

  _eb.on("risk.pretrade.passed", (evt: { symbol?: string; durationMs?: number }) => {
    metrics.incL("igfx_risk_pretrade_checks_total", { result: "pass", symbol: evt.symbol ?? "UNKNOWN" });
    if (typeof evt.durationMs === "number") {
      metrics.observeL("igfx_risk_pretrade_latency_ms", {}, evt.durationMs);
    }
  });

  _eb.on("risk.pretrade.failed", (evt: { symbol?: string; reason?: string }) => {
    metrics.incL("igfx_risk_pretrade_checks_total", {
      result:   "fail",
      category: inferRiskCategory(evt.reason ?? ""),
      symbol:   evt.symbol ?? "UNKNOWN",
    });
  });

  // ── Kill switch (custom events) ────────────────────────────────────────────

  _eb.on("kill_switch.activated", () => {
    metrics.inc("kill_switch_activations_total");
    metrics.set("igfx_kill_switch_active", 1);
  });

  _eb.on("kill_switch.deactivated", () => {
    metrics.set("igfx_kill_switch_active", 0);
  });

  // ── Stop-out ───────────────────────────────────────────────────────────────

  _eb.on("stopout.triggered", (evt: { symbol?: string; durationMs?: number }) => {
    metrics.inc("stop_out_events_total");
    if (typeof evt.durationMs === "number") metrics.observe("stopout_duration_ms", evt.durationMs);
  });

  // ── Margin warning (existing typed event) ─────────────────────────────────

  eventBus.on("risk.warning", () => {
    metrics.incL("igfx_risk_pretrade_checks_total", { result: "margin_warning", symbol: "SYSTEM" });
  });

  // ── Margin utilization ─────────────────────────────────────────────────────

  _eb.on("margin.state_updated", (evt: { marginUsed?: number; equity?: number }) => {
    if (evt.marginUsed != null && evt.equity && evt.equity > 0) {
      metrics.observe("igfx_margin_utilization_pct", (evt.marginUsed / evt.equity) * 100);
    }
  });

  // ── Supervisor mode sync (periodic) ───────────────────────────────────────

  _eb.on("risk_supervisor.mode_changed", (evt: { mode?: string }) => {
    metrics.set("igfx_supervisor_mode", SUPERVISOR_MODE_CODES[evt.mode ?? "NORMAL"] ?? 0);
  });

  setInterval(() => {
    try {
      const mode = globalRiskSupervisor.getMode();
      metrics.set("igfx_supervisor_mode", SUPERVISOR_MODE_CODES[mode] ?? 0);
    } catch { /* non-fatal */ }
  }, 30_000).unref();
}

function inferRiskCategory(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("margin"))   return "margin";
  if (r.includes("position")) return "position_limit";
  if (r.includes("exposure")) return "exposure";
  if (r.includes("notional")) return "notional";
  if (r.includes("symbol"))   return "symbol";
  if (r.includes("kill"))     return "kill_switch";
  return "other";
}
