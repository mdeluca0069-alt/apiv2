/**
 * PositionService — authoritative CRUD layer for open and historical positions.
 *
 * Responsibilities:
 *   - Query positions from the DB (by id, by user, by symbol, by status)
 *   - Update SL/TP on live positions (persisted + risk monitor notified)
 *   - Delegate position close to position.close.ts → SettlementEngine
 *   - Expose aggregate helpers for risk engine (net exposure, open count)
 *
 * This service is intentionally NOT the execution entry point.
 * New positions are opened by ExecutionEngine (called from OrderController).
 * This service handles everything that happens AFTER a position exists.
 */

import { Decimal }           from "@prisma/client/runtime/library";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { closePosition }     from "./position.close.js";
import { positionPriceMonitor } from "./position.price.monitor.js";
import { eventBus }          from "../events-bus/event.bus.js";
import type { BrokerState }  from "../shared/state.js";
import type { CloseResult }  from "./position.close.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PositionStatus = "OPEN" | "CLOSED" | "LIQUIDATED";

export type PositionRecord = {
  id:           string;
  userId:       string;
  orderId:      string | null;
  symbol:       string;
  side:         "BUY" | "SELL";
  quantity:     number;
  entryPrice:   number;
  markPrice:    number | null;
  exitPrice:    number | null;
  pnl:          number | null;
  pnlPercent:   number | null;
  marginUsed:   number;
  leverage:     number;
  stopLoss:     number | null;
  takeProfit:   number | null;
  status:       PositionStatus;
  openedAt:     Date;
  closedAt:     Date | null;
};

export type ListPositionsOptions = {
  status?:  PositionStatus | PositionStatus[];
  symbol?:  string;
  limit?:   number;
  offset?:  number;
  orderBy?: "openedAt" | "closedAt" | "pnl";
  dir?:     "asc" | "desc";
};

export type UpdateSLTPInput = {
  stopLoss?:   number | null;
  takeProfit?: number | null;
};

export type UpdateSLTPResult =
  | { ok: true;  positionId: string; stopLoss: number | null; takeProfit: number | null }
  | { ok: false; reason: string };

// ─── Service ─────────────────────────────────────────────────────────────────

export class PositionService {
  /**
   * Fetch a single position.
   * Verifies ownership — returns null if not found or userId mismatch.
   */
  async getById(positionId: string, userId: string): Promise<PositionRecord | null> {
    if (!IS_PERSISTENT) return null;

    const db  = prisma as NonNullable<typeof prisma>;
    const row = await db.position.findUnique({
      where:  { id: positionId },
      select: this._selectFields(),
    });

    if (!row || row.userId !== userId) return null;
    return this._mapRow(row);
  }

  /**
   * List positions for a user, with optional filtering and pagination.
   */
  async listByUser(
    userId:  string,
    opts:    ListPositionsOptions = {},
  ): Promise<{ positions: PositionRecord[]; total: number }> {
    if (!IS_PERSISTENT) return { positions: [], total: 0 };

    const db         = prisma as NonNullable<typeof prisma>;
    const statusFilter = opts.status
      ? Array.isArray(opts.status) ? opts.status : [opts.status]
      : undefined;

    const where = {
      userId,
      ...(statusFilter ? { status: { in: statusFilter } } : {}),
      ...(opts.symbol   ? { symbol: opts.symbol.toUpperCase() } : {}),
    };

    const [rows, total] = await Promise.all([
      db.position.findMany({
        where,
        select:  this._selectFields(),
        orderBy: { [opts.orderBy ?? "openedAt"]: opts.dir ?? "desc" },
        take:    opts.limit  ?? 50,
        skip:    opts.offset ?? 0,
      }),
      db.position.count({ where }),
    ]);

    return { positions: rows.map((r) => this._mapRow(r)), total };
  }

  /**
   * Count open positions for a user.
   */
  async countOpen(userId: string): Promise<number> {
    if (!IS_PERSISTENT) return 0;
    const db = prisma as NonNullable<typeof prisma>;
    return db.position.count({ where: { userId, status: "OPEN" } });
  }

  /**
   * Net exposure for a symbol: sum of (quantity × entryPrice) for OPEN positions,
   * signed by side (BUY = positive, SELL = negative).
   */
  async netExposure(userId: string, symbol: string): Promise<number> {
    if (!IS_PERSISTENT) return 0;

    const db  = prisma as NonNullable<typeof prisma>;
    const rows = await db.position.findMany({
      where:  { userId, symbol: symbol.toUpperCase(), status: "OPEN" },
      select: { side: true, quantity: true, entryPrice: true },
    });

    return rows.reduce((sum, r) => {
      const notional = r.quantity.toNumber() * r.entryPrice.toNumber();
      return sum + (r.side === "BUY" ? notional : -notional);
    }, 0);
  }

  /**
   * Close a position at market price.
   * Delegates to position.close → SettlementEngine (atomic).
   */
  async close(
    positionId: string,
    userId:     string,
    state:      BrokerState,
  ): Promise<CloseResult> {
    return closePosition(positionId, userId, state);
  }

  /**
   * Update Stop Loss and/or Take Profit on an open position.
   *
   * Validates:
   *   - Position exists and belongs to userId
   *   - Position is OPEN
   *   - SL/TP values are numeric and on the correct side of entry price
   *
   * After DB update, notifies positionPriceMonitor so SL/TP enforcement
   * picks up the new values on the next market.quote event.
   */
  async updateSLTP(
    positionId: string,
    userId:     string,
    input:      UpdateSLTPInput,
  ): Promise<UpdateSLTPResult> {
    if (!IS_PERSISTENT) {
      return { ok: false, reason: "SANDBOX_MODE: SL/TP persistence requires database" };
    }

    const db  = prisma as NonNullable<typeof prisma>;
    const row = await db.position.findUnique({
      where:  { id: positionId },
      select: { userId: true, status: true, side: true, entryPrice: true, symbol: true },
    });

    if (!row)                  return { ok: false, reason: "POSITION_NOT_FOUND" };
    if (row.userId !== userId) return { ok: false, reason: "UNAUTHORIZED" };
    if (row.status !== "OPEN") return { ok: false, reason: `POSITION_${row.status}: cannot modify a closed position` };

    const entry = row.entryPrice.toNumber();

    // Validate SL/TP direction
    if (input.stopLoss !== undefined && input.stopLoss !== null) {
      if (row.side === "BUY"  && input.stopLoss >= entry) {
        return { ok: false, reason: "INVALID_STOP_LOSS: SL must be below entry for BUY positions" };
      }
      if (row.side === "SELL" && input.stopLoss <= entry) {
        return { ok: false, reason: "INVALID_STOP_LOSS: SL must be above entry for SELL positions" };
      }
    }

    if (input.takeProfit !== undefined && input.takeProfit !== null) {
      if (row.side === "BUY"  && input.takeProfit <= entry) {
        return { ok: false, reason: "INVALID_TAKE_PROFIT: TP must be above entry for BUY positions" };
      }
      if (row.side === "SELL" && input.takeProfit >= entry) {
        return { ok: false, reason: "INVALID_TAKE_PROFIT: TP must be below entry for SELL positions" };
      }
    }

    const updateData: Record<string, Decimal | null> = {};
    if (Object.prototype.hasOwnProperty.call(input, "stopLoss")) {
      updateData.stopLoss = input.stopLoss !== null && input.stopLoss !== undefined
        ? new Decimal(input.stopLoss) : null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "takeProfit")) {
      updateData.takeProfit = input.takeProfit !== null && input.takeProfit !== undefined
        ? new Decimal(input.takeProfit) : null;
    }

    await db.position.update({ where: { id: positionId }, data: updateData });

    // Reload updated position into monitor so new SL/TP takes effect immediately
    try {
      await positionPriceMonitor.addPosition(positionId);
    } catch {
      // Non-fatal — monitor will pick it up on next position scan
    }

    eventBus.emit("position.updated", {
      positionId,
      userId,
      symbol:     row.symbol,
      stopLoss:   input.stopLoss  ?? null,
      takeProfit: input.takeProfit ?? null,
      timestamp:  new Date().toISOString(),
    });

    return {
      ok:         true,
      positionId,
      stopLoss:   input.stopLoss  ?? null,
      takeProfit: input.takeProfit ?? null,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private _selectFields() {
    return {
      id:         true,
      userId:     true,
      orderId:    true,
      symbol:     true,
      side:       true,
      quantity:   true,
      entryPrice: true,
      markPrice:  true,
      exitPrice:  true,
      pnl:        true,
      pnlPercent: true,
      marginUsed: true,
      leverage:   true,
      stopLoss:   true,
      takeProfit: true,
      status:     true,
      openedAt:   true,
      closedAt:   true,
    } as const;
  }

  private _mapRow(row: {
    id: string; userId: string; orderId: string | null; symbol: string;
    side: string; quantity: Decimal; entryPrice: Decimal;
    markPrice: Decimal | null; exitPrice: Decimal | null;
    pnl: Decimal | null; pnlPercent: Decimal | null; marginUsed: Decimal;
    leverage: number; stopLoss: Decimal | null; takeProfit: Decimal | null;
    status: string; openedAt: Date; closedAt: Date | null;
  }): PositionRecord {
    return {
      id:         row.id,
      userId:     row.userId,
      orderId:    row.orderId,
      symbol:     row.symbol,
      side:       row.side as "BUY" | "SELL",
      quantity:   row.quantity.toNumber(),
      entryPrice: row.entryPrice.toNumber(),
      markPrice:  row.markPrice?.toNumber() ?? null,
      exitPrice:  row.exitPrice?.toNumber()  ?? null,
      pnl:        row.pnl?.toNumber()        ?? null,
      pnlPercent: row.pnlPercent?.toNumber() ?? null,
      marginUsed: row.marginUsed.toNumber(),
      leverage:   row.leverage,
      stopLoss:   row.stopLoss?.toNumber()   ?? null,
      takeProfit: row.takeProfit?.toNumber() ?? null,
      status:     row.status as PositionStatus,
      openedAt:   row.openedAt,
      closedAt:   row.closedAt,
    };
  }
}

export const positionService = new PositionService();
