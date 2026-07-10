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
    const isPartial      = fillResult.partialFill && fillResult.remainingQuantity > 0;
    const effectiveFill  = fillResult.filledQuantity;
    const effectiveMargin = isPartial
      ? (fillResult.filledQuantity / req.quantity) * req.marginRequired
      : req.marginRequired;
    const effectiveNotional = isPartial
      ? (effectiveFill / req.quantity) * req.notional
      : req.notional;

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
          req.userId, req.orderId, req.marginRequired, tx,
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
        const outbox = await tx.outboxEvent.create({
          data: {
            eventType: isNowFullyFilled ? "order.filled" : "order.partial_filled",
            userId:    req.userId,
            payload: {
              orderId: req.orderId, positionId, userId: req.userId, symbol: req.symbol,
              side: req.side, fillPrice: execPrice, marginUsed: effectiveMargin,
              notional: effectiveNotional, filledQuantity: effectiveFill,
              slippage: fillResult.slippage, fees: fillResult.fees,
            } as object,
          },
        });

        return { ok: true as const, positionId, newFilledQty, originalQty, isNowFullyFilled, outboxId: outbox.id };
      });
    } catch (err) {
      if (err instanceof ExecutionCancelledError) {
        await orderLifecycle.rejectOrder(req.orderId, err.message);
        return { status: "REJECTED", orderId: req.orderId, reason: "EXECUTION_TIMEOUT" };
      }
      if (err instanceof ExposureHaltedError) {
        await orderLifecycle.rejectOrder(req.orderId, err.message);
        return { status: "REJECTED", orderId: req.orderId, reason: "INSTRUMENT_HALTED" };
      }
      await orderLifecycle.rejectOrder(req.orderId, `Execution failed: ${(err as Error).message}`);
      return { status: "REJECTED", orderId: req.orderId, reason: "LP_UNAVAILABLE" };
    }

    if (!outcome.ok) {
      await orderLifecycle.rejectOrder(req.orderId, outcome.reason);
      return { status: "REJECTED", orderId: req.orderId, reason: "MARGIN_INSUFFICIENT" };
    }

    const { positionId, newFilledQty, originalQty, isNowFullyFilled, outboxId } = outcome;
    const ts = new Date().toISOString();

    // ── Release unused margin for a genuine partial fill ────────────────────
    // Margin was locked for the FULL requested amount inside the transaction
    // above; this releases what the filled portion didn't need. This runs
    // AFTER commit on purpose — the lock itself is already correctly
    // committed, this is a legitimate follow-up release of already-settled
    // state, not a rollback compensation for a failure.
    if (isPartial) {
      const unusedMargin = req.marginRequired - effectiveMargin;
      if (unusedMargin > 0.01) {
        await releaseMarginWithRetry(req.userId, req.orderId, unusedMargin);
      }
    }

    // ── Update global exposure registry ───────────────────────────────────
    // Called after the transaction commits so the registry never overstates
    // exposure relative to the DB.
    exposureRegistry.openPosition(req.symbol, req.side, effectiveNotional);

    // ── Record trade audit ─────────────────────────────────────────────────
    // Fire-and-forget: position/wallet/ledger/outbox are already durable above.
    // FASE 2.4 replaces this with a reliable outbox-driven audit consumer —
    // for now audit failure remains a compliance concern, not a financial one.
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
        tradeStatus: isPartial ? "PARTIAL" : "OPEN",
        lifecycle: JSON.stringify([{
          status:    isPartial ? "PARTIAL" : "OPEN",
          timestamp: new Date().toISOString(),
          detail:    isPartial ? `Partial fill ${effectiveFill}/${originalQty} @ ${execPrice}` : `Opened @ ${execPrice}`,
        }]),
        riskMetrics: JSON.stringify({
          marginRequired:   effectiveMargin,
          notional:         effectiveNotional,
          leverage:         req.leverage,
          ...(isPartial ? { remainingQty: fillResult.remainingQuantity, cumulativeFilled: newFilledQty } : {}),
        }),
      },
    });

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
        marginRequired:   req.marginRequired,
        notional:         effectiveNotional,
        leverage:         req.leverage,
        timestamp:        ts,
        outboxId,
      });
      eventBus.emit("wallet.event", {
        userId:    req.userId,
        type:      "MARGIN_LOCK",
        amount:    req.marginRequired,
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
