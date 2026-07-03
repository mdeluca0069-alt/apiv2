/**
 * observability/trading.metrics.ts
 */

import { EventEmitter } from "node:events";
import { eventBus }    from "../events-bus/event.bus.js";
import type { OrderFilledEvent, OrderRejectedEvent, PositionOpenedEvent, PositionClosedEvent, OrderStatusChangedEvent } from "../events-bus/event.bus.js";
import { metrics }     from "../shared/metrics.js";
import { IS_PERSISTENT, prisma } from "../shared/db.js";

const _eb = eventBus as EventEmitter;
const _orderStartMs = new Map<string, number>();

export function initTradingMetrics(): void {

  // ── Order lifecycle ────────────────────────────────────────────────────────

  _eb.on("order.placed", (evt: { orderId: string; symbol: string; side: string; type?: string }) => {
    _orderStartMs.set(evt.orderId, Date.now());
    metrics.incL("igfx_orders_total", { symbol: evt.symbol, side: evt.side, type: evt.type ?? "MARKET", status: "placed" });
    metrics.inc("orders_placed_total");
  });

  eventBus.on("order.filled", (evt: OrderFilledEvent) => {
    const started = _orderStartMs.get(evt.orderId);
    if (started) {
      const duration = Date.now() - started;
      metrics.observeL("igfx_order_duration_ms", { symbol: evt.symbol }, duration);
      metrics.observe("order_duration_ms", duration);
      _orderStartMs.delete(evt.orderId);
    }
    metrics.incL("igfx_orders_total", { symbol: evt.symbol, side: evt.side, status: "filled" });
    metrics.inc("orders_filled_total");
  });

  eventBus.on("order.rejected", (evt: OrderRejectedEvent) => {
    _orderStartMs.delete(evt.orderId);
    metrics.incL("igfx_orders_total", { symbol: evt.symbol ?? "UNKNOWN", side: "UNKNOWN", status: "rejected" });
    metrics.inc("orders_rejected_total");
  });

  eventBus.on("order.status_changed", (evt: OrderStatusChangedEvent) => {
    if (evt.status === "CANCELLED") _orderStartMs.delete(evt.orderId);
  });

  // ── Position lifecycle ─────────────────────────────────────────────────────

  eventBus.on("position.opened", (evt: PositionOpenedEvent) => {
    metrics.incL("igfx_positions_open_total", { symbol: evt.symbol, side: evt.side });
    metrics.inc("positions_opened_total");
    metrics.inc("positions_open_gauge");
  });

  eventBus.on("position.closed", (_evt: PositionClosedEvent) => {
    metrics.inc("positions_closed_total");
    metrics.inc("positions_open_gauge", -1);
  });

  // ── Stop-loss / take-profit (custom events, not in BrokerEventMap) ────────

  _eb.on("position.stop_loss_hit", (evt: { symbol?: string; side?: string }) => {
    metrics.inc("stop_loss_triggers_total");
    metrics.incL("igfx_orders_total", { symbol: evt.symbol ?? "UNKNOWN", side: evt.side ?? "UNKNOWN", status: "sl_triggered" });
  });

  _eb.on("position.take_profit_hit", (evt: { symbol?: string; side?: string }) => {
    metrics.inc("take_profit_triggers_total");
    metrics.incL("igfx_orders_total", { symbol: evt.symbol ?? "UNKNOWN", side: evt.side ?? "UNKNOWN", status: "tp_triggered" });
  });

  // ── Settlement ─────────────────────────────────────────────────────────────

  _eb.on("settlement.completed", (evt: { durationMs?: number }) => {
    metrics.inc("settlement_completed_total");
    if (evt.durationMs) metrics.observe("settlement_duration_ms", evt.durationMs);
  });

  _eb.on("settlement.error", () => {
    metrics.inc("settlement_errors_total");
  });

  // ── Margin / stop-out ──────────────────────────────────────────────────────

  _eb.on("margin.call", () => {
    metrics.inc("margin_calls_total");
  });

  // ── Periodic open-position count sync ────────────────────────────────────

  setInterval(async () => {
    if (!IS_PERSISTENT || !prisma) return;
    try {
      const db = prisma as NonNullable<typeof prisma>;
      const [open, autopilot] = await Promise.all([
        db.position.count({ where: { status: "OPEN" } }),
        db.position.count({ where: { status: "OPEN", openedByAutopilot: true } }),
      ]);
      metrics.set("positions_open_gauge", open);
      metrics.set("igfx_autopilot_positions_open", autopilot);
    } catch { /* non-fatal */ }
  }, 30_000).unref();
}
