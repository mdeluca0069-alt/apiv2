import { randomUUID }   from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }      from "../events-bus/event.bus.js";

export type PendingOrderType = "LIMIT" | "STOP" | "STOP_LIMIT" | "TRAILING_STOP";
export type PendingOrderSide = "BUY" | "SELL";

export type PendingOrder = {
  id:            string;
  orderId:       string;
  userId:        string;
  symbol:        string;
  side:          PendingOrderSide;
  type:          PendingOrderType;
  quantity:      number;
  triggerPrice:  number;   // STOP / STOP_LIMIT trigger price
  limitPrice?:   number;   // STOP_LIMIT limit price after trigger
  trailAmount?:  number;   // TRAILING_STOP: pips/points offset from best price
  leverage:      number;
  stopLoss?:     number;
  takeProfit?:   number;
  marginRequired: number;
  notional:      number;
  clientOrderId?: string;
  // Stop-limit lifecycle
  armedByStopLimit?: boolean; // true when this LIMIT order is the second leg of a STOP_LIMIT
  // Trailing state
  peakPrice?:    number;   // best market price seen (opposite direction of stop)
  status:        "PENDING" | "TRIGGERED" | "CANCELLED" | "EXPIRED";
  expiresAt?:    Date;
  createdAt:     Date;
  // FASE 3.6: OCO (One-Cancels-Other) — shared by exactly two sibling orders.
  // Whichever leg resolves first (triggers OR is manually cancelled) cancels
  // the other. Not a PendingOrderType of its own: an OCO leg is still a
  // normal LIMIT/STOP/STOP_LIMIT/TRAILING_STOP order, just linked to a peer.
  ocoGroupId?:   string;
};

/**
 * PendingOrderBook — in-memory + DB-backed store for pending (resting) orders.
 *
 * Supported order types:
 *   LIMIT        — fill when market crosses limit price (buy < limit, sell > limit)
 *   STOP         — market order triggered when price crosses stop level
 *   STOP_LIMIT   — limit order placed when stop is triggered
 *   TRAILING_STOP — stop level trails best price by a fixed amount
 *
 * The book is loaded from DB on startup. All mutations are persisted immediately
 * via BrokerSetting with key=`pending_order:{id}` so the book survives restarts.
 */
class PendingOrderBook {
  private orders: Map<string, PendingOrder> = new Map();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (!IS_PERSISTENT) return;

    try {
      const db    = prisma as NonNullable<typeof prisma>;
      const rows  = await db.brokerSetting.findMany({
        where: { key: { startsWith: "pending_order:" } },
      });

      for (const row of rows) {
        const order = row.value as unknown as PendingOrder;
        if (order?.status === "PENDING") {
          if (order.expiresAt && new Date(order.expiresAt) < new Date()) {
            await this._cancelPersisted(order.id, "EXPIRED");
          } else {
            order.createdAt = new Date(order.createdAt);
            if (order.expiresAt) order.expiresAt = new Date(order.expiresAt);
            this.orders.set(order.id, order);
          }
        }
      }

      console.log(`[order-book] loaded ${this.orders.size} pending orders from DB`);
    } catch (err) {
      console.error("[order-book] failed to load pending orders:", (err as Error).message);
    }
  }

  async add(order: Omit<PendingOrder, "id" | "createdAt" | "status">): Promise<PendingOrder> {
    const pending: PendingOrder = {
      ...order,
      id:        randomUUID(),
      status:    "PENDING",
      createdAt: new Date(),
      peakPrice: order.peakPrice ?? (order.type === "TRAILING_STOP"
        ? (order.side === "BUY" ? -Infinity : Infinity)
        : undefined),
    };

    this.orders.set(pending.id, pending);

    try {
      // P0-2: Persistence must be confirmed — not fire-and-forget.
      await this._persist(pending);
    } catch (err) {
      // Persistence failed after all retries — do not leave the order in memory.
      // The caller will receive the error and must reject the order to the client.
      this.orders.delete(pending.id);
      throw err;
    }

    eventBus.emit("order.pending", {
      orderId:      pending.orderId,
      pendingId:    pending.id,
      userId:       pending.userId,
      symbol:       pending.symbol,
      type:         pending.type,
      side:         pending.side,
      triggerPrice: pending.triggerPrice,
      limitPrice:   pending.limitPrice,
      trailAmount:  pending.trailAmount,
      timestamp:    pending.createdAt.toISOString(),
    });

    return pending;
  }

  getForUser(userId: string): PendingOrder[] {
    return [...this.orders.values()].filter((o) => o.userId === userId && o.status === "PENDING");
  }

  getAll(): PendingOrder[] {
    return [...this.orders.values()].filter((o) => o.status === "PENDING");
  }

  getBySymbol(symbol: string): PendingOrder[] {
    return [...this.orders.values()].filter(
      (o) => o.symbol === symbol && o.status === "PENDING"
    );
  }

  async cancel(pendingId: string, userId: string): Promise<boolean> {
    const order = this.orders.get(pendingId);
    if (!order || order.userId !== userId || order.status !== "PENDING") return false;

    await this._cancelOne(order, "CLIENT_CANCEL");

    // FASE 3.6: cancelling one OCO leg cancels its sibling too — an OCO pair
    // resolves together, whichever leg the client acts on first.
    if (order.ocoGroupId) {
      await this._cancelGroupSiblings(order.ocoGroupId, order.id, "OCO_SIBLING_CANCELLED");
    }

    return true;
  }

  /**
   * FASE 3.6: called by order.trigger.watcher.ts right after a leg triggers
   * (fills OR arms, for STOP_LIMIT) — cancels any sibling(s) sharing the same
   * ocoGroupId. Cancellation happens at trigger-detection time, not at
   * confirmed fill: once the market has genuinely crossed one leg's level,
   * that leg is committed, and the OCO contract is that the other leg is
   * invalidated regardless of whether the triggered leg's execution later
   * succeeds. No-op if the order has no group (the overwhelmingly common
   * case — most pending orders are not part of an OCO pair).
   */
  async cancelOcoSiblingsOnTrigger(pendingId: string, ocoGroupId: string | undefined): Promise<void> {
    if (!ocoGroupId) return;
    await this._cancelGroupSiblings(ocoGroupId, pendingId, "OCO_SIBLING_TRIGGERED");
  }

  private async _cancelGroupSiblings(ocoGroupId: string, excludeId: string, reason: string): Promise<void> {
    const siblings = [...this.orders.values()].filter(
      (o) => o.ocoGroupId === ocoGroupId && o.id !== excludeId && o.status === "PENDING",
    );
    for (const sibling of siblings) {
      await this._cancelOne(sibling, reason);
    }
  }

  private async _cancelOne(order: PendingOrder, reason: string): Promise<void> {
    order.status = "CANCELLED";
    this.orders.delete(order.id);
    await this._cancelPersisted(order.id, "CANCELLED");

    eventBus.emit("order.cancelled", {
      orderId:   order.orderId,
      pendingId: order.id,
      userId:    order.userId,
      symbol:    order.symbol,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  markTriggered(pendingId: string): PendingOrder | null {
    const order = this.orders.get(pendingId);
    if (!order || order.status !== "PENDING") return null;

    order.status = "TRIGGERED";
    this.orders.delete(pendingId);
    void this._cancelPersisted(pendingId, "TRIGGERED");
    return order;
  }

  /** Called by order.trigger.watcher.ts on every price tick. */
  updateTrailingStops(symbol: string, currentBid: number, currentAsk: number): void {
    for (const order of this.orders.values()) {
      if (order.symbol !== symbol || order.type !== "TRAILING_STOP" || order.status !== "PENDING") {
        continue;
      }

      const trail = order.trailAmount ?? 0;

      if (order.side === "BUY") {
        // Buy trailing stop: stop trails BELOW the falling ask
        const newPeak = Math.max(order.peakPrice ?? -Infinity, currentAsk);
        if (newPeak !== order.peakPrice) {
          order.peakPrice    = newPeak;
          order.triggerPrice = newPeak - trail;
          void this._persist(order);
        }
      } else {
        // Sell trailing stop: stop trails ABOVE the rising bid
        const newPeak = Math.min(order.peakPrice ?? Infinity, currentBid);
        if (newPeak !== order.peakPrice) {
          order.peakPrice    = newPeak;
          order.triggerPrice = newPeak + trail;
          void this._persist(order);
        }
      }
    }
  }

  /**
   * P0-2: Persist a pending order to the DB with up to 3 retries.
   *
   * This is NOT fire-and-forget. If all retries fail, an error is thrown
   * so the caller can remove the in-memory entry and reject the order to
   * the client. A pending order that is not persisted is lost on restart.
   */
  private async _persist(order: PendingOrder): Promise<void> {
    if (!IS_PERSISTENT) return;

    const MAX_ATTEMPTS  = 3;
    const BACKOFF_MS    = 100;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const db = prisma as NonNullable<typeof prisma>;
        await db.brokerSetting.upsert({
          where:  { key: `pending_order:${order.id}` },
          create: { key: `pending_order:${order.id}`, value: order as object },
          update: { value: order as object },
        });
        return; // success
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * attempt));
        }
      }
    }

    console.error(
      `[order-book] CRITICAL: persist failed after ${MAX_ATTEMPTS} attempts for order ${order.id}:`,
      (lastErr as Error).message,
    );
    throw new Error(
      `PENDING_ORDER_PERSIST_FAILED: DB unavailable after ${MAX_ATTEMPTS} attempts — ${(lastErr as Error).message}`
    );
  }

  /**
   * Cancel/update the persisted status. Fire-and-forget is acceptable here
   * because a stale PENDING row in DB is corrected at startup (status check).
   */
  private async _cancelPersisted(id: string, status: string): Promise<void> {
    if (!IS_PERSISTENT) return;
    try {
      const db = prisma as NonNullable<typeof prisma>;
      await db.brokerSetting.upsert({
        where:  { key: `pending_order:${id}` },
        create: { key: `pending_order:${id}`, value: { id, status, cancelledAt: new Date().toISOString() } as object },
        update: { value: { id, status, cancelledAt: new Date().toISOString() } as object },
      });
    } catch {
      // Non-fatal: the order is already removed from memory. On next restart
      // the DB row will be found with status!=PENDING and ignored.
    }
  }
}

export const pendingOrderBook = new PendingOrderBook();
export default pendingOrderBook;
