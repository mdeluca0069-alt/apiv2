/**
 * PositionPriceMonitor — real-time mark-to-market and SL/TP enforcement.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE MOST CRITICAL MISSING COMPONENT FOR LIVE TRADING.       │
 * │                                                                     │
 * │ Without this service:                                               │
 * │   • Stop-loss orders on open positions are NEVER triggered.         │
 * │   • Take-profit orders on open positions are NEVER triggered.       │
 * │   • UI position P&L is stale after the order fills.                │
 * │                                                                     │
 * │ This service makes IGFXPRO behave like a real broker.               │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Architecture:
 *   1. On startup: loads all OPEN positions into memory (positionCache).
 *   2. Subscribes to `market.quote` events (fires on every price tick).
 *   3. On each quote:
 *      a. Computes mark-to-market P&L for every open position in that symbol.
 *      b. Checks stop-loss and take-profit levels.
 *      c. If SL or TP hit: triggers settlement via settlementEngine (same
 *         pipeline as manual close — atomic, audited, double-entry).
 *      d. Emits `position.pnl_updated` events (WS broadcaster delivers to client).
 *   4. Every DB_FLUSH_INTERVAL_MS: batch-writes updated P&L to PostgreSQL.
 *      (Decoupled from WebSocket so UI gets tick-level updates, DB gets 5s updates.)
 *
 * SL/TP logic (cTrader convention):
 *   BUY  position: SL triggers when BID ≤ stopLoss   (price fell to SL)
 *   BUY  position: TP triggers when BID ≥ takeProfit (price rose to TP)
 *   SELL position: SL triggers when ASK ≥ stopLoss   (price rose to SL)
 *   SELL position: TP triggers when ASK ≤ takeProfit (price fell to TP)
 *
 * Fill price for SL/TP:
 *   BUY  close: fill at BID (client sells at bid, worst-case side)
 *   SELL close: fill at ASK (client buys at ask, worst-case side)
 */

import { Decimal }              from "@prisma/client/runtime/library";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }             from "../events-bus/event.bus.js";
import { pnlCalculator }        from "./pnl.calculator.js";
import { settlementEngine, PositionAlreadyClosedError } from "../settlement/settlement.engine.js";
import { stopOutEngine }        from "./stopout.engine.js";
import { metrics }              from "../gateway/metrics.js";
import type { MarketQuoteEvent } from "../events-bus/event.bus.js";

/**
 * Thrown when addPosition() is called but the monitor is at its memory cap.
 * The caller (order.controller) must log CRITICAL and alert operations.
 * The position itself exists in the DB — SL/TP just won't be auto-triggered.
 */
export class PositionMonitorCapacityError extends Error {
  constructor(public readonly trackedPositions: number, public readonly cap: number) {
    super(
      `POSITION_MONITOR_CAPACITY: monitor is full (${trackedPositions}/${cap} positions). ` +
      `SL/TP will NOT be auto-triggered for new positions until capacity is freed.`
    );
    this.name = "PositionMonitorCapacityError";
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

type CachedPosition = {
  id:         string;
  userId:     string;
  symbol:     string;
  side:       "BUY" | "SELL";
  quantity:   number;
  entryPrice: number;
  markPrice:  number;
  pnl:        number;
  pnlPercent: number;
  marginUsed: number;
  leverage:   number;
  stopLoss:   number | null;
  takeProfit: number | null;
  openedAt:   Date;
};

// ─── Configuration ────────────────────────────────────────────────────────────

const DB_FLUSH_INTERVAL_MS  = 5_000;   // flush P&L to DB every 5 seconds
const MAX_POSITIONS_IN_MEM  = 50_000;  // safety cap for memory
const TICK_STOP_OUT_PCT     = 50;      // ESMA retail mandatory (mirrors StopOutEngine)

// ─── Monitor ─────────────────────────────────────────────────────────────────

export class PositionPriceMonitor {
  private readonly positionCache  = new Map<string, CachedPosition>();
  private readonly settlingIds    = new Set<string>();  // prevent double-trigger
  private readonly dirtyIds       = new Set<string>();  // positions awaiting DB flush
  private readonly walletCache    = new Map<string, { balance: number; locked: number }>();
  private readonly triggeringStop = new Set<string>();  // stop-out in-flight guard
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;

    if (IS_PERSISTENT) {
      await this._loadPositions();
      await this._loadWallets();
    }

    // Subscribe to price ticks
    eventBus.on("market.quote", (q) => this._onQuote(q));

    // Subscribe to position lifecycle events to keep cache in sync
    eventBus.on("position.opened", (evt) => {
      void this._onPositionOpened(evt.positionId);
    });

    eventBus.on("position.closed", (evt) => {
      this.positionCache.delete(evt.positionId);
      this.dirtyIds.delete(evt.positionId);
      // Refresh wallet so the next tick has accurate balance+locked after settlement
      void this._refreshWallet(evt.userId);
    });

    // Keep walletCache in sync with margin lock/release events emitted by execution engine
    eventBus.on("wallet.event", (evt) => {
      const data = evt as unknown as { userId: string; type: string; amount: number };
      const w = this.walletCache.get(data.userId);
      if (!w) return;
      if (data.type === "MARGIN_LOCK")    { w.locked += data.amount; }
      if (data.type === "MARGIN_RELEASE") { w.locked = Math.max(0, w.locked - data.amount); }
    });

    // Start DB flush loop
    this.flushTimer = setInterval(() => void this._flushToDb(), DB_FLUSH_INTERVAL_MS);

    console.log(`[position-monitor] started — ${this.positionCache.size} positions loaded`);
  }

  stop(): void {
    this.active = false;
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
  }

  /** Returns true when the in-memory cache is at the hard cap. */
  isAtCapacity(): boolean {
    return this.positionCache.size >= MAX_POSITIONS_IN_MEM;
  }

  /** Called externally when a new position is opened (after DB write). */
  async addPosition(positionId: string): Promise<void> {
    // P0-3: Enforce capacity BEFORE attempting DB load.
    if (this.isAtCapacity()) {
      metrics.inc("position_monitor_capacity_exceeded_total");
      console.error(
        `[position-monitor] CRITICAL: at capacity (${this.positionCache.size}/${MAX_POSITIONS_IN_MEM}). ` +
        `positionId=${positionId} will NOT be monitored for SL/TP.`
      );
      throw new PositionMonitorCapacityError(this.positionCache.size, MAX_POSITIONS_IN_MEM);
    }
    await this._onPositionOpened(positionId);
  }

  /** Remove a position from cache (called after settlement). */
  removePosition(positionId: string): void {
    this.positionCache.delete(positionId);
    this.dirtyIds.delete(positionId);
  }

  // ── Core tick handler ─────────────────────────────────────────────────────────

  private _onQuote(q: MarketQuoteEvent): void {
    const { symbol, bid, ask } = q;
    if (!symbol || !bid || !ask) return;

    const affectedUsers = new Set<string>();

    // Find all open positions for this symbol
    for (const pos of this.positionCache.values()) {
      if (pos.symbol !== symbol) continue;

      // ── Compute mark-to-market P&L ────────────────────────────────────────
      const { rawPnl, pnlPercent, markPrice } = pnlCalculator.unrealized(
        pos.side, pos.quantity, pos.entryPrice, bid, ask,
      );

      // ── SL/TP check ───────────────────────────────────────────────────────
      const slHit = pos.stopLoss !== null && this._isSlHit(pos.side, pos.stopLoss, bid, ask);
      const tpHit = !slHit && pos.takeProfit !== null && this._isTpHit(pos.side, pos.takeProfit, bid, ask);

      if ((slHit || tpHit) && !this.settlingIds.has(pos.id)) {
        this.settlingIds.add(pos.id);
        const reason = slHit ? "STOP_LOSS" : "TAKE_PROFIT";
        const exitPrice = pos.side === "BUY" ? bid : ask;
        void this._triggerSettlement(pos, exitPrice, reason);
        continue;  // skip P&L update, position is closing
      }

      // ── Update in-memory cache ────────────────────────────────────────────
      pos.markPrice  = markPrice;
      pos.pnl        = rawPnl;
      pos.pnlPercent = pnlPercent;
      this.dirtyIds.add(pos.id);
      affectedUsers.add(pos.userId);

      // ── Emit real-time P&L update to WebSocket clients ────────────────────
      eventBus.emit("position.pnl_updated", {
        positionId:  pos.id,
        userId:      pos.userId,
        symbol:      pos.symbol,
        markPrice,
        pnl:         rawPnl,
        pnlPercent,
        timestamp:   new Date().toISOString(),
      });
    }

    // ── Tick-level stop-out check (P0 fix) ────────────────────────────────
    if (affectedUsers.size > 0) {
      this._checkTickStopOut(affectedUsers);
    }
  }

  // ── SL/TP evaluation ─────────────────────────────────────────────────────────

  private _isSlHit(side: "BUY" | "SELL", sl: number, bid: number, ask: number): boolean {
    // BUY: SL triggers when BID drops to or below the stop-loss price
    // SELL: SL triggers when ASK rises to or above the stop-loss price
    return side === "BUY" ? bid <= sl : ask >= sl;
  }

  private _isTpHit(side: "BUY" | "SELL", tp: number, bid: number, ask: number): boolean {
    // BUY: TP triggers when BID rises to or above take-profit
    // SELL: TP triggers when ASK drops to or below take-profit
    return side === "BUY" ? bid >= tp : ask <= tp;
  }

  // ── Settlement trigger ────────────────────────────────────────────────────────

  private async _triggerSettlement(
    pos:       CachedPosition,
    exitPrice: number,
    reason:    "STOP_LOSS" | "TAKE_PROFIT",
  ): Promise<void> {
    try {
      await settlementEngine.settle({
        positionId: pos.id,
        userId:     pos.userId,
        symbol:     pos.symbol,
        side:       pos.side,
        quantity:   pos.quantity,
        entryPrice: pos.entryPrice,
        exitPrice,
        marginUsed: pos.marginUsed,
        leverage:   pos.leverage,
        openedAt:   pos.openedAt,
        reason,
        detail:     `${reason === "STOP_LOSS" ? "Stop-loss" : "Take-profit"} triggered at ${exitPrice}`,
      });

      // Successful settlement — remove from all tracking sets.
      this.positionCache.delete(pos.id);
      this.dirtyIds.delete(pos.id);
      this.settlingIds.delete(pos.id);
      metrics.inc(reason === "STOP_LOSS" ? "stop_loss_triggers_total" : "take_profit_triggers_total");

    } catch (err) {
      if (err instanceof PositionAlreadyClosedError) {
        // Position was closed concurrently by another path (e.g. stopout, manual close).
        // This is not an error — remove from cache so we stop trying.
        this.positionCache.delete(pos.id);
        this.dirtyIds.delete(pos.id);
        this.settlingIds.delete(pos.id);
        return;
      }

      // Transient error (DB down, serialization failure, etc).
      // Remove from settlingIds so the next tick can retry settlement.
      // Position stays in positionCache — this is intentional for retry.
      console.error(
        `[position-monitor] ${reason} settlement failed pos=${pos.id} — will retry on next tick:`,
        (err as Error).message,
      );
      this.settlingIds.delete(pos.id);
    }
  }

  // ── DB flush (batch write every 5 seconds) ────────────────────────────────────

  private async _flushToDb(): Promise<void> {
    if (!IS_PERSISTENT || !this.dirtyIds.size || !prisma?.position) return;
    const db = prisma as NonNullable<typeof prisma>;

    const ids = Array.from(this.dirtyIds).slice(0, 500);  // batch cap
    this.dirtyIds.clear();

    const updates = ids
      .map((id) => this.positionCache.get(id))
      .filter((p): p is CachedPosition => p !== undefined);

    if (!updates.length) return;

    await Promise.all(
      updates.map((pos) =>
        db.position.updateMany({
          where: { id: pos.id, status: "OPEN" },
          data: {
            markPrice:  new Decimal(pos.markPrice),
            pnl:        new Decimal(pos.pnl),
            pnlPercent: new Decimal(pos.pnlPercent),
          },
        }).catch(() => { /* position may have closed between tick and flush */ }),
      ),
    );
  }

  // ── Cache management ──────────────────────────────────────────────────────────

  private async _loadPositions(): Promise<void> {
    if (!prisma?.position) return;
    const db = prisma as NonNullable<typeof prisma>;

    const positions = await db.position.findMany({
      where:  { status: "OPEN" },
      select: {
        id: true, userId: true, symbol: true, side: true,
        quantity: true, entryPrice: true, markPrice: true,
        pnl: true, pnlPercent: true, marginUsed: true, leverage: true,
        stopLoss: true, takeProfit: true, openedAt: true,
      },
      take: MAX_POSITIONS_IN_MEM,
    });

    for (const pos of positions) {
      this.positionCache.set(pos.id, {
        id:         pos.id,
        userId:     pos.userId,
        symbol:     pos.symbol,
        side:       pos.side as "BUY" | "SELL",
        quantity:   pos.quantity.toNumber(),
        entryPrice: pos.entryPrice.toNumber(),
        markPrice:  pos.markPrice.toNumber(),
        pnl:        pos.pnl.toNumber(),
        pnlPercent: pos.pnlPercent.toNumber(),
        marginUsed: pos.marginUsed.toNumber(),
        leverage:   pos.leverage,
        stopLoss:   pos.stopLoss?.toNumber() ?? null,
        takeProfit: pos.takeProfit?.toNumber() ?? null,
        openedAt:   pos.openedAt,
      });
    }
  }

  private async _onPositionOpened(positionId: string): Promise<void> {
    if (!IS_PERSISTENT || !positionId || !prisma?.position) return;

    // Secondary capacity guard — covers the event.on("position.opened") path.
    if (this.positionCache.size >= MAX_POSITIONS_IN_MEM) {
      console.error(
        `[position-monitor] CRITICAL: at capacity, skipping position.opened for positionId=${positionId}`
      );
      return;
    }

    const db = prisma as NonNullable<typeof prisma>;

    try {
      const pos = await db.position.findUnique({
        where:  { id: positionId },
        select: {
          id: true, userId: true, symbol: true, side: true,
          quantity: true, entryPrice: true, markPrice: true,
          pnl: true, pnlPercent: true, marginUsed: true, leverage: true,
          stopLoss: true, takeProfit: true, openedAt: true, status: true,
        },
      });

      if (!pos || pos.status !== "OPEN") return;

      this.positionCache.set(pos.id, {
        id:         pos.id,
        userId:     pos.userId,
        symbol:     pos.symbol,
        side:       pos.side as "BUY" | "SELL",
        quantity:   pos.quantity.toNumber(),
        entryPrice: pos.entryPrice.toNumber(),
        markPrice:  pos.markPrice.toNumber(),
        pnl:        pos.pnl.toNumber(),
        pnlPercent: pos.pnlPercent.toNumber(),
        marginUsed: pos.marginUsed.toNumber(),
        leverage:   pos.leverage,
        stopLoss:   pos.stopLoss?.toNumber() ?? null,
        takeProfit: pos.takeProfit?.toNumber() ?? null,
        openedAt:   pos.openedAt,
      });

      // Ensure wallet is cached for tick-level stop-out checks
      if (!this.walletCache.has(pos.userId)) {
        void this._refreshWallet(pos.userId);
      }
    } catch {
      // Non-fatal — position will be loaded on next full refresh
    }
  }

  // ── Tick-level stop-out (P0 fix) ──────────────────────────────────────────────

  /**
   * Per-tick margin level check for all users whose positions were updated by
   * this quote. Delegates liquidation to stopOutEngine.checkUser() — same atomic
   * settlement pipeline used by the 30s fallback scan.
   *
   * Guard: triggeringStop prevents re-entrant calls for the same user while a
   * prior stop-out is still settling (async). The 30s scanAll() remains active
   * as a fallback for any user missed by the tick path.
   */
  private _checkTickStopOut(affectedUsers: Set<string>): void {
    for (const userId of affectedUsers) {
      if (this.triggeringStop.has(userId)) continue;

      const wallet = this.walletCache.get(userId);
      if (!wallet || wallet.locked <= 0) continue;

      // Sum unrealised P&L across ALL this user's open positions (all symbols)
      let totalPnl = 0;
      for (const pos of this.positionCache.values()) {
        if (pos.userId === userId) totalPnl += pos.pnl;
      }

      const equity      = wallet.balance + totalPnl;
      const marginLevel = (equity / wallet.locked) * 100;

      if (marginLevel <= TICK_STOP_OUT_PCT) {
        this.triggeringStop.add(userId);
        metrics.inc("tick_stop_out_triggered_total");
        console.warn(
          `[position-monitor] tick stop-out userId=${userId} ` +
          `marginLevel=${marginLevel.toFixed(1)}% equity=${equity.toFixed(2)} locked=${wallet.locked.toFixed(2)}`
        );

        void stopOutEngine.checkUser(userId)
          .then((result) => {
            if (result.action === "STOP_OUT") {
              console.warn(`[position-monitor] tick stop-out settled userId=${userId} closed=${result.liquidated}`);
            }
          })
          .catch((err: unknown) => {
            console.error(`[position-monitor] tick stop-out error userId=${userId}:`, (err as Error).message);
          })
          .finally(() => {
            this.triggeringStop.delete(userId);
            // Refresh wallet after settlement so the next tick has accurate state
            void this._refreshWallet(userId);
          });
      }
    }
  }

  /** Load wallet snapshot for every user currently in positionCache. */
  private async _loadWallets(): Promise<void> {
    if (!IS_PERSISTENT || !prisma?.walletAccount) return;
    const db = prisma as NonNullable<typeof prisma>;

    const userIds = [...new Set([...this.positionCache.values()].map((p) => p.userId))];
    if (userIds.length === 0) return;

    const wallets = await db.walletAccount.findMany({
      where:  { userId: { in: userIds } },
      select: { userId: true, balance: true, locked: true },
    });

    for (const w of wallets) {
      this.walletCache.set(w.userId, {
        balance: w.balance.toNumber(),
        locked:  w.locked.toNumber(),
      });
    }
  }

  /** Reload a single user's wallet from DB (called after settlement or position events). */
  private async _refreshWallet(userId: string): Promise<void> {
    if (!IS_PERSISTENT || !prisma?.walletAccount) return;
    const db = prisma as NonNullable<typeof prisma>;

    try {
      const w = await db.walletAccount.findUnique({
        where:  { userId },
        select: { balance: true, locked: true },
      });
      if (w) {
        this.walletCache.set(userId, {
          balance: w.balance.toNumber(),
          locked:  w.locked.toNumber(),
        });
      }
    } catch {
      // Non-fatal — stale walletCache entry is acceptable; 30s fallback covers it
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────

  getStats() {
    return {
      trackedPositions:  this.positionCache.size,
      walletsCached:     this.walletCache.size,
      capacityLimit:     MAX_POSITIONS_IN_MEM,
      atCapacity:        this.isAtCapacity(),
      settlingCount:     this.settlingIds.size,
      pendingDbFlush:    this.dirtyIds.size,
      triggeringStopOut: this.triggeringStop.size,
    };
  }
}

export const positionPriceMonitor = new PositionPriceMonitor();
