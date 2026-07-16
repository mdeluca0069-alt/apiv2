import { prisma }           from "../shared/db.js";
import { eventBus }         from "../events-bus/event.bus.js";
import { fillEngine }       from "./fill.engine.js";
import { orderLifecycle }   from "../trading-service/order.lifecycle.js";
import { marginController } from "../risk-service/margin.controller.js";
import { exposureRegistry } from "../risk-service/exposure.limits.js";
import { metrics }          from "../gateway/metrics.js";
import { reconciliationEngine } from "../settlement/reconciliation.engine.js";
import { quoteCache }       from "../market-data/quote.cache.js";
import { checkRequote }     from "./requote.policy.js";
import { leverageGuard }    from "../risk-service/leverage.guard.js";
import type { ExecutionRequest, ExecutionResult } from "../shared/contracts.js";
import type { CancelToken }  from "./execution.queue.js";

/** Thrown inside the FASE 2.2 unified fill transaction to abort/rollback it
 *  cleanly when the caller cancels after margin has already been locked
 *  within that same transaction — the throw rolls the lock back too, so no
 *  compensating release is needed (unlike the pre-2.2 two-transaction design). */
class ExecutionCancelledError extends Error {
  constructor() { super("EXECUTION_TIMEOUT: cancelled after margin lock"); this.name = "ExecutionCancelledError"; }
}

/** Thrown (never returned) inside the unified transaction when the FASE 2.3
 *  exposure check fails — by this point margin.controller.ts has already
 *  written the lock (wallet.locked increment + MARGIN_LOCK ledger entry), so
 *  a `return {ok:false}` would let those writes COMMIT along with the rest of
 *  the no-op callback result. Throwing is what rolls them back too, same as
 *  ExecutionCancelledError above. */
class ExposureHaltedError extends Error {
  constructor(detail: string) { super(detail); this.name = "ExposureHaltedError"; }
}

/** LEDGER_FREEZE.md §0.6: order.controller.ts's pre-trade rejection path
 *  already emits this event (feeding Metrics/Notification/the durable event
 *  archive); this engine's own REJECTED branches never did, so two
 *  rejections producing an identical client-visible OrderAck had radically
 *  different downstream completeness depending only on which layer
 *  rejected. Same event shape, same call site pattern. */
function emitOrderRejected(req: ExecutionRequest, reason: string): void {
  eventBus.emit("order.rejected", {
    orderId:   req.orderId,
    userId:    req.userId,
    symbol:    req.symbol,
    reason,
    timestamp: new Date().toISOString(),
  });
}

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

    // ── FASE 3.3: requote check ──────────────────────────────────────────
    // `quote` was captured once at order.controller.ts's placeOrder(), before
    // this order sat in the per-user execution queue (up to ~15-27s under
    // contention — execution.queue.ts's own timeout/max-wait). fillEngine.fill()
    // below uses `quote` exactly as passed, with no re-fetch of its own — so
    // without this check, a client could be filled against a price that's
    // been stale for the entire time their order was queued, never told the
    // market moved. Re-fetch the live quote right here, right before the
    // fill price is computed, and reject (cheaply — no margin locked yet)
    // if it drifted beyond the asset class's tolerance. Fails open (skips
    // the check, keeps the original behavior) if quoteCache has no live
    // quote at all right now — this is a new protective check, it should
    // never itself become a new way to block an order.
    const freshQuote = quoteCache.get(req.symbol);
    if (freshQuote) {
      const rq = checkRequote(req.symbol, req.side, quote, freshQuote);
      if (rq.requoted) {
        const reason = `REQUOTE: price moved ${rq.movePct.toFixed(3)}% while your order was queued (tolerance ${rq.threshold}%) — please resubmit`;
        await orderLifecycle.rejectOrder(req.orderId, reason);
        metrics.inc("requotes_total");
        emitOrderRejected(req, reason);
        return { status: "REJECTED", orderId: req.orderId, reason: "REQUOTE" };
      }
    }

    // ── 2. Calculate fill ─────────────────────────────────────────────────
    // Price source: real TwelveData bid/ask only. Never GBM, never synthetic.
    let fillResult;
    try {
      fillResult = fillEngine.fill(req, quote);
    } catch (err) {
      const reason = "Internal LP fill error — no liquidity";
      await orderLifecycle.rejectOrder(req.orderId, reason);
      emitOrderRejected(req, reason);
      return { status: "REJECTED", orderId: req.orderId, reason: "LP_UNAVAILABLE" };
    }

    const execPrice = fillResult.averagePrice;

    // ── FASE 3.5: FOK (Fill-Or-Kill) — reject the whole order if the LP
    // cannot fill the full requested quantity immediately. Checked here,
    // right after the fill is computed and before anything financial
    // happens (no margin lock, no transaction started yet) — same cheapest-
    // rejection-point principle as the REQUOTE check above. Today the sole
    // ILiquidityProvider always returns partialFill:false (full-or-reject by
    // construction), so this branch is currently unreachable in practice —
    // it exists for correctness once a future LP can genuinely partial-fill.
    if (req.type === "FOK" && fillResult.partialFill && fillResult.remainingQuantity > 0) {
      const reason = `FOK_UNFILLABLE: only ${fillResult.filledQuantity}/${req.quantity} available immediately — Fill-Or-Kill requires the full quantity`;
      await orderLifecycle.rejectOrder(req.orderId, reason);
      metrics.inc("fok_rejections_total");
      emitOrderRejected(req, reason);
      return { status: "REJECTED", orderId: req.orderId, reason: "FOK_UNFILLABLE" };
    }

    // ── Cancel check A — before margin lock ──────────────────────────────
    // Order is ACCEPTED, no money committed. Clean abort.
    if (cancelled()) {
      const reason = "EXECUTION_TIMEOUT: cancelled before margin lock";
      await orderLifecycle.rejectOrder(req.orderId, reason);
      emitOrderRejected(req, reason);
      return { status: "REJECTED", orderId: req.orderId, reason: "EXECUTION_TIMEOUT" };
    }

    // ── 3-5. Margin lock, position creation, and fill bookkeeping — ONE
    // atomic transaction (FASE 2.2, extending FASE 2.1's transactional outbox).
    //
    // Previously margin-lock and position-create were separate, independently
    // committed operations; a crash or failure between them left orphaned
    // locked margin that only a compensating release (releaseMarginWithRetry,
    // or the startup RecoveryService sweep — see settlement/recovery.service.ts)
    // could repair. Now the whole unit — margin check+lock, the mid-flight
    // cancellation window, position creation, the FILLED/PARTIALLY_FILLED
    // transition, the Fill record, the filledQuantity increment, and the
    // OutboxEvent — either all happen or none do. A failure anywhere inside
    // rolls back everything already done in this transaction, including the
    // margin lock — no compensating release is needed for those cases anymore
    // (releaseMarginWithRetry is still used below for the ONE case that is not
    // a failure: releasing the unused portion of margin after a genuine partial
    // fill, which is a correct follow-up action on committed state, not a
    // rollback compensation).
    // FASE 4.3 (RISK_ENGINE_FREEZE.md Bug #7): req.marginRequired/req.notional
    // were computed by risk.engine.ts's preTradeCheck() at ORDER-REQUEST
    // time, from the mid price -- but the real fill (above) executes at
    // top-of-book (ask for BUY, bid for SELL) plus deterministic slippage,
    // via fillEngine.fill(). The position's actual notional/margin must
    // reflect what was actually filled, not a stale pre-trade estimate --
    // recomputed here from execPrice, now that it's known, using the same
    // pure formulas risk.engine.ts itself uses. This also means the margin
    // LOCK below (and the exposure check further down, which already reads
    // effectiveNotional) are now checked against the real requirement: if
    // the real price makes the position more expensive than pre-approved
    // and the client's free margin can't cover it, checkAndLockMargin's
    // existing atomic check correctly rejects -- no separate rejection path
    // needed, it was just being fed the wrong number before.
    const realNotional       = leverageGuard.computeNotional(req.quantity, execPrice);
    const realMarginRequired = leverageGuard.computeMarginRequired(realNotional, req.leverage);

    const isPartial      = fillResult.partialFill && fillResult.remainingQuantity > 0;
    const effectiveFill  = fillResult.filledQuantity;
    const effectiveMargin = isPartial
      ? (fillResult.filledQuantity / req.quantity) * realMarginRequired
      : realMarginRequired;
    const effectiveNotional = isPartial
      ? (effectiveFill / req.quantity) * realNotional
      : realNotional;

    type TxOutcome =
      | { ok: true; positionId: string; newFilledQty: number; originalQty: number;
          isNowFullyFilled: boolean; outboxId: string }
      | { ok: false; reason: string };

    let outcome: TxOutcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        // ── 3. Atomic margin check-and-lock ──────────────────────────────
        // FOR UPDATE on the wallet row (inside margin.controller.ts) serializes
        // concurrent margin-lock attempts per user under this same transaction.
        const marginLock = await marginController.checkAndLockMargin(
          req.userId, req.orderId, realMarginRequired, tx,
        );
        if (!marginLock.ok) {
          return { ok: false as const, reason: marginLock.reason };
        }

        // ── Cancel check — after margin lock, before position creation ────
        // Throwing here rolls back the margin lock write above along with
        // everything else in this transaction — no manual release needed.
        if (cancelled()) throw new ExecutionCancelledError();

        // ── Atomic, cluster-wide exposure check (FASE 2.3) ────────────────
        // Re-validates the instrument exposure limit under an advisory lock
        // against LIVE Position data — the same "re-check under lock at the
        // last moment" pattern already used for margin above. The earlier
        // pre-trade check (RiskEngine.preTradeCheck → exposureRegistry.
        // checkCanOpen) only reads a per-worker cache and is not authoritative
        // cluster-wide; this is. A failure here rolls back the margin lock
        // too, same as insufficient margin.
        const exposureCheck = await exposureRegistry.checkCanOpenAtomic(
          tx, req.symbol, req.side, effectiveNotional,
        );
        if (!exposureCheck.ok) throw new ExposureHaltedError(exposureCheck.detail);

        // ── 4. Create position ────────────────────────────────────────────
        // For a partial fill, the position covers only the filled portion,
        // with proportional margin; the unfilled remainder is the caller's
        // responsibility to re-queue (see order.controller.ts).
        const positionId = await orderLifecycle.createPosition({
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
        }, tx);

        // ── 5. Fill record (durable, not fire-and-forget) ─────────────────
        await orderLifecycle.createFill({
          orderId:           req.orderId,
          positionId,
          quantity:          effectiveFill,
          price:             execPrice,
          liquidityProvider: fillEngine.providerId,
          slippage:          fillResult.slippage,
          fees:              fillResult.fees,
        }, tx);

        // ── 6-7. Increment cumulative filledQuantity AND transition to the
        // terminal status — ONE round trip (FASE 2.2 perf: recordFillLeg
        // merges what were two separate UPDATEs on the same Order row into
        // one, computing FILLED vs PARTIALLY_FILLED via SQL CASE against the
        // post-increment quantity instead of reading it back in between).
        // Only now — after margin is locked AND position exists — does the
        // order become FILLED/PARTIALLY_FILLED: the LAST financial operation
        // in the transaction, not the first.
        const { newFilledQty, originalQty, isNowFullyFilled } = await orderLifecycle.recordFillLeg(
          req.orderId,
          effectiveFill,
          {
            filled:  isPartial ? `Final fill leg: ${effectiveFill} @ ${execPrice} via ${fillEngine.providerId}` : `Filled @ ${execPrice} via ${fillEngine.providerId} (slippage ${fillResult.slippage})`,
            partial: `Partial fill leg: ${effectiveFill} @ ${execPrice} via ${fillEngine.providerId}`,
          },
          { averageFillPrice: execPrice, slippage: fillResult.slippage, fees: fillResult.fees },
          tx,
        );

        // ── 8. OutboxEvent — same transaction as the state it describes ────
        // FASE 2.1: guaranteed to exist the instant the fill is durable, even
        // if the process crashes immediately after. Its id is threaded through
        // eventBus so the WS bridge (main.ts) marks it published on delivery
        // instead of creating a second, redundant row.
        //
        // FASE 2.4: the payload also carries every field the audit consumer
        // (compliance/audit.outbox.consumer.ts) needs to build a TradeAudit
        // record — leverage/stopLoss/takeProfit aren't derivable from the
        // financial tables alone without a re-fetch, so they're captured here
        // once, cheaply, while already in scope, rather than making the
        // consumer re-fetch Order/Position (and risk it reading state that
        // has since changed, e.g. a stopLoss the client edited afterward).
        //
        // FASE 2.6: notificationProcessed is only false for a full fill —
        // notification.router.ts never notified on partial fills either
        // (no listener existed for order.partial_filled), so the consumer
        // shouldn't start doing that now; that would be a new feature, not
        // a reliability fix.
        const outbox = await tx.outboxEvent.create({
          data: {
            eventType: isNowFullyFilled ? "order.filled" : "order.partial_filled",
            userId:    req.userId,
            auditProcessed: false,
            notificationProcessed: !isNowFullyFilled,
            payload: {
              orderId: req.orderId, positionId, userId: req.userId, symbol: req.symbol,
              side: req.side, fillPrice: execPrice, marginUsed: effectiveMargin,
              notional: effectiveNotional, filledQuantity: effectiveFill,
              slippage: fillResult.slippage, fees: fillResult.fees,
              leverage: req.leverage, stopLoss: req.stopLoss ?? null, takeProfit: req.takeProfit ?? null,
              tradeStatus: isPartial ? "PARTIAL" : "OPEN",
              ...(isPartial ? { remainingQty: fillResult.remainingQuantity, cumulativeFilled: newFilledQty } : {}),
            } as object,
          },
        });

        return { ok: true as const, positionId, newFilledQty, originalQty, isNowFullyFilled, outboxId: outbox.id };
      });
    } catch (err) {
      if (err instanceof ExecutionCancelledError) {
        await orderLifecycle.rejectOrder(req.orderId, err.message);
        emitOrderRejected(req, err.message);
        return { status: "REJECTED", orderId: req.orderId, reason: "EXECUTION_TIMEOUT" };
      }
      if (err instanceof ExposureHaltedError) {
        await orderLifecycle.rejectOrder(req.orderId, err.message);
        emitOrderRejected(req, err.message);
        return { status: "REJECTED", orderId: req.orderId, reason: "INSTRUMENT_HALTED" };
      }
      const reason = `Execution failed: ${(err as Error).message}`;
      await orderLifecycle.rejectOrder(req.orderId, reason);
      emitOrderRejected(req, reason);
      return { status: "REJECTED", orderId: req.orderId, reason: "LP_UNAVAILABLE" };
    }

    if (!outcome.ok) {
      await orderLifecycle.rejectOrder(req.orderId, outcome.reason);
      emitOrderRejected(req, outcome.reason);
      return { status: "REJECTED", orderId: req.orderId, reason: "MARGIN_INSUFFICIENT" };
    }

    const { positionId, isNowFullyFilled, outboxId } = outcome;
    const ts = new Date().toISOString();

    // ── Release unused margin for a genuine partial fill ────────────────────
    // Margin was locked for the FULL requested amount inside the transaction
    // above; this releases what the filled portion didn't need. This runs
    // AFTER commit on purpose — the lock itself is already correctly
    // committed, this is a legitimate follow-up release of already-settled
    // state, not a rollback compensation for a failure.
    if (isPartial) {
      const unusedMargin = realMarginRequired - effectiveMargin;
      if (unusedMargin > 0.01) {
        await releaseMarginWithRetry(req.userId, req.orderId, unusedMargin);
      }
    }

    // ── Update global exposure registry ───────────────────────────────────
    // Called after the transaction commits so the registry never overstates
    // exposure relative to the DB.
    exposureRegistry.openPosition(req.symbol, req.side, effectiveNotional);

    // ── Record trade audit ─────────────────────────────────────────────────
    // FASE 2.4: TradeAudit is no longer written here, fire-and-forget. The
    // OutboxEvent row created inside the transaction above (with the same
    // fields this used to build TradeAudit from) is durable the instant the
    // fill is; compliance/audit.outbox.consumer.ts reliably turns it into a
    // TradeAudit row, with retry and alerting on persistent failure — see
    // that file for the delivery guarantee.

    metrics.inc(isPartial ? "orders_partial_filled_total" : "orders_filled_total");
    metrics.inc("positions_opened_total");

    // ── Emit domain events ─────────────────────────────────────────────────
    if (isPartial) {
      eventBus.emit("order.partial_filled", {
        orderId:           req.orderId,
        userId:            req.userId,
        symbol:            req.symbol,
        side:              req.side,
        filledQuantity:    effectiveFill,
        remainingQuantity: fillResult.remainingQuantity,
        averageFillPrice:  execPrice,
        timestamp:         ts,
        outboxId,
      });
    } else {
      eventBus.emit("order.filled", {
        orderId:          req.orderId,
        userId:           req.userId,
        symbol:           req.symbol,
        side:             req.side,
        quantity:         effectiveFill,
        averageFillPrice: execPrice,
        marginRequired:   realMarginRequired,
        notional:         effectiveNotional,
        leverage:         req.leverage,
        timestamp:        ts,
        outboxId,
      });
      eventBus.emit("wallet.event", {
        userId:    req.userId,
        type:      "MARGIN_LOCK",
        amount:    realMarginRequired,
        reference: req.orderId,
        timestamp: ts,
      });
    }

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

}

export const executionEngine = new ExecutionEngine();
