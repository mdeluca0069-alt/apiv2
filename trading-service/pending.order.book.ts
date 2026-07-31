import { randomUUID }   from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }      from "../events-bus/event.bus.js";
import { publishControlChannel, subscribeControlChannel } from "../shared/control.channel.js";

const CHANNEL = "pending-order";

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
 *
 * PHASE2_REMEDIATION (H1/H3): `orders` is a private, per-process Map, and
 * initialize() only loads the DB's PENDING set ONCE at boot -- an order
 * added on worker A after every worker has already started is persisted
 * to the DB but never pushed into worker B/C's local Map. Three
 * consequences, all now fixed:
 *   (a) VISIBILITY: cancel()/getForUser() did a local-Map-only lookup, so
 *       a cancel request or order-list read landing on a worker that never
 *       saw the order (originally created elsewhere) silently reported
 *       "not found" / omitted it, even though the order was genuinely
 *       still live. Fixed with startSync() (broadcasts add()/cancel() over
 *       the same control-channel pattern kill.switch.ts/broker.spread.
 *       config.ts already use) PLUS a DB-backed fallback claim in cancel()
 *       itself, so cancellation is correct even if a broadcast was missed
 *       (Redis pub/sub is best-effort, no replay/persistence).
 *   (b) EXPIRY: pending.order.expiry.ts's leader-elected sweep called
 *       getAll() (local Map only) -- an order invisible to the elected
 *       leader's own Map could never expire, no matter how long past its
 *       expiresAt, until that worker happened to restart. Fixed by adding
 *       getExpiredFromSource(), which the sweep now uses instead --
 *       queries the DB directly so the leader's view is complete
 *       regardless of which worker originally created each order.
 *   (c) TRIGGER SINGLE-POINT-OF-FAILURE: only the worker holding an order
 *       locally could ever act on a price tick crossing its level (every
 *       worker's OrderTriggerWatcher sees every tick, but each only
 *       evaluates its OWN local Map). startSync() fixes this as a side
 *       effect -- once broadcast, every worker's watcher can act on it,
 *       safely, because markTriggered()'s C6 atomic DB claim already
 *       guarantees exactly one replica wins regardless of how many have
 *       the order locally.
 * markTriggered() itself also gained a DB-fallback claim path (mirroring
 * cancel()'s) so the expiry sweep's DB-sourced candidates can be claimed
 * even when the elected leader never had them in its local Map at all.
 */
class PendingOrderBook {
  private orders: Map<string, PendingOrder> = new Map();
  private initialized = false;

  // PHASE2_REMEDIATION (H1/H3): tracks ids this worker has itself removed
  // (triggered/cancelled) recently, so a late/out-of-order "add" broadcast
  // for the same id (Redis pub/sub gives no ordering guarantee across
  // network hiccups) can't resurrect an order this worker already knows
  // reached a terminal state. Bounded so long-running processes don't leak
  // memory — old entries fall off in insertion order once the cap is hit,
  // which is safe: the resurrection window this guards against is a race
  // measured in seconds/minutes, not the process lifetime.
  private recentlyTerminal: Set<string> = new Set();
  private static readonly TERMINAL_TRACK_LIMIT = 5000;

  private _markTerminalLocally(id: string): void {
    this.recentlyTerminal.add(id);
    if (this.recentlyTerminal.size > PendingOrderBook.TERMINAL_TRACK_LIMIT) {
      const oldest = this.recentlyTerminal.values().next().value;
      if (oldest !== undefined) this.recentlyTerminal.delete(oldest);
    }
  }

  /**
   * PHASE2_REMEDIATION (H1/H3): subscribes to cross-worker add()/cancel()
   * broadcasts so this worker's local Map converges with every other
   * worker's, close to real-time, instead of only at boot. No-op (single-
   * worker-safe) with no Redis configured — mirrors kill.switch.ts's
   * startSync(). Call once at startup, after initialize().
   */
  async startSync(): Promise<void> {
    await subscribeControlChannel(CHANNEL, (payload) => {
      const msg = payload as { type: "add" | "remove"; order?: PendingOrder; id?: string };
      if (msg.type === "add" && msg.order) {
        const order = msg.order;
        // Don't resurrect an order this worker already has locally, or
        // already knows is terminal (e.g. it triggered/cancelled locally
        // and this add-broadcast is a late/out-of-order echo).
        if (this.orders.has(order.id) || this.recentlyTerminal.has(order.id)) return;
        order.createdAt = new Date(order.createdAt);
        if (order.expiresAt) order.expiresAt = new Date(order.expiresAt);
        this.orders.set(order.id, order);
      } else if (msg.type === "remove" && msg.id) {
        this.orders.delete(msg.id);
        this._markTerminalLocally(msg.id);
      }
    });
  }

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

    // PHASE2_REMEDIATION (H1/H3): converge every other worker's local Map
    // so this order is visible/cancellable/triggerable cluster-wide, not
    // just on the worker that happened to handle this placement request.
    void publishControlChannel(CHANNEL, { type: "add", order: pending });

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

  /**
   * PHASE2_REMEDIATION (H1/H3): used by pending.order.expiry.ts's leader-
   * elected sweep INSTEAD OF getAll() — getAll() only reflects orders this
   * particular worker happens to have locally, which could permanently
   * exclude orders created on a different replica (they would then never
   * expire, no matter how long past their expiresAt). Reads the true,
   * cluster-wide PENDING set straight from the DB. In non-persistent
   * (sandbox/test) mode there is only ever one process, so the local Map
   * already IS the complete set.
   */
  async getExpiredFromSource(now: Date): Promise<PendingOrder[]> {
    if (!IS_PERSISTENT) {
      return this.getAll().filter((o) => o.expiresAt != null && o.expiresAt <= now);
    }
    try {
      const db   = prisma as NonNullable<typeof prisma>;
      const rows = await db.brokerSetting.findMany({ where: { key: { startsWith: "pending_order:" } } });
      const expired: PendingOrder[] = [];
      for (const row of rows) {
        const o = row.value as unknown as PendingOrder;
        if (o?.status !== "PENDING" || !o.expiresAt) continue;
        const expiresAt = new Date(o.expiresAt);
        if (expiresAt <= now) {
          o.createdAt = new Date(o.createdAt);
          o.expiresAt = expiresAt;
          expired.push(o);
        }
      }
      return expired;
    } catch (err) {
      console.error("[order-book] getExpiredFromSource DB scan failed:", (err as Error).message);
      return [];
    }
  }

  async cancel(pendingId: string, userId: string): Promise<boolean> {
    const order = this.orders.get(pendingId);
    if (order) {
      if (order.userId !== userId || order.status !== "PENDING") return false;

      await this._cancelOne(order, "CLIENT_CANCEL");

      // FASE 3.6: cancelling one OCO leg cancels its sibling too — an OCO pair
      // resolves together, whichever leg the client acts on first.
      if (order.ocoGroupId) {
        await this._cancelGroupSiblings(order.ocoGroupId, order.id, "OCO_SIBLING_CANCELLED");
      }

      return true;
    }

    // PHASE2_REMEDIATION (H1/H3): not in this worker's local Map -- it may
    // genuinely be resting on a different replica (created there, or this
    // worker hasn't received the add() broadcast yet — best-effort pub/sub
    // has no delivery guarantee). Fall back to an atomic, ownership-checked
    // claim against the persisted row: the same conditional-UPDATE pattern
    // C6 already uses for trigger-claiming, so cancellation is correct
    // regardless of which worker created the order or whether any
    // broadcast was ever received.
    if (!IS_PERSISTENT) return false;

    const claimed = await this._claimStatusChange(pendingId, "CANCELLED", userId);
    if (!claimed) return false;

    this.orders.delete(pendingId); // clear any stale local copy, if one existed
    this._markTerminalLocally(pendingId);
    eventBus.emit("order.cancelled", {
      orderId:   claimed.orderId,
      pendingId: claimed.id,
      userId:    claimed.userId,
      symbol:    claimed.symbol,
      reason:    "CLIENT_CANCEL",
      timestamp: new Date().toISOString(),
    });
    void publishControlChannel(CHANNEL, { type: "remove", id: pendingId });

    if (claimed.ocoGroupId) {
      await this._cancelGroupSiblings(claimed.ocoGroupId, claimed.id, "OCO_SIBLING_CANCELLED");
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

    // PHASE2_REMEDIATION (H1/H3): an OCO sibling resting on a DIFFERENT
    // replica isn't in this worker's local Map at all, so the loop above
    // would silently miss it, leaving the pair with one leg cancelled and
    // the other still live indefinitely. Scan the DB for any PENDING
    // sibling not already handled above and claim it the same way
    // cancel()'s DB fallback does.
    if (!IS_PERSISTENT) return;
    try {
      const db   = prisma as NonNullable<typeof prisma>;
      const rows = await db.brokerSetting.findMany({ where: { key: { startsWith: "pending_order:" } } });
      for (const row of rows) {
        const o = row.value as unknown as PendingOrder;
        if (o?.ocoGroupId !== ocoGroupId || o.id === excludeId || o.status !== "PENDING") continue;
        if (siblings.some((s) => s.id === o.id)) continue; // already handled locally above

        const claimed = await this._claimStatusChange(o.id, "CANCELLED");
        if (!claimed) continue;
        this.orders.delete(o.id);
        this._markTerminalLocally(o.id);
        eventBus.emit("order.cancelled", {
          orderId: claimed.orderId, pendingId: claimed.id, userId: claimed.userId,
          symbol: claimed.symbol, reason, timestamp: new Date().toISOString(),
        });
        void publishControlChannel(CHANNEL, { type: "remove", id: o.id });
      }
    } catch (err) {
      console.error(`[order-book] OCO sibling DB scan failed for group ${ocoGroupId}:`, (err as Error).message);
    }
  }

  private async _cancelOne(order: PendingOrder, reason: string): Promise<void> {
    order.status = "CANCELLED";
    this.orders.delete(order.id);
    this._markTerminalLocally(order.id);
    await this._cancelPersisted(order.id, "CANCELLED");

    eventBus.emit("order.cancelled", {
      orderId:   order.orderId,
      pendingId: order.id,
      userId:    order.userId,
      symbol:    order.symbol,
      reason,
      timestamp: new Date().toISOString(),
    });

    void publishControlChannel(CHANNEL, { type: "remove", id: order.id });
  }

  /**
   * CRITICAL_REMEDIATION (C6): cross-replica duplicate order fill.
   *
   * Root cause, confirmed via code trace (this codebase runs 3 API
   * replicas): `orders` is a private, per-process Map. Every replica loads
   * the SAME set of PENDING orders from the DB independently at startup
   * (initialize(), above) and every replica runs its own
   * OrderTriggerWatcher subscribed to the cluster-wide `market.quote`
   * event (see Task 9's Redis Pub/Sub WS fan-out). When a price tick
   * crosses a resting order's trigger level, EVERY replica's watcher
   * observes the same tick and independently finds that order still
   * status="PENDING" in its own local Map -- there was no coordination
   * step between "detect trigger" and "commit to executing it", only this
   * method's local, in-process mutation. Nor does the downstream layer
   * help: OrderLifecycle.transition()'s `UPDATE "Order" SET status = ...
   * WHERE id = orderId` (order.lifecycle.ts) has no `AND status =
   * <expected-from-state>` guard, so it does not reject a second,
   * concurrent transition either. Net effect: N replicas racing on the
   * same tick can each call orderController.executePendingOrder() for the
   * SAME pending order, producing N real fills -- N positions opened, N
   * margin holds, N ledger entries -- for what was submitted, and should
   * execute, as a single order.
   *
   * Fix: before committing to TRIGGERED locally, atomically claim the
   * order's PERSISTED row via a single conditional UPDATE (`WHERE
   * value->>'status' = 'PENDING'`) -- Postgres's own row-level locking
   * guarantees that when two replicas race this statement against the
   * same key, exactly one affects a row and the other affects zero. No
   * new coordination infrastructure needed: pending orders are already
   * persisted to BrokerSetting as the source of truth used to survive
   * restarts (see _persist()/initialize() above); this reuses that same
   * row as the cross-replica arbitration point instead of introducing a
   * dependency on Redis (a Redis-based lock would itself reopen this gap
   * during a Redis outage -- see DistributedJobLock's documented
   * degraded-mode fallback, which is correct for idempotent periodic jobs
   * but not safe here, where there was no other idempotency guard).
   *
   * In non-persistent (sandbox/dev/test) mode there is only ever one
   * process and no DB-backed row to arbitrate over, so the pre-existing
   * in-memory-only behavior is preserved unchanged.
   */
  async markTriggered(pendingId: string): Promise<PendingOrder | null> {
    const order = this.orders.get(pendingId);

    if (order) {
      if (order.status !== "PENDING") return null;

      if (IS_PERSISTENT) {
        const claimed = await this._claimStatusChange(pendingId, "TRIGGERED");
        if (!claimed) {
          // Another replica won the race and already claimed this order --
          // drop our now-stale local copy too, so this replica stops
          // re-evaluating it on every subsequent tick.
          this.orders.delete(pendingId);
          this._markTerminalLocally(pendingId);
          return null;
        }
      }

      order.status = "TRIGGERED";
      this.orders.delete(pendingId);
      this._markTerminalLocally(pendingId);
      return order;
    }

    // PHASE2_REMEDIATION (H1/H3): not in this worker's local Map -- this is
    // now expected for the expiry sweep's leader, which sources expiry
    // candidates straight from the DB (getExpiredFromSource()) rather than
    // its own possibly-incomplete local Map. Claim + return the persisted
    // row directly; same atomic conditional UPDATE as the local path above.
    if (!IS_PERSISTENT) return null;
    const claimed = await this._claimStatusChange(pendingId, "TRIGGERED");
    if (claimed) this._markTerminalLocally(pendingId);
    return claimed;
  }

  /**
   * Atomically flips the persisted row's status PENDING -> `toStatus`
   * (optionally scoped to a specific owning user for cancel()'s ownership
   * check) and returns the full, updated order if THIS call is the one
   * that made the change — Postgres's row-level locking guarantees that
   * when multiple replicas race this statement against the same key,
   * exactly one affects a row and every other one affects zero. Returns
   * null (without throwing) if the row was already claimed by another
   * replica, already in a non-PENDING state, owned by a different user
   * (when expectedUserId is given), or doesn't exist.
   */
  private async _claimStatusChange(
    id: string,
    toStatus: "TRIGGERED" | "CANCELLED",
    expectedUserId?: string,
  ): Promise<PendingOrder | null> {
    try {
      const db = prisma as NonNullable<typeof prisma>;
      const jsonStatus = JSON.stringify(toStatus);
      const rows = expectedUserId
        ? await db.$queryRaw<{ value: PendingOrder }[]>`
            UPDATE "BrokerSetting"
            SET value = jsonb_set(value, '{status}', ${jsonStatus}::jsonb)
            WHERE key = ${`pending_order:${id}`}
              AND value->>'status' = 'PENDING'
              AND value->>'userId' = ${expectedUserId}
            RETURNING value`
        : await db.$queryRaw<{ value: PendingOrder }[]>`
            UPDATE "BrokerSetting"
            SET value = jsonb_set(value, '{status}', ${jsonStatus}::jsonb)
            WHERE key = ${`pending_order:${id}`}
              AND value->>'status' = 'PENDING'
            RETURNING value`;
      if (rows.length === 0) return null;
      const claimed = rows[0]!.value;
      claimed.createdAt = new Date(claimed.createdAt);
      if (claimed.expiresAt) claimed.expiresAt = new Date(claimed.expiresAt as unknown as string);
      return claimed;
    } catch (err) {
      // Fail closed: if we can't confirm the claim, do not proceed -- a
      // missed trigger/cancel this cycle is re-evaluated on the next one
      // (the order remains PENDING); a duplicate fill is not recoverable.
      console.error(`[order-book] claim(${toStatus}) failed for ${id}:`, (err as Error).message);
      return null;
    }
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
