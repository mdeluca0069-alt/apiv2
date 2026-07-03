import { randomUUID }      from "node:crypto";
import { Decimal }          from "@prisma/client/runtime/library";
import { prisma }           from "../shared/db.js";
import { eventBus }         from "../events-bus/event.bus.js";
import { fillEngine }       from "./fill.engine.js";
import { orderLifecycle }   from "../trading-service/order.lifecycle.js";
import { marginController } from "../risk-service/margin.controller.js";
import { exposureRegistry } from "../risk-service/exposure.limits.js";
import { metrics }          from "../gateway/metrics.js";
import { reconciliationEngine } from "../settlement/reconciliation.engine.js";
import type { ExecutionRequest, ExecutionResult } from "../shared/contracts.js";
import type { CancelToken }  from "./execution.queue.js";

// Retries releaseMargin up to 5 times with exponential backoff (50→800ms).
// Prevents orphan wallet.locked when the connection pool is momentarily exhausted
// during the window between checkAndLockMargin() committing and createPosition() completing.
async function releaseMarginWithRetry(
  userId: string,
  orderId: string,
  amount: number,
  maxAttempts = 5,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await marginController.releaseMargin(userId, orderId, amount);
      return;
    } catch (err) {
      if (attempt >= maxAttempts) {
        console.error(
          `[execution] CRITICAL: releaseMargin exhausted ${maxAttempts} attempts for order ${orderId} ` +
          `userId=${userId} amount=${amount}. Triggering immediate targeted repair.`,
          (err as Error).message,
        );
        // Immediate targeted reconciliation — do not wait for the 5-min periodic sweep.
        // Fire-and-forget: repairOrphanMargin uses SELECT FOR UPDATE so it is safe to
        // call concurrently; it only releases excess and never over-releases.
        void reconciliationEngine.repairOrphanMargin(userId).then((released) => {
          if (released > 0)
            console.warn(`[execution] orphan repair released ${released.toFixed(2)} for userId=${userId}`);
        }).catch((repairErr) => {
          console.error(`[execution] orphan repair also failed for userId=${userId}:`, (repairErr as Error).message);
          metrics.inc("orphan_margin_unrepaired_total");
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 50 * 2 ** (attempt - 1)));
    }
  }
}

export class ExecutionEngine {
  /**
   * Core execution pipeline.
   *
   * Correct state machine for a MARKET order:
   *   RECEIVED → ACCEPTED → [margin locked] → [position created] → FILLED
   *
   * The FILLED transition is the LAST financial operation, not the first.
   * An order is only FILLED when:
   *   (a) fill price is determined,
   *   (b) margin is atomically locked, AND
   *   (c) the position row exists in the database.
   *
   * This ordering prevents:
   *   - Orders appearing FILLED with no position (crash between transitions)
   *   - FILLED → REJECTED invalid state transitions
   *   - Margin locked with no position (orphan margin)
   */
  async execute(
    req:          ExecutionRequest,
    quote:        { bid: number; ask: number; mid: number; symbol: string; spread: number; changePct: number; ts?: string },
    cancelToken?: CancelToken,
  ): Promise<ExecutionResult> {
    const startMs    = Date.now();
    const cancelled  = () => cancelToken?.value === true;

    // ── 1. Transition RECEIVED → ACCEPTED ────────────────────────────────
    await orderLifecycle.transition(req.orderId, "ACCEPTED",
      "Pre-trade risk passed — routing to IGFX Internal LP", "RISK");

    // ── 2. Calculate fill ─────────────────────────────────────────────────
    // Price source: real TwelveData bid/ask only. Never GBM, never synthetic.
    let fillResult;
    try {
      fillResult = fillEngine.fill(req, quote);
    } catch (err) {
      await orderLifecycle.rejectOrder(req.orderId, "Internal LP fill error — no liquidity");
      return { status: "REJECTED", orderId: req.orderId, reason: "LP_UNAVAILABLE" };
    }

    const execPrice = fillResult.averagePrice;

    // ── Cancel check A — before margin lock ──────────────────────────────
    // Order is ACCEPTED, no money committed. Clean abort.
    if (cancelled()) {
      await orderLifecycle.rejectOrder(req.orderId, "EXECUTION_TIMEOUT: cancelled before margin lock");
      return { status: "REJECTED", orderId: req.orderId, reason: "EXECUTION_TIMEOUT" };
    }

    // ── 3. Atomic margin check-and-lock (Serializable isolation) ─────────
    // Re-validates free margin inside a Serializable transaction, eliminating
    // the race where two concurrent orders both pass the pre-trade margin check.
    // On failure, order stays ACCEPTED → REJECTED (clean transition).
    const marginLock = await marginController.checkAndLockMargin(
      req.userId,
      req.orderId,
      req.marginRequired,
    );
    if (!marginLock.ok) {
      await orderLifecycle.rejectOrder(req.orderId, marginLock.reason);
      return { status: "REJECTED", orderId: req.orderId, reason: "MARGIN_INSUFFICIENT" };
    }

    // ── Cancel check B — after margin lock, before position creation ─────
    // Margin IS locked. Release it before aborting to prevent orphan margin.
    if (cancelled()) {
      await releaseMarginWithRetry(req.userId, req.orderId, req.marginRequired);
      await orderLifecycle.rejectOrder(req.orderId, "EXECUTION_TIMEOUT: cancelled after margin lock");
      return { status: "REJECTED", orderId: req.orderId, reason: "EXECUTION_TIMEOUT" };
    }

    // ── 4. Create position ────────────────────────────────────────────────
    // Position is created BEFORE the order transitions to FILLED/PARTIALLY_FILLED.
    // For a partial fill, we create a position for the filled portion only and
    // lock proportional margin; the unfilled remainder must be re-queued by the
    // caller (see order.controller) or re-triggered on the next tick.
    // If this call fails, marginLock must be rolled back to prevent orphan margin.

    const isPartial      = fillResult.partialFill && fillResult.remainingQuantity > 0;
    const effectiveFill  = fillResult.filledQuantity;
    const effectiveMargin = isPartial
      ? (fillResult.filledQuantity / req.quantity) * req.marginRequired
      : req.marginRequired;

    let positionId: string;
    try {
      positionId = await orderLifecycle.createPosition({
        orderId:    req.orderId,
        userId:     req.userId,
        symbol:     req.symbol,
        side:       req.side,
        quantity:   effectiveFill,
        entryPrice: execPrice,
        markPrice:  execPrice,
        marginUsed: effectiveMargin,
        leverage:   req.leverage,
        stopLoss:   req.stopLoss,
        takeProfit: req.takeProfit,
      });
    } catch (err) {
      // Position creation failed — release the margin we just locked so the
      // wallet is not left with an orphan locked balance. Retry on pool exhaustion.
      await releaseMarginWithRetry(req.userId, req.orderId, req.marginRequired);
      await orderLifecycle.rejectOrder(req.orderId, `Position creation failed: ${(err as Error).message}`);
      return { status: "REJECTED", orderId: req.orderId, reason: "LP_UNAVAILABLE" };
    }

    // ── 5a. Partial fill path ─────────────────────────────────────────────
    // When the LP returns a partial fill: create position for the filled
    // portion, create a Fill record, increment Order.filledQuantity, transition
    // to PARTIALLY_FILLED, release unused margin, then return early.
    // B-book always returns partialFill=false — this branch activates when an
    // external LP adapter (OneZero, PrimeXM, etc.) is wired in.
    if (isPartial) {
      const unusedMargin = req.marginRequired - effectiveMargin;
      if (unusedMargin > 0.01) {
        await releaseMarginWithRetry(req.userId, req.orderId, unusedMargin);
      }

      // ── 5a-i. Create Fill record (durable, not fire-and-forget) ──────
      await orderLifecycle.createFill({
        orderId:           req.orderId,
        positionId:        positionId,
        quantity:          effectiveFill,
        price:             execPrice,
        liquidityProvider: fillEngine.providerId,
        slippage:          fillResult.slippage,
        fees:              fillResult.fees,
      });

      // ── 5a-ii. Increment cumulative filledQuantity ───────────────────
      const { newFilledQty, originalQty } =
        await orderLifecycle.incrementFilledQuantity(req.orderId, effectiveFill);

      // ── 5a-iii. Determine terminal status ────────────────────────────
      // If cumulative fills now cover the full quantity, this was the last leg.
      const isNowFullyFilled = newFilledQty >= originalQty;

      await orderLifecycle.transition(
        req.orderId,
        isNowFullyFilled ? "FILLED" : "PARTIALLY_FILLED",
        `${isNowFullyFilled ? "Final" : "Partial"} fill leg: ` +
        `${effectiveFill}/${originalQty} @ ${execPrice} via ${fillEngine.providerId} ` +
        `— cumulative ${newFilledQty}/${originalQty}`,
        "LP",
        {
          averageFillPrice: execPrice,
          slippage:         fillResult.slippage,
          fees:             fillResult.fees,
          filledAt:         new Date(),
        },
      );

      // ── 5a-iv. Create TradeAudit for partial fill leg ────────────────
      void prisma.tradeAudit.create({
        data: {
          id:          randomUUID(),
          userId:      req.userId,
          orderId:     req.orderId,
          positionId,
          symbol:      req.symbol,
          side:        req.side,
          quantity:    new Decimal(effectiveFill),
          entryPrice:  new Decimal(execPrice),
          marginUsed:  new Decimal(effectiveMargin),
          leverage:    req.leverage,
          fees:        new Decimal(fillResult.fees),
          slippage:    new Decimal(fillResult.slippage),
          stopLoss:    req.stopLoss   ? new Decimal(req.stopLoss)   : null,
          takeProfit:  req.takeProfit ? new Decimal(req.takeProfit) : null,
          tradeStatus: "PARTIAL",
          lifecycle: JSON.stringify([{
            status:    "PARTIAL",
            timestamp: new Date().toISOString(),
            detail:    `Partial fill ${effectiveFill}/${originalQty} @ ${execPrice}`,
          }]),
          riskMetrics: JSON.stringify({
            marginRequired:  effectiveMargin,
            notional:        (effectiveFill / req.quantity) * req.notional,
            leverage:        req.leverage,
            remainingQty:    fillResult.remainingQuantity,
            cumulativeFilled: newFilledQty,
          }),
        },
      });

      exposureRegistry.openPosition(req.symbol, req.side,
        (effectiveFill / req.quantity) * req.notional);
      metrics.inc("orders_partial_filled_total");
      metrics.inc("positions_opened_total");

      const ts = new Date().toISOString();
      eventBus.emit("order.partial_filled", {
        orderId:           req.orderId,
        userId:            req.userId,
        symbol:            req.symbol,
        side:              req.side,
        filledQuantity:    effectiveFill,
        remainingQuantity: fillResult.remainingQuantity,
        averageFillPrice:  execPrice,
        timestamp:         ts,
      });
      eventBus.emit("position.opened", {
        positionId,
        userId:     req.userId,
        symbol:     req.symbol,
        side:       req.side,
        quantity:   effectiveFill,
        entryPrice: execPrice,
        marginUsed: effectiveMargin,
        leverage:   req.leverage,
        timestamp:  ts,
      });

      return {
        status:            isNowFullyFilled ? "FILLED" : "PARTIALLY_FILLED",
        orderId:           req.orderId,
        averageFillPrice:  execPrice,
        filledQuantity:    effectiveFill,
        remainingQuantity: isNowFullyFilled ? 0 : fillResult.remainingQuantity,
        slippage:          fillResult.slippage,
        fees:              fillResult.fees,
        positionId,
        executionMs:       Date.now() - startMs,
      } as ExecutionResult;
    }

    // ── 5b. Full fill path: transition ACCEPTED → FILLED ─────────────────
    // Only now — after margin is locked AND position exists — do we mark FILLED.
    // At this point the order is fully consistent: position row exists, margin
    // is locked, and the order reflects the correct terminal state.
    await orderLifecycle.transition(req.orderId, "FILLED",
      `Filled @ ${execPrice} via ${fillEngine.providerId} (slippage ${fillResult.slippage})`,
      "LP",
      {
        averageFillPrice: execPrice,
        slippage:         fillResult.slippage,
        fees:             fillResult.fees,
        filledAt:         new Date(),
      },
    );

    // ── 5b-i. Create Fill record ──────────────────────────────────────────
    // Durable fill leg record. Not fire-and-forget — Fill is a financial record.
    await orderLifecycle.createFill({
      orderId:           req.orderId,
      positionId:        positionId,
      quantity:          fillResult.filledQuantity,
      price:             execPrice,
      liquidityProvider: fillEngine.providerId,
      slippage:          fillResult.slippage,
      fees:              fillResult.fees,
    });

    // ── 5b-ii. Update filledQuantity to full quantity ─────────────────────
    await orderLifecycle.incrementFilledQuantity(req.orderId, fillResult.filledQuantity);

    // ── 6. Update global exposure registry ───────────────────────────────
    // Called after position creation so the registry never overstates
    // exposure relative to the DB. If createPosition() had thrown, we return
    // early above and never increment the registry.
    exposureRegistry.openPosition(req.symbol, req.side, req.notional);

    // ── 7. Record trade audit ─────────────────────────────────────────────
    // Fire-and-forget: position/wallet/ledger are already consistent above.
    // Audit failure is a compliance concern, not a financial one.
    void prisma.tradeAudit.create({
      data: {
        id:          randomUUID(),
        userId:      req.userId,
        orderId:     req.orderId,
        positionId,
        symbol:      req.symbol,
        side:        req.side,
        quantity:    new Decimal(fillResult.filledQuantity),
        entryPrice:  new Decimal(execPrice),
        marginUsed:  new Decimal(req.marginRequired),
        leverage:    req.leverage,
        fees:        new Decimal(fillResult.fees),
        slippage:    new Decimal(fillResult.slippage),
        stopLoss:    req.stopLoss   ? new Decimal(req.stopLoss)   : null,
        takeProfit:  req.takeProfit ? new Decimal(req.takeProfit) : null,
        tradeStatus: "OPEN",
        lifecycle: JSON.stringify([{
          status:    "OPEN",
          timestamp: new Date().toISOString(),
          detail:    `Opened @ ${execPrice}`,
        }]),
        riskMetrics: JSON.stringify({
          marginRequired: req.marginRequired,
          notional:       req.notional,
          leverage:       req.leverage,
        }),
      },
    });

    // ── 9. Persist outbox event ───────────────────────────────────────────
    void prisma.outboxEvent.create({
      data: {
        eventType: "order.filled",
        userId:    req.userId,
        payload:   {
          orderId:    req.orderId,
          positionId,
          userId:     req.userId,
          symbol:     req.symbol,
          side:       req.side,
          fillPrice:  execPrice,
          marginUsed: req.marginRequired,
          notional:   req.notional,
          slippage:   fillResult.slippage,
          fees:       fillResult.fees,
        } as object,
      },
    });

    const executionMs = Date.now() - startMs;
    const ts          = new Date().toISOString();

    // ── 10. Metrics ───────────────────────────────────────────────────────
    metrics.inc("orders_filled_total");
    metrics.inc("positions_opened_total");

    // ── 11. Emit domain events ────────────────────────────────────────────
    eventBus.emit("order.filled", {
      orderId:          req.orderId,
      userId:           req.userId,
      symbol:           req.symbol,
      side:             req.side,
      quantity:         fillResult.filledQuantity,
      averageFillPrice: execPrice,
      marginRequired:   req.marginRequired,
      notional:         req.notional,
      leverage:         req.leverage,
      timestamp:        ts,
    });

    eventBus.emit("position.opened", {
      positionId,
      userId:     req.userId,
      symbol:     req.symbol,
      side:       req.side,
      quantity:   fillResult.filledQuantity,
      entryPrice: execPrice,
      marginUsed: req.marginRequired,
      leverage:   req.leverage,
      timestamp:  ts,
    });

    eventBus.emit("wallet.event", {
      userId:    req.userId,
      type:      "MARGIN_LOCK",
      amount:    req.marginRequired,
      reference: req.orderId,
      timestamp: ts,
    });

    return {
      status:           "FILLED",
      orderId:          req.orderId,
      averageFillPrice: execPrice,
      filledQuantity:   fillResult.filledQuantity,
      slippage:         fillResult.slippage,
      fees:             fillResult.fees,
      positionId,
      executionMs,
    };
  }

}

export const executionEngine = new ExecutionEngine();
