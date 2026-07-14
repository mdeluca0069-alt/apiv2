/**
 * StopOutEngine — ESMA-compliant margin call and stop-out liquidation.
 *
 * ESMA rules (MiFID II / CFD regulation):
 *   - Retail clients: mandatory stop-out at 50% margin level.
 *   - Margin level = (equity / marginUsed) × 100.
 *   - When level drops below 50%, ALL open positions must be liquidated,
 *     starting with the position with the largest unrealised loss.
 *
 * Architecture:
 *   - Runs on a scheduled loop (every 30 seconds in main.ts).
 *   - For each user with open positions: compute live equity + margin level.
 *   - If level < STOP_OUT_PCT: liquidate all positions via SettlementEngine.
 *   - Each liquidation is a real DB transaction (atomic, auditable).
 *   - Writes AuditLog, increments metrics counters, emits WebSocket event.
 *
 * Warning levels:
 *   150% → WARNING (notify client)
 *   120% → MARGIN_CALL (restrict new positions)
 *    50% → STOP_OUT (liquidate all)
 */

import { randomUUID }         from "node:crypto";
import { Decimal }            from "@prisma/client/runtime/library";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { quoteCache }         from "../market-data/quote.cache.js";
import { settlementEngine, PositionAlreadyClosedError } from "../settlement/settlement.engine.js";
import { eventBus }           from "../events-bus/event.bus.js";
import { metrics }            from "../gateway/metrics.js";
import { alertManager }       from "../alerting/alert.manager.js";
import { jobCoordinator }     from "../realtime-infra/job.coordinator.js";
import { brokerSpreadConfig } from "../liquidity-engine/broker.spread.config.js";

const STOP_OUT_PCT    = 50;   // ESMA retail mandatory
const MARGIN_CALL_PCT = 100;  // restrict new orders
const WARNING_PCT     = 150;  // notify client

export type StopOutResult = {
  userId:       string;
  marginLevel:  number;
  action:       "NONE" | "WARNING" | "MARGIN_CALL" | "STOP_OUT";
  liquidated:   number;   // number of positions closed
  totalPnl:     number;
  triggeredAt:  string;
  /** FASE 4.2 (Bug #3): positions skipped because their symbol is currently
   *  halted -- only meaningful for action="STOP_OUT". */
  skippedHalted?: number;
};

export type StopOutScanReport = {
  scannedUsers:  number;
  stopOuts:      number;
  marginCalls:   number;
  warnings:      number;
  errors:        string[];
  completedAt:   string;
};

export class StopOutEngine {

  /**
   * Full scan — called every 30 seconds by main.ts scheduler.
   * Checks all users with open positions.
   */
  async scanAll(): Promise<StopOutScanReport> {
    if (!IS_PERSISTENT || !prisma?.position) {
      return { scannedUsers: 0, stopOuts: 0, marginCalls: 0, warnings: 0, errors: [], completedAt: new Date().toISOString() };
    }

    if (!(await jobCoordinator.tryLead("stop-out-scan"))) {
      return { scannedUsers: 0, stopOuts: 0, marginCalls: 0, warnings: 0, errors: [], completedAt: new Date().toISOString() };
    }

    const db = prisma as NonNullable<typeof prisma>;
    let stopOuts = 0, marginCalls = 0, warnings = 0;
    const errors: string[] = [];
    let users: { userId: string }[] = [];

    try {
      // Collect distinct users with open positions
      users = await db.position.findMany({
        where:   { status: "OPEN" },
        select:  { userId: true },
        distinct: ["userId"],
      });

      for (const { userId } of users) {
        try {
          const result = await this.checkUser(userId);
          if (result.action === "STOP_OUT")        stopOuts++;
          else if (result.action === "MARGIN_CALL") marginCalls++;
          else if (result.action === "WARNING")     warnings++;
        } catch (err) {
          errors.push(`userId=${userId}: ${(err as Error).message}`);
        }
      }

      // Alert on stop-out wave (≥5 in a single 30s scan cycle)
      if (stopOuts >= 5) {
        void alertManager.stopOutWave(stopOuts, 0);
      }
    } finally {
      await jobCoordinator.release("stop-out-scan");
    }

    return {
      scannedUsers: users.length,
      stopOuts,
      marginCalls,
      warnings,
      errors,
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Check a single user's margin level and take action if required.
   */
  async checkUser(userId: string): Promise<StopOutResult> {
    if (!IS_PERSISTENT || !prisma?.position) {
      return { userId, marginLevel: 999, action: "NONE", liquidated: 0, totalPnl: 0, triggeredAt: new Date().toISOString() };
    }

    const db = prisma as NonNullable<typeof prisma>;
    const triggeredAt = new Date().toISOString();

    const [wallet, positions] = await Promise.all([
      db.walletAccount.findUnique({
        where:  { userId },
        select: { balance: true, locked: true },
      }),
      db.position.findMany({
        where:  { userId, status: "OPEN" },
        select: {
          id:         true,
          symbol:     true,
          side:       true,
          quantity:   true,
          entryPrice: true,
          marginUsed: true,
          leverage:   true,
          openedAt:   true,
        },
        orderBy: { openedAt: "asc" },  // oldest first (used to sort by largest loss below)
      }),
    ]);

    if (!wallet || positions.length === 0) {
      return { userId, marginLevel: 999, action: "NONE", liquidated: 0, totalPnl: 0, triggeredAt };
    }

    const balance   = wallet.balance.toNumber();
    const locked    = wallet.locked.toNumber();

    // Compute live unrealised P&L for each position
    let totalUnrealized = 0;
    const positionsWithPnl = positions.map((pos) => {
      const quote = quoteCache.get(pos.symbol);
      let pnl = 0;
      let markPrice = pos.entryPrice.toNumber();
      if (quote) {
        markPrice = pos.side === "BUY" ? quote.bid : quote.ask;
        const direction = pos.side === "BUY" ? 1 : -1;
        pnl = (markPrice - pos.entryPrice.toNumber()) * pos.quantity.toNumber() * direction;
      }
      totalUnrealized += pnl;
      return { ...pos, pnl, markPrice };
    });

    const equity      = balance + totalUnrealized;
    const marginUsed  = locked;
    const marginLevel = marginUsed > 0 ? (equity / marginUsed) * 100 : Infinity;

    // ── Action resolution ─────────────────────────────────────────────────────

    if (!Number.isFinite(marginLevel) || marginLevel >= WARNING_PCT) {
      return { userId, marginLevel, action: "NONE", liquidated: 0, totalPnl: 0, triggeredAt };
    }

    // Emit warning notification at 150%
    if (marginLevel >= MARGIN_CALL_PCT && marginLevel < WARNING_PCT) {
      await this._notify(userId, "WARNING", marginLevel);
      await this._saveMarginSnapshot(userId, equity, balance, marginUsed, marginLevel, "WARNING");
      return { userId, marginLevel, action: "WARNING", liquidated: 0, totalPnl: 0, triggeredAt };
    }

    // Restrict new orders at 100% (margin call level)
    if (marginLevel >= STOP_OUT_PCT && marginLevel < MARGIN_CALL_PCT) {
      await this._notify(userId, "MARGIN_CALL", marginLevel);
      await this._saveMarginSnapshot(userId, equity, balance, marginUsed, marginLevel, "MARGIN_CALL");

      // Write risk warning for dashboard
      await db.auditLog.create({
        data: {
          id:      randomUUID(),
          actor:   "risk-engine",
          action:  "margin.call.triggered",
          entity:  `user:${userId}`,
          payload: { marginLevel: marginLevel.toFixed(2), equity, marginUsed } as object,
        },
      });

      metrics.inc("margin_calls_total");
      eventBus.emit("risk.margin_call", { userId, marginLevel, equity, marginUsed, triggeredAt });
      return { userId, marginLevel, action: "MARGIN_CALL", liquidated: 0, totalPnl: 0, triggeredAt };
    }

    // ── STOP-OUT: liquidate all positions ─────────────────────────────────────

    // Sort by largest unrealised loss first (most adverse position closed first)
    const sorted = [...positionsWithPnl].sort((a, b) => a.pnl - b.pnl);

    let liquidated = 0;
    let totalPnl   = 0;
    let skippedHalted = 0;

    for (const pos of sorted) {
      // FASE 4.2 (RISK_ENGINE_FREEZE.md Bug #3): a halted symbol's live
      // price is exactly the price the circuit breaker flagged as anomalous
      // (or an admin flagged as untradeable) — force-closing an existing
      // position against it is the same mistake the halt exists to prevent
      // for new orders. Skip it; the recovery sweep once the halt clears
      // (or the next 30s/tick-level check) will catch it if the user is
      // still below the stop-out floor then. Other positions for this same
      // user on non-halted symbols are still liquidated normally.
      if (!brokerSpreadConfig.isEnabled(pos.symbol)) {
        skippedHalted++;
        continue;
      }

      try {
        const result = await settlementEngine.settle({
          positionId: pos.id,
          userId,
          symbol:     pos.symbol,
          side:       pos.side as "BUY" | "SELL",
          quantity:   pos.quantity.toNumber(),
          entryPrice: pos.entryPrice.toNumber(),
          exitPrice:  pos.markPrice,
          marginUsed: pos.marginUsed.toNumber(),
          leverage:   pos.leverage,
          openedAt:   pos.openedAt,
          reason:     "STOP_OUT",
          detail:     `Stop-out triggered at margin level ${marginLevel.toFixed(1)}% (ESMA floor: ${STOP_OUT_PCT}%)`,
        });

        totalPnl += result.cappedPnl;
        liquidated++;
      } catch (err) {
        if (err instanceof PositionAlreadyClosedError) {
          // Closed concurrently by SL/TP tick or another stop-out sweep — not an error.
          liquidated++; // count it; the other path handled the settlement
        } else {
          console.error(`[stop-out] Failed to settle position ${pos.id}:`, (err as Error).message);
        }
      }
    }

    // Audit + snapshot
    await this._saveMarginSnapshot(userId, equity, balance, marginUsed, marginLevel, "STOP_OUT");

    await db.auditLog.create({
      data: {
        id:      randomUUID(),
        actor:   "risk-engine",
        action:  "stop_out.triggered",
        entity:  `user:${userId}`,
        payload: {
          marginLevel:  marginLevel.toFixed(2),
          equity,
          marginUsed,
          positionsClosed: liquidated,
          totalPnl,
          skippedHalted,
        } as object,
      },
    });

    metrics.inc("stop_out_events_total");
    if (skippedHalted > 0) metrics.inc("stop_out_skipped_halted_total", skippedHalted);
    eventBus.emit("risk.stop_out", {
      userId, marginLevel, equity, marginUsed,
      positionsClosed: liquidated, totalPnl,
      triggeredAt,
    });

    console.warn(`[stop-out] userId=${userId} marginLevel=${marginLevel.toFixed(1)}% closed=${liquidated} totalPnl=${totalPnl}` +
      (skippedHalted > 0 ? ` skippedHalted=${skippedHalted}` : ""));

    // Alert on stop-out — individual stop-outs are WARNING; wave detection in scanAll()
    void alertManager.send({
      type:     "STOP_OUT",
      severity: "WARNING",
      title:    "Stop-Out Triggered",
      message:  `User ${userId} stop-out at ${marginLevel.toFixed(1)}% margin level. ${liquidated} position(s) closed. Net P&L: ${totalPnl.toFixed(2)} USD.`,
      metadata: { userId, marginLevel: marginLevel.toFixed(2), positions: liquidated, totalPnl: totalPnl.toFixed(2) },
    });

    return { userId, marginLevel, action: "STOP_OUT", liquidated, totalPnl, triggeredAt, skippedHalted };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async _notify(userId: string, level: "WARNING" | "MARGIN_CALL", marginLevel: number) {
    if (!prisma?.notification) return;
    const db = prisma as NonNullable<typeof prisma>;

    const messages: Record<string, { title: string; body: string }> = {
      WARNING: {
        title: "Margin Warning",
        body:  `Your margin level has dropped to ${marginLevel.toFixed(0)}%. Add funds or reduce positions to avoid a margin call.`,
      },
      MARGIN_CALL: {
        title: "Margin Call",
        body:  `Margin level is ${marginLevel.toFixed(0)}%. New positions are restricted. Add funds immediately to avoid stop-out.`,
      },
    };

    const msg = messages[level];
    if (!msg) return;

    try {
      await db.notification.create({
        data: {
          id:       randomUUID(),
          userId,
          channel:  "IN_APP",
          category: "margin",
          priority: level === "MARGIN_CALL" ? "CRITICAL" : "HIGH",
          title:    msg.title,
          body:     msg.body,
          payload:  { marginLevel } as object,
        },
      });
    } catch {
      // Non-fatal — stop-out proceeds regardless
    }
  }

  private async _saveMarginSnapshot(
    userId:      string,
    equity:      number,
    balance:     number,
    marginUsed:  number,
    marginLevel: number,
    reason:      string,
  ) {
    if (!prisma?.marginSnapshot) return;
    const db = prisma as NonNullable<typeof prisma>;
    const freeMargin = Math.max(0, equity - marginUsed);

    try {
      await db.marginSnapshot.create({
        data: {
          userId,
          equity:         new Decimal(equity),
          balance:        new Decimal(balance),
          marginUsed:     new Decimal(marginUsed),
          freeMargin:     new Decimal(freeMargin),
          marginLevelPct: new Decimal(marginLevel),
          unrealizedPnl:  new Decimal(equity - balance),
          triggerReason:  reason,
        },
      });
    } catch {
      // Non-fatal
    }
  }
}

export const stopOutEngine = new StopOutEngine();
