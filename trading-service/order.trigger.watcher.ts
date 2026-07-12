import { pendingOrderBook } from "./pending.order.book.js";
import { orderController }  from "./order.controller.js";
import { orderLifecycle }   from "./order.lifecycle.js";
import { eventBus }         from "../events-bus/event.bus.js";
import type { PendingOrder } from "./pending.order.book.js";

/** How long an armed LIMIT leg may rest before it is auto-expired. Default: 1 hour. */
export const STOP_LIMIT_TTL_MS = Number(process.env.STOP_LIMIT_TTL_MS ?? 3_600_000);

/**
 * OrderTriggerWatcher — evaluates resting orders on every price tick.
 *
 * Runs as an event subscriber (no polling) — triggered by `quote.updated` events.
 *
 * Trigger logic per order type:
 *   LIMIT       BUY  → fill when ask ≤ limit price
 *   LIMIT       SELL → fill when bid ≥ limit price
 *   STOP        BUY  → fill when ask ≥ stop price (break-out)
 *   STOP        SELL → fill when bid ≤ stop price (break-out)
 *   STOP_LIMIT  BUY  → trigger when ask ≥ stop; then place limit buy at limitPrice
 *   STOP_LIMIT  SELL → trigger when bid ≤ stop; then place limit sell at limitPrice
 *   TRAILING_STOP    → stop level updates on ticks (book handles); triggers same as STOP
 *
 * Partial fill: the execution engine fills the full quantity at trigger price.
 * True partial fill (split across multiple price levels) is handled by fill.engine.ts.
 */
class OrderTriggerWatcher {
  private active = false;

  start(): void {
    if (this.active) return;
    this.active = true;

    // Subscribe to every quote tick from the internal liquidity core
    eventBus.on("market.quote", (q) => {
      if (!q?.symbol) return;
      void this._evaluate(q.symbol, q.bid, q.ask);
    });

    console.log("[trigger-watcher] started — watching pending orders on market.quote");
  }

  stop(): void {
    this.active = false;
  }

  private async _evaluate(symbol: string, bid: number, ask: number): Promise<void> {
    // Update trailing stops first (adjusts trigger levels in-place)
    pendingOrderBook.updateTrailingStops(symbol, bid, ask);

    const orders = pendingOrderBook.getBySymbol(symbol);
    if (!orders.length) return;

    for (const order of orders) {
      const triggered = this._isTriggered(order, bid, ask);
      if (!triggered) continue;

      const pending = pendingOrderBook.markTriggered(order.id);
      if (!pending) continue;

      // FASE 3.6: OCO — this leg just triggered, so cancel its sibling now
      // (not after confirmed fill: a genuine trigger commits this leg,
      // regardless of whether the downstream fill/arm later succeeds).
      await pendingOrderBook.cancelOcoSiblingsOnTrigger(pending.id, pending.ocoGroupId);

      // For STOP_LIMIT: place a new LIMIT order at limitPrice after trigger
      if (pending.type === "STOP_LIMIT" && pending.limitPrice !== undefined) {
        await this._dispatchLimitAfterTrigger(pending);
      } else {
        await this._fillPendingOrder(pending, bid, ask);
      }
    }
  }

  private _isTriggered(order: PendingOrder, bid: number, ask: number): boolean {
    switch (order.type) {
      case "LIMIT":
        return order.side === "BUY"
          ? ask <= order.triggerPrice
          : bid >= order.triggerPrice;

      case "STOP":
      case "TRAILING_STOP":
        return order.side === "BUY"
          ? ask >= order.triggerPrice
          : bid <= order.triggerPrice;

      case "STOP_LIMIT":
        return order.side === "BUY"
          ? ask >= order.triggerPrice
          : bid <= order.triggerPrice;

      default:
        return false;
    }
  }

  private async _fillPendingOrder(pending: PendingOrder, bid: number, ask: number): Promise<void> {
    const execPrice = pending.side === "BUY" ? ask : bid;

    try {
      await orderController.executePendingOrder(pending, execPrice);

      eventBus.emit("order.triggered", {
        pendingId:  pending.id,
        orderId:    pending.orderId,
        userId:     pending.userId,
        symbol:     pending.symbol,
        side:       pending.side,
        type:       pending.type,
        execPrice,
        timestamp:  new Date().toISOString(),
        clientOrderId: pending.clientOrderId,
      });
    } catch (err) {
      console.error(`[trigger-watcher] failed to execute triggered order ${pending.id}:`,
        (err as Error).message);

      eventBus.emit("order.trigger_failed", {
        pendingId: pending.id,
        orderId:   pending.orderId,
        userId:    pending.userId,
        reason:    (err as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private async _dispatchLimitAfterTrigger(pending: PendingOrder): Promise<void> {
    // STOP_LIMIT: after stop triggers, place a new resting LIMIT order with TTL.
    // The Order DB row is transitioned to LIMIT_ARMED so the lifecycle is auditable.
    try {
      // ── 1. Transition parent Order to LIMIT_ARMED ────────────────────────
      await orderLifecycle.transition(
        pending.orderId,
        "LIMIT_ARMED",
        `STOP triggered @ ${pending.triggerPrice} — LIMIT armed @ ${pending.limitPrice}` +
        ` (TTL ${STOP_LIMIT_TTL_MS / 60_000} min)`,
        "SYSTEM",
      );

      // ── 2. Add armed LIMIT to pending book with expiry TTL ───────────────
      await pendingOrderBook.add({
        orderId:           pending.orderId,
        userId:            pending.userId,
        symbol:            pending.symbol,
        side:              pending.side,
        type:              "LIMIT",
        quantity:          pending.quantity,
        triggerPrice:      pending.limitPrice!,
        leverage:          pending.leverage,
        stopLoss:          pending.stopLoss,
        takeProfit:        pending.takeProfit,
        marginRequired:    pending.marginRequired,
        notional:          pending.notional,
        clientOrderId:     pending.clientOrderId,
        armedByStopLimit:  true,
        expiresAt:         new Date(Date.now() + STOP_LIMIT_TTL_MS),
      });

      eventBus.emit("order.stop_limit_armed", {
        parentPendingId: pending.id,
        orderId:         pending.orderId,
        userId:          pending.userId,
        symbol:          pending.symbol,
        limitPrice:      pending.limitPrice,
        timestamp:       new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[trigger-watcher] failed to arm STOP_LIMIT order ${pending.id}:`,
        (err as Error).message);
      // If we fail to arm, mark the order as expired so it doesn't stay ACCEPTED forever
      try {
        await orderLifecycle.transition(
          pending.orderId, "LIMIT_EXPIRED",
          `STOP_LIMIT arm failed: ${(err as Error).message}`, "SYSTEM",
        );
      } catch { /* non-fatal — already logged above */ }
    }
  }
}

export const orderTriggerWatcher = new OrderTriggerWatcher();
export default orderTriggerWatcher;
