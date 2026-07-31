/**
 * PendingOrderExpiryService — scans for expired resting orders and closes their lifecycle.
 *
 * Runs on a configurable interval (default: every 30 seconds).
 *
 * Two expiry scenarios handled:
 *   1. Regular pending orders with expiresAt set (GTD / GTC / IOC semantics)
 *      → transitions Order to CANCELLED
 *   2. Armed LIMIT legs of STOP_LIMIT orders (armedByStopLimit = true)
 *      → transitions Order to LIMIT_EXPIRED (distinct audit trail)
 *
 * Idempotency: `pendingOrderBook.markTriggered()` is idempotent; if the order
 * was filled between the expiry check and the transition, `markTriggered` returns
 * null and the transition is skipped. The Order row will already be FILLED.
 *
 * PHASE2_REMEDIATION (H2): margin IS released on expiry now. CANCELLED and
 * LIMIT_EXPIRED (the two terminal statuses this service assigns) are
 * themselves terminal states, so per this file's own margin-lifecycle rule
 * ("remain locked until the order reaches a terminal state"), expiry is
 * exactly the point margin must come back to the client -- the previous
 * version of this comment asserted margin stayed locked through expiry
 * while simultaneously describing expiry as terminal, an internal
 * contradiction that traced back to margin never actually being locked at
 * placement in the first place (see order.controller.ts's
 * _parkPendingOrder() and pending.order.book.ts's cancel() paths for the
 * placement-time lock and the other release points).
 *
 * Wiring: call start() in main.ts alongside orderTriggerWatcher.start().
 */

import { pendingOrderBook } from "./pending.order.book.js";
import { orderLifecycle }   from "./order.lifecycle.js";
import { eventBus }         from "../events-bus/event.bus.js";
import { jobCoordinator }   from "../realtime-infra/job.coordinator.js";
import { marginController } from "../risk-service/margin.controller.js";
import type { PendingOrder } from "./pending.order.book.js";

export class PendingOrderExpiryService {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private active = false;

  start(intervalMs = 30_000): void {
    if (this.active) return;
    this.active = true;
    this.intervalHandle = setInterval(() => void this._scan(), intervalMs);
    console.log(`[order-expiry] started — scanning every ${intervalMs}ms`);
  }

  stop(): void {
    this.active = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Run a single expiry scan immediately.
   * Also called on startup to catch any orders that expired during a server restart.
   */
  async scanNow(): Promise<{ expired: number; errors: number }> {
    return this._scan();
  }

  private async _scan(): Promise<{ expired: number; errors: number }> {
    if (!(await jobCoordinator.tryLead("pending-order-expiry"))) {
      return { expired: 0, errors: 0 };
    }

    let expired = 0;
    let errors  = 0;

    try {
      const now = new Date();
      // PHASE2_REMEDIATION (H1/H3): source candidates from the DB, not the
      // local Map -- see getExpiredFromSource()'s docstring. The leader
      // elected for this scan may not be the worker that originally
      // created a given order, so its local Map alone is not a reliable
      // source of the true, cluster-wide expired set.
      const toExpire = await pendingOrderBook.getExpiredFromSource(now);

      for (const order of toExpire) {
        try {
          await this._expireOrder(order);
          expired++;
        } catch (err) {
          errors++;
          console.error(
            `[order-expiry] failed to expire order ${order.id} (orderId=${order.orderId}):`,
            (err as Error).message,
          );
        }
      }

      if (expired > 0 || errors > 0) {
        console.log(`[order-expiry] scan complete — expired=${expired} errors=${errors}`);
      }
    } finally {
      await jobCoordinator.release("pending-order-expiry");
    }

    return { expired, errors };
  }

  private async _expireOrder(order: PendingOrder): Promise<void> {
    // markTriggered is the correct "remove from book" call — it removes the
    // order from the in-memory set and marks it TRIGGERED in DB.
    // If it returns null the order was already processed (filled or cancelled).
    const removed = await pendingOrderBook.markTriggered(order.id);
    if (!removed) return;

    // PHASE2_REMEDIATION (H2): margin was locked at placement time and must
    // come back to the client's free balance now that this order will
    // never fill -- see this file's docstring. Non-fatal on failure (same
    // reasoning as pending.order.book.ts's cancel-path release): the
    // expiry transition below still proceeds either way.
    await marginController.releaseMargin(removed.userId, removed.orderId, removed.marginRequired).catch((err) => {
      console.error(`[order-expiry] margin release failed for expired order ${removed.orderId}:`, (err as Error).message);
    });

    const terminalStatus = order.armedByStopLimit ? "LIMIT_EXPIRED" : "CANCELLED";
    const detail = order.armedByStopLimit
      ? `LIMIT_EXPIRED: armed limit order not filled within ${
          order.expiresAt
            ? Math.round((order.expiresAt.getTime() - order.createdAt.getTime()) / 60_000)
            : "?"
        } minutes — transitioning to LIMIT_EXPIRED`
      : `CANCELLED: pending order expired at ${order.expiresAt?.toISOString() ?? "unknown"}`;

    await orderLifecycle.transition(
      order.orderId,
      terminalStatus,
      detail,
      "SYSTEM",
    );

    const ts = new Date().toISOString();

    if (order.armedByStopLimit) {
      eventBus.emit("order.limit_expired", {
        orderId:    order.orderId,
        pendingId:  order.id,
        userId:     order.userId,
        symbol:     order.symbol,
        side:       order.side,
        limitPrice: order.triggerPrice,
        expiredAt:  order.expiresAt?.toISOString() ?? ts,
        timestamp:  ts,
      });
    } else {
      eventBus.emit("order.cancelled", {
        orderId:   order.orderId,
        pendingId: order.id,
        userId:    order.userId,
        symbol:    order.symbol,
        reason:    "ORDER_EXPIRED",
        timestamp: ts,
      });
    }
  }
}

export const pendingOrderExpiryService = new PendingOrderExpiryService();
export default pendingOrderExpiryService;
