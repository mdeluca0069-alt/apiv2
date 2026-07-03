/**
 * observability/autopilot.metrics.ts
 */

import { EventEmitter }   from "node:events";
import { eventBus }       from "../events-bus/event.bus.js";
import type { AutopilotExecutedEvent, AutopilotRejectedEvent } from "../events-bus/event.bus.js";
import { metrics }        from "../shared/metrics.js";
import { IS_PERSISTENT, prisma } from "../shared/db.js";
import { globalRiskSupervisor }  from "../risk-service/global.risk.supervisor.js";

const _eb = eventBus as EventEmitter;

export function initAutopilotMetrics(): void {

  // ── Pipeline decisions ─────────────────────────────────────────────────────

  eventBus.on("autopilot.executed", (evt: AutopilotExecutedEvent) => {
    const action = (evt as unknown as { executionAction?: string }).executionAction ?? "PROCEED";
    metrics.incL("igfx_autopilot_decisions_total", { action: "EXECUTED", ei_action: action });
    metrics.inc("igfx_autopilot_daily_trades");

    const score = (evt as unknown as { executionScore?: number }).executionScore;
    if (typeof score === "number") {
      metrics.observeL("igfx_ei_score", { action }, score);
    }
    metrics.incL("igfx_ei_decisions_total", { action });
  });

  _eb.on("autopilot.skipped", (evt: { reason?: string }) => {
    const gate = inferGate(evt.reason ?? "");
    metrics.incL("igfx_autopilot_decisions_total", { action: "SKIPPED", gate });
    metrics.incL("igfx_autopilot_gate_exits_total", { gate, action: "SKIPPED" });
  });

  eventBus.on("autopilot.rejected", (evt: AutopilotRejectedEvent) => {
    const gate = inferGate(evt.reason ?? "");
    metrics.incL("igfx_autopilot_decisions_total", { action: "REJECTED", gate });
    metrics.incL("igfx_autopilot_gate_exits_total", { gate, action: "REJECTED" });
  });

  // ── Config changes ─────────────────────────────────────────────────────────

  _eb.on("autopilot.config_changed", () => {
    void refreshAutopilotUserCount();
  });

  // ── Periodic stats sync ───────────────────────────────────────────────────

  setInterval(() => {
    void refreshAutopilotUserCount();
    try {
      const mode = globalRiskSupervisor.getMode();
      const CODES: Record<string, number> = { NORMAL: 0, SAFE_MODE: 1, EMERGENCY_MODE: 2, FULL_AUTOPILOT_STOP: 3 };
      metrics.set("igfx_supervisor_mode", CODES[mode] ?? 0);
    } catch { /* non-fatal */ }
  }, 60_000).unref();
}

function inferGate(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("confidence"))         return "confidence";
  if (r.includes("symbol"))             return "symbol_filter";
  if (r.includes("supervisor"))         return "risk_supervisor";
  if (r.includes("daily loss"))         return "daily_loss_lock";
  if (r.includes("event lock"))         return "event_lock";
  if (r.includes("daily trade cap"))    return "daily_trade_cap";
  if (r.includes("max open trades"))    return "max_open_trades";
  if (r.includes("drawdown"))           return "drawdown";
  if (r.includes("exposure"))           return "exposure";
  if (r.includes("spread"))             return "spread";
  if (r.includes("no live price"))      return "no_price";
  if (r.includes("not eligible"))       return "eligibility";
  if (r.includes("risk engine"))        return "risk_engine";
  if (r.includes("execution"))          return "execution_intelligence";
  if (r.includes("disabled"))           return "ap_disabled";
  if (r.includes("paused"))             return "ap_paused";
  if (r.includes("kill switch"))        return "kill_switch";
  if (r.includes("neutral"))            return "neutral_signal";
  return "other";
}

async function refreshAutopilotUserCount(): Promise<void> {
  if (!IS_PERSISTENT || !prisma) return;
  try {
    const db = prisma as NonNullable<typeof prisma>;
    const count = await db.autopilotConfig.count({ where: { enabled: true } });
    metrics.set("igfx_autopilot_users_active", count);
  } catch { /* non-fatal */ }
}
