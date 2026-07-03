/**
 * TradeLifecycleService — persists discrete trade lifecycle events to TradeAudit.
 *
 * Every state transition in a trade (OPEN → CLOSED, rejected, partial fill,
 * stop-loss trigger, take-profit trigger, stop-out) is appended here as an
 * immutable record on the TradeAudit row.
 *
 * This is the audit engine's entry point for the trading layer.
 * SettlementEngine calls updateClose(); ExecutionEngine calls recordOpen();
 * StopOutEngine calls updateClose with reason=STOP_OUT.
 */

import { Decimal }             from "@prisma/client/runtime/library";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }            from "../events-bus/event.bus.js";

export type TradeLifecycleEvent = {
  status:    string;
  timestamp: string;
  detail:    string;
  actor:     string;
  price?:    number;
  pnl?:      number;
};

export class TradeLifecycleService {

  /**
   * Record a new trade opening on TradeAudit.
   * Called by ExecutionEngine after a successful fill.
   */
  async recordOpen(params: {
    orderId:     string;
    positionId:  string;
    userId:      string;
    symbol:      string;
    side:        "BUY" | "SELL";
    quantity:    number;
    entryPrice:  number;
    marginUsed:  number;
    leverage:    number;
    stopLoss?:   number;
    takeProfit?: number;
    riskMetrics?: object;
  }): Promise<void> {
    if (!IS_PERSISTENT || !prisma?.tradeAudit) return;
    const db = prisma as NonNullable<typeof prisma>;

    const lifecycle: TradeLifecycleEvent[] = [{
      status:    "OPEN",
      timestamp: new Date().toISOString(),
      detail:    `Position opened at ${params.entryPrice}`,
      actor:     "EXECUTION_ENGINE",
      price:     params.entryPrice,
    }];

    try {
      // Upsert: if audit row already exists (e.g. from ExecutionEngine), update it;
      // otherwise create fresh.
      const existing = await db.tradeAudit.findFirst({
        where:   { positionId: params.positionId },
        select:  { id: true },
      });

      if (existing) {
        await db.tradeAudit.update({
          where: { id: existing.id },
          data:  { lifecycle: lifecycle as object },
        });
      } else {
        await db.tradeAudit.create({
          data: {
            userId:        params.userId,
            orderId:       params.orderId,
            positionId:    params.positionId,
            symbol:        params.symbol,
            side:          params.side,
            quantity:      new Decimal(params.quantity),
            entryPrice:    new Decimal(params.entryPrice),
            marginUsed:    new Decimal(params.marginUsed),
            leverage:      params.leverage,
            stopLoss:      params.stopLoss   ? new Decimal(params.stopLoss)   : null,
            takeProfit:    params.takeProfit ? new Decimal(params.takeProfit) : null,
            tradeStatus:   "OPEN",
            lifecycle:     lifecycle as object,
            riskMetrics:   (params.riskMetrics ?? {}) as object,
          },
        });
      }
    } catch (err) {
      console.error("[trade-lifecycle] recordOpen failed:", (err as Error).message);
    }
  }

  /**
   * Record a position close on TradeAudit.
   * Called by SettlementEngine (MANUAL, STOP_LOSS, TAKE_PROFIT, STOP_OUT, ADMIN).
   */
  async recordClose(params: {
    positionId:  string;
    userId:      string;
    symbol:      string;
    side:        "BUY" | "SELL";
    quantity:    number;
    exitPrice:   number;
    pnlRealized: number;
    fees:        number;
    slippage:    number;
    reason:      string;
    durationMs:  number;
  }): Promise<void> {
    if (!IS_PERSISTENT || !prisma?.tradeAudit) return;
    const db = prisma as NonNullable<typeof prisma>;

    const closeEvent: TradeLifecycleEvent = {
      status:    "CLOSED",
      timestamp: new Date().toISOString(),
      detail:    `Position closed via ${params.reason} at ${params.exitPrice}. PnL: ${params.pnlRealized.toFixed(2)}`,
      actor:     "SETTLEMENT_ENGINE",
      price:     params.exitPrice,
      pnl:       params.pnlRealized,
    };

    const durationMin = Math.round(params.durationMs / 60_000);

    try {
      const existing = await db.tradeAudit.findFirst({
        where:  { positionId: params.positionId },
        select: { id: true, lifecycle: true },
      });

      const prevLifecycle = (existing?.lifecycle as TradeLifecycleEvent[] | null) ?? [];
      const lifecycle = [...prevLifecycle, closeEvent];

      if (existing) {
        await db.tradeAudit.update({
          where: { id: existing.id },
          data: {
            exitPrice:   new Decimal(params.exitPrice),
            pnlRealized: new Decimal(params.pnlRealized),
            fees:        new Decimal(params.fees),
            slippage:    new Decimal(params.slippage),
            duration:    durationMin,
            tradeStatus: "CLOSED",
            closedAt:    new Date(),
            lifecycle:   lifecycle as object,
          },
        });
      } else {
        // Trade closed without an open record (recovery scenario)
        await db.tradeAudit.create({
          data: {
            userId:      params.userId,
            positionId:  params.positionId,
            symbol:      params.symbol,
            side:        params.side,
            quantity:    new Decimal(params.quantity),
            exitPrice:   new Decimal(params.exitPrice),
            pnlRealized: new Decimal(params.pnlRealized),
            fees:        new Decimal(params.fees),
            slippage:    new Decimal(params.slippage),
            duration:    durationMin,
            tradeStatus: "CLOSED",
            closedAt:    new Date(),
            lifecycle:   lifecycle as object,
            riskMetrics: {} as object,
          },
        });
      }

      eventBus.emit("trade.closed", {
        positionId: params.positionId,
        userId:     params.userId,
        symbol:     params.symbol,
        pnl:        params.pnlRealized,
        reason:     params.reason,
        closedAt:   new Date().toISOString(),
      });
    } catch (err) {
      console.error("[trade-lifecycle] recordClose failed:", (err as Error).message);
    }
  }

  /**
   * Append a lifecycle event without changing status.
   * Used for partial fills, order amendments, etc.
   */
  async appendEvent(positionId: string, event: TradeLifecycleEvent): Promise<void> {
    if (!IS_PERSISTENT || !prisma?.tradeAudit) return;
    const db = prisma as NonNullable<typeof prisma>;

    try {
      const existing = await db.tradeAudit.findFirst({
        where:  { positionId },
        select: { id: true, lifecycle: true },
      });
      if (!existing) return;

      const prev = (existing.lifecycle as TradeLifecycleEvent[] | null) ?? [];
      await db.tradeAudit.update({
        where: { id: existing.id },
        data:  { lifecycle: [...prev, event] as object },
      });
    } catch {
      // Non-fatal
    }
  }
}

export const tradeLifecycleService = new TradeLifecycleService();
