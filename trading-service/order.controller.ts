import { riskEngine }           from "../risk-service/risk.engine.js";
import { executionEngine }      from "../execution-service/execution.engine.js";
import { executionQueue }       from "../execution-service/execution.queue.js";
import type { CancelToken }     from "../execution-service/execution.queue.js";
import { orderLifecycle, DuplicateOrderError } from "./order.lifecycle.js";
import { buildSubmissionKey, isDuplicateSubmission } from "./order.dedup.guard.js";
import { pendingOrderBook }     from "./pending.order.book.js";
import { positionPriceMonitor, PositionMonitorCapacityError } from "./position.price.monitor.js";
import { tradingSuspension }    from "../shared/trading.suspension.js";
import { feedCircuit }          from "../shared/feed.circuit.js";
import { eventBus }             from "../events-bus/event.bus.js";
import { quoteCache }           from "../market-data/quote.cache.js";
import { brokerSpreadConfig }   from "../liquidity-engine/broker.spread.config.js";
import type { NewOrderRequest, OrderAck } from "../shared/contracts.js";
import type { PendingOrder }    from "./pending.order.book.js";

type PlaceOrderContext = {
  userId:   string;
  tenantId: string;
};

export class OrderController {
  /**
   * Place an order — routes by type:
   *   MARKET → immediate execution pipeline
   *   LIMIT / STOP / STOP_LIMIT / TRAILING_STOP → resting order book
   */
  async placeOrder(req: NewOrderRequest, ctx: PlaceOrderContext): Promise<OrderAck> {
    const symbol = req.symbol.toUpperCase();
    const type   = (req.type ?? "MARKET").toUpperCase();

    // ── Fix #2: short-window duplicate-submission guard ─────────────────────
    // Closes the gap left by clientOrderId-based dedup when a UI bug fires two
    // distinct requests (two distinct generated IDs) for what was a single
    // user action. See order.dedup.guard.ts for the full rationale.
    const dedupKey = buildSubmissionKey(ctx.userId, req);
    if (isDuplicateSubmission(dedupKey)) {
      return this._rejectedAck(
        symbol, req.side,
        "DUPLICATE_SUBMISSION_WINDOW: identical order was just submitted a moment ago — ignored to prevent an accidental double order",
      );
    }

    // ── Feed circuit breaker — block orders when all data feeds are dead ──────
    if (feedCircuit.isOpen()) {
      throw Object.assign(
        new Error("FEED_CIRCUIT_OPEN: all market data feeds offline — orders blocked until feed recovers"),
        { statusCode: 503, data: { reason: "FEED_CIRCUIT_OPEN" } },
      );
    }

    // ── P0-5: Trading suspension check — must run before anything else ─────
    if (tradingSuspension.isSuspended(ctx.userId)) {
      const record = tradingSuspension.getSuspension(ctx.userId);
      throw Object.assign(
        new Error(`TRADING_SUSPENDED: account suspended pending admin review — ${record?.reason ?? "margin deficit"}`),
        { statusCode: 423, data: { reason: record?.reason, suspendedAt: record?.suspendedAt } },
      );
    }

    // ── 1. Resolve current quote ────────────────────────────────────────────
    // Policy: trade off the last known REAL price even if the live feed has
    // gone stale (TwelveData/Finnhub free-tier plans don't cover every
    // instrument — e.g. indices/commodities). A stale quote still reflects
    // the last real market tick, so we degrade gracefully instead of hard-
    // blocking orders. feedHealthMonitor/alertManager still raise
    // MARKET_DATA_OUTAGE alerts for monitoring — staleness is observed, not
    // hidden, just no longer fatal to trading.
    const quote = quoteCache.get(symbol);
    if (!quote) {
      return this._rejectedAck(symbol, req.side, "NO_LIVE_MARKET_DATA: instrument not in live feed");
    }
    if (!brokerSpreadConfig.isEnabled(symbol)) {
      return this._rejectedAck(symbol, req.side, "INSTRUMENT_DISABLED: symbol is halted for new orders");
    }
    if (quote.spread === 0) {
      return this._rejectedAck(symbol, req.side, "NO_VALID_SPREAD: no spread configured — admin must set broker spread for this symbol");
    }

    // ── 2. Pre-trade risk pipeline ──────────────────────────────────────────
    const riskResult = await riskEngine.preTradeCheck({
      userId:         ctx.userId,
      symbol,
      side:           req.side,
      quantity:       req.quantity,
      requestedPrice: req.price,
      leverage:       req.leverage ?? 1,
      clientOrderId:  req.clientOrderId,
      midPrice:       quote.mid,
    });

    if (!riskResult.pass) {
      const order = await orderLifecycle.create({
        userId:          ctx.userId,
        symbol,
        side:            req.side,
        type:            type as "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | "TRAILING_STOP",
        quantity:        req.quantity,
        requestedPrice:  req.price,
        leverage:        req.leverage ?? 1,
        stopLoss:        req.stopLoss,
        takeProfit:      req.takeProfit,
        notional:        0,
        marginRequired:  0,
        clientOrderId:   req.clientOrderId,
        riskCheckResult: { pass: false, reason: riskResult.reason, detail: riskResult.detail },
      });

      await orderLifecycle.rejectOrder(order.id, `${riskResult.reason}: ${riskResult.detail}`);

      eventBus.emit("order.rejected", {
        orderId:   order.id,
        userId:    ctx.userId,
        symbol,
        reason:    `${riskResult.reason}: ${riskResult.detail}`,
        timestamp: new Date().toISOString(),
      });

      return {
        id:              order.id,
        clientOrderId:   req.clientOrderId,
        symbol,
        side:            req.side,
        type:            req.type ?? "MARKET",
        quantity:        req.quantity,
        status:          "REJECTED",
        rejectionReason: `${riskResult.reason}: ${riskResult.detail}`,
        marginRequired:  0,
        notional:        0,
        createdAt:       order.createdAt.toISOString(),
      };
    }

    // ── 3. MARKET order → execute via per-user queue (prevents margin races) ──
    if (type === "MARKET") {
      // P0-3: Reject before queue if position monitor is at capacity
      if (positionPriceMonitor.isAtCapacity()) {
        return this._rejectedAck(symbol, req.side,
          "MONITOR_CAPACITY_EXCEEDED: system position limit reached — please try again later"
        );
      }

      const queued = await executionQueue.enqueue(ctx.userId, (ct) =>
        this._executeMarket(req, ctx.userId, quote, riskResult, ct)
      );
      if (!queued.ok) {
        // P0-1: Surface duplicate-order errors as 409 (they propagate as EXECUTION_ERROR)
        if (queued.reason === "EXECUTION_ERROR" && queued.error instanceof DuplicateOrderError) {
          throw Object.assign(new Error(queued.error.message), {
            statusCode: 409,
            data: { existingOrder: queued.error.existingOrder },
          });
        }
        let reason: string;
        if (queued.reason === "QUEUE_FULL") {
          reason = "TOO_MANY_ORDERS: order queue limit reached";
        } else if (queued.reason === "EXECUTION_ERROR") {
          // Surface the real error instead of masking it as a timeout
          reason = `EXECUTION_ERROR: ${queued.error?.message ?? "unknown internal error"}`;
          console.error("[order-controller] EXECUTION_ERROR for user", ctx.userId, queued.error);
        } else {
          reason = "EXECUTION_TIMEOUT: system busy, try again";
        }
        return this._rejectedAck(symbol, req.side, reason);
      }
      return queued.result;
    }

    // ── 4. Resting order types → park in order book ─────────────────────────
    try {
      return await this._parkPendingOrder(req, ctx.userId, quote, riskResult, type);
    } catch (err) {
      // P0-1: Surface duplicate resting-order errors as 409
      if (err instanceof DuplicateOrderError) {
        throw Object.assign(new Error(err.message), {
          statusCode: 409,
          data: { existingOrder: err.existingOrder },
        });
      }
      throw err;
    }
  }

  /**
   * Execute a previously-triggered pending order (called by order.trigger.watcher).
   * Skips risk check — margin was already reserved when the order was placed.
   */
  async executePendingOrder(pending: PendingOrder, execPrice: number): Promise<void> {
    const quote = quoteCache.get(pending.symbol);
    if (!quote)                               throw new Error(`No quote for ${pending.symbol}`);
    if (!brokerSpreadConfig.isEnabled(pending.symbol)) throw new Error(`INSTRUMENT_DISABLED: ${pending.symbol} is halted`);
    if (quote.spread === 0)                   throw new Error(`NO_VALID_SPREAD: ${pending.symbol} has zero spread`);

    // Use a synthetic quote at the trigger price to get exact fill
    const syntheticQuote = {
      ...quote,
      bid: pending.side === "SELL" ? execPrice : quote.bid,
      ask: pending.side === "BUY"  ? execPrice : quote.ask,
      mid: execPrice,
    };

    const result = await executionEngine.execute(
      {
        orderId:        pending.orderId,
        userId:         pending.userId,
        symbol:         pending.symbol,
        side:           pending.side,
        type:           "MARKET", // pending order fires as market fill
        quantity:       pending.quantity,
        requestedPrice: pending.triggerPrice,
        leverage:       pending.leverage,
        stopLoss:       pending.stopLoss,
        takeProfit:     pending.takeProfit,
        marginRequired: pending.marginRequired,
        notional:       pending.notional,
      },
      syntheticQuote,
    );

    if (result.status === "REJECTED") {
      const reason = (result as { reason?: string }).reason ?? "UNKNOWN";
      throw new Error(`Pending order execution rejected: ${reason}`);
    }

    // PARTIALLY_FILLED: position was opened for the filled portion.
    // Re-queue the remainder as a new resting order at the current execution price.
    // Margin for the full original quantity was already locked — the remainder's share
    // is passed through so the pending book record stays accurate for display and release.
    if (result.status === "PARTIALLY_FILLED") {
      const remainingQty = (result as { remainingQuantity?: number }).remainingQuantity ?? 0;
      if (remainingQty > 0) {
        await pendingOrderBook.add({
          orderId:        pending.orderId,
          userId:         pending.userId,
          symbol:         pending.symbol,
          side:           pending.side,
          type:           pending.type,
          quantity:       remainingQty,
          triggerPrice:   execPrice,
          limitPrice:     pending.limitPrice,
          trailAmount:    pending.trailAmount,
          leverage:       pending.leverage,
          stopLoss:       pending.stopLoss,
          takeProfit:     pending.takeProfit,
          marginRequired: pending.marginRequired * (remainingQty / pending.quantity),
          notional:       pending.notional   * (remainingQty / pending.quantity),
          clientOrderId:  pending.clientOrderId,
        });
        console.log(
          `[order-controller] PARTIAL_FILL remainder re-queued: ` +
          `orderId=${pending.orderId} filled=${result.filledQuantity} ` +
          `remaining=${remainingQty} re-trigger@${execPrice}`,
        );
      }
    }
    // FILLED: normal completion — no further action needed
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private async _executeMarket(
    req:         NewOrderRequest,
    userId:      string,
    quote:       { bid: number; ask: number; mid: number; symbol: string; spread: number; changePct: number; ts?: string },
    riskResult:  { pass: true; effectiveLeverage: number; marginRequired: number; notional: number },
    cancelToken?: CancelToken,
  ): Promise<OrderAck> {
    const symbol = req.symbol.toUpperCase();

    const order = await orderLifecycle.create({
      userId,
      symbol,
      side:            req.side,
      type:            "MARKET",
      quantity:        req.quantity,
      requestedPrice:  req.price,
      leverage:        riskResult.effectiveLeverage,
      stopLoss:        req.stopLoss,
      takeProfit:      req.takeProfit,
      notional:        riskResult.notional,
      marginRequired:  riskResult.marginRequired,
      clientOrderId:   req.clientOrderId,
      riskCheckResult: {
        pass:              true,
        effectiveLeverage: riskResult.effectiveLeverage,
        marginRequired:    riskResult.marginRequired,
        notional:          riskResult.notional,
      },
    });

    const execResult = await executionEngine.execute(
      {
        orderId:        order.id,
        userId,
        symbol,
        side:           req.side,
        type:           "MARKET",
        quantity:       req.quantity,
        requestedPrice: req.price,
        leverage:       riskResult.effectiveLeverage,
        stopLoss:       req.stopLoss,
        takeProfit:     req.takeProfit,
        marginRequired: riskResult.marginRequired,
        notional:       riskResult.notional,
      },
      quote,
      cancelToken,
    );

    if (execResult.status === "REJECTED") {
      return {
        id:              order.id,
        clientOrderId:   req.clientOrderId,
        symbol,
        side:            req.side,
        type:            "MARKET",
        quantity:        req.quantity,
        status:          "REJECTED",
        rejectionReason: execResult.reason,
        marginRequired:  riskResult.marginRequired,
        notional:        riskResult.notional,
        createdAt:       order.createdAt.toISOString(),
      };
    }

    // Partial fill: position was created for filledQuantity; re-queue remainder
    // is the caller's responsibility via a new order or LP retry loop.
    if (execResult.status === "PARTIALLY_FILLED") {
      if (execResult.positionId) {
        try { await positionPriceMonitor.addPosition(execResult.positionId); }
        catch { /* non-fatal — partial position lacks SL/TP monitoring */ }
      }
      return {
        id:               order.id,
        clientOrderId:    req.clientOrderId,
        symbol,
        side:             req.side,
        type:             "MARKET",
        quantity:         req.quantity,
        requestedPrice:   req.price,
        averageFillPrice: execResult.averageFillPrice,
        status:           "PARTIALLY_FILLED",
        marginRequired:   riskResult.marginRequired,
        notional:         riskResult.notional,
        createdAt:        order.createdAt.toISOString(),
      };
    }

    // P0-6: Await monitor registration — SL/TP is only enforced once this completes.
    // A PositionMonitorCapacityError here means the position exists and is live,
    // but SL/TP will not be auto-triggered. Log CRITICAL; the position is still valid.
    if (execResult.positionId) {
      try {
        await positionPriceMonitor.addPosition(execResult.positionId);
      } catch (monitorErr) {
        if (monitorErr instanceof PositionMonitorCapacityError) {
          console.error(
            `[order-controller] CRITICAL: position monitor at capacity — positionId=${execResult.positionId} ` +
            `userId=${userId} — SL/TP will NOT be auto-triggered for this position. Admin action required.`
          );
          // Cast needed: eventBus is strictly typed and risk.warning payload
          // does not include positionId/symbol in its base interface.
          // The RiskWarningEvent is extended here for operational alerting.
          (eventBus.emit as (...args: unknown[]) => void)("risk.warning", {
            userId,
            positionId: execResult.positionId,
            symbol,
            severity:   "CRITICAL",
            reason:     "POSITION_MONITOR_CAPACITY_EXCEEDED",
            message:    "Position SL/TP monitoring is disabled due to system capacity limit",
            timestamp:  new Date().toISOString(),
          });
        } else {
          console.error(
            `[order-controller] WARNING: position monitor addPosition failed pos=${execResult.positionId}:`,
            (monitorErr as Error).message,
          );
        }
      }
    }

    return {
      id:               order.id,
      clientOrderId:    req.clientOrderId,
      symbol,
      side:             req.side,
      type:             "MARKET",
      quantity:         req.quantity,
      requestedPrice:   req.price,
      averageFillPrice: execResult.averageFillPrice,
      status:           "FILLED",
      marginRequired:   riskResult.marginRequired,
      notional:         riskResult.notional,
      createdAt:        order.createdAt.toISOString(),
    };
  }

  private async _parkPendingOrder(
    req:        NewOrderRequest,
    userId:     string,
    quote:      { bid: number; ask: number; mid: number },
    riskResult: { pass: true; effectiveLeverage: number; marginRequired: number; notional: number },
    type:       string,
  ): Promise<OrderAck> {
    const symbol = req.symbol.toUpperCase();
    const price  = req.price ?? quote.mid;

    const order = await orderLifecycle.create({
      userId,
      symbol,
      side:            req.side,
      type:            type as "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | "TRAILING_STOP",
      quantity:        req.quantity,
      requestedPrice:  price,
      leverage:        riskResult.effectiveLeverage,
      stopLoss:        req.stopLoss,
      takeProfit:      req.takeProfit,
      notional:        riskResult.notional,
      marginRequired:  riskResult.marginRequired,
      clientOrderId:   req.clientOrderId,
      riskCheckResult: {
        pass:              true,
        effectiveLeverage: riskResult.effectiveLeverage,
        marginRequired:    riskResult.marginRequired,
        notional:          riskResult.notional,
      },
    });

    // Transition to ACCEPTED (resting, not yet filled)
    await orderLifecycle.transition(order.id, "ACCEPTED",
      `Resting ${type} order @ ${price} — waiting for trigger`, "SYSTEM");

    // Compute trailing trail amount if applicable
    const trailAmount = type === "TRAILING_STOP"
      ? (req.price ? Math.abs(quote.mid - req.price) : 0.0010)
      : undefined;

    try {
      await pendingOrderBook.add({
        orderId:        order.id,
        userId,
        symbol,
        side:           req.side as "BUY" | "SELL",
        type:           type as import("./pending.order.book.js").PendingOrderType,
        quantity:       req.quantity,
        triggerPrice:   price,
        limitPrice:     type === "STOP_LIMIT" ? req.price : undefined,
        trailAmount,
        leverage:       riskResult.effectiveLeverage,
        stopLoss:       req.stopLoss,
        takeProfit:     req.takeProfit,
        marginRequired: riskResult.marginRequired,
        notional:       riskResult.notional,
        clientOrderId:  req.clientOrderId,
        expiresAt:      req.expiresAt ? new Date(req.expiresAt) : undefined,
      });
    } catch (addErr) {
      // P0-2: If persistence fails after retries, reject the order so the
      // client knows their resting order was NOT safely stored.
      await orderLifecycle.rejectOrder(order.id, `PENDING_PERSIST_FAILED: ${(addErr as Error).message}`).catch(() => {});
      return {
        id:              order.id,
        clientOrderId:   req.clientOrderId,
        symbol,
        side:            req.side,
        type:            req.type ?? "LIMIT",
        quantity:        req.quantity,
        requestedPrice:  price,
        status:          "REJECTED",
        rejectionReason: "PENDING_ORDER_STORAGE_FAILURE: order could not be durably persisted — please retry",
        marginRequired:  riskResult.marginRequired,
        notional:        riskResult.notional,
        createdAt:       order.createdAt.toISOString(),
      };
    }

    eventBus.emit("order.pending", {
      orderId:      order.id,
      userId,
      symbol,
      side:         req.side,
      type,
      quantity:     req.quantity,
      triggerPrice: price,
      timestamp:    new Date().toISOString(),
    });

    return {
      id:             order.id,
      clientOrderId:  req.clientOrderId,
      symbol,
      side:           req.side,
      type:           req.type ?? "LIMIT",
      quantity:       req.quantity,
      requestedPrice: price,
      status:         "ACCEPTED",
      marginRequired: riskResult.marginRequired,
      notional:       riskResult.notional,
      createdAt:      order.createdAt.toISOString(),
    };
  }

  private _rejectedAck(symbol: string, side: "BUY" | "SELL", reason: string): OrderAck {
    return {
      id:              `rej-${Date.now()}`,
      symbol,
      side,
      type:            "MARKET",
      quantity:        0,
      status:          "REJECTED",
      rejectionReason: reason,
      marginRequired:  0,
      notional:        0,
      createdAt:       new Date().toISOString(),
    };
  }
}

export const orderController = new OrderController();
