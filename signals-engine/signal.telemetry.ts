/**
 * SignalTelemetry — persistent self-measurement layer for OLOS signals.
 *
 * Lifecycle of a signal record:
 *   1. recordSignal()     — created immediately when SignalGenerator emits a signal
 *   2. linkPosition()     — updated when autopilot executes the signal into a real position
 *   3. updateMFEMAE()     — called on every price tick for each tracked position
 *   4. updateOutcome()    — finalised when the position closes (WIN/LOSS/BREAKEVEN/EXPIRED)
 *
 * MFE/MAE tracking: this module subscribes to `market.quote` and `position.opened`
 * events. When a signal is linked to a position, the position is added to an in-memory
 * tracker. On every quote tick the tracker updates the high/low watermarks for that
 * position in the correct direction (BUY tracks upside MFE, downside MAE; SELL inverts).
 * On `position.closed` the final watermarks are flushed to DB.
 */

import { randomUUID }        from "node:crypto";
import { Decimal }           from "@prisma/client/runtime/library";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }          from "../events-bus/event.bus.js";
import type { GeneratedSignal } from "./signal.generator.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelemetryOutcome = "PENDING" | "WIN" | "LOSS" | "BREAKEVEN" | "EXPIRED";

export type TelemetryRecord = {
  id:                    string;
  signalId:              string;
  symbol:                string;
  timeframe:             string;
  signalType:            "BUY" | "SELL";
  confidence:            number;
  entryPrice:            number;
  stopLoss:              number;
  target1:               number;
  target2:               number;
  riskRewardRatio:       number;
  marketRegime:          string;
  volatilityLevel:       string;
  confluenceFactors:     string[];
  indicatorsSnapshot:    Record<string, unknown>;
  positionId:            string | null;
  orderId:               string | null;
  actualEntryPrice:      number | null;
  outcome:               TelemetryOutcome;
  pnl:                   number | null;
  pnlPips:               number | null;
  exitPrice:             number | null;
  exitReason:            string | null;
  durationSeconds:       number | null;
  maxFavorableExcursion: number | null;
  maxAdverseExcursion:   number | null;
  generatedAt:           Date;
  executedAt:            Date | null;
  closedAt:              Date | null;
};

type ActivePositionTrack = {
  signalId:     string;
  symbol:       string;
  signalType:   "BUY" | "SELL";
  entryPrice:   number;
  mfe:          number;        // max favorable excursion (price units, always positive)
  mae:          number;        // max adverse excursion   (price units, always positive)
  trackedSince: number;        // Date.now() when tracking started — used for eviction
};

// ─── Service ─────────────────────────────────────────────────────────────────

export class SignalTelemetryService {
  /** positionId → tracking state for live MFE/MAE */
  private readonly _activePositions = new Map<string, ActivePositionTrack>();

  constructor() {
    this._attachEventListeners();
    // Evict stale position tracks every hour — prevents unbounded growth if
    // position.closed events are missed (network disconnect, pod restart).
    setInterval(() => {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000; // 7 days
      for (const [posId, track] of this._activePositions) {
        if (track.trackedSince < cutoff) this._activePositions.delete(posId);
      }
    }, 3_600_000).unref(); // unref so this timer doesn't prevent process exit
  }

  // ── Write paths ───────────────────────────────────────────────────────────

  /**
   * Record a newly generated signal. Called by SignalGenerator immediately
   * after `persist()` succeeds. Non-blocking — failures are logged, not thrown.
   */
  async recordSignal(
    signal: GeneratedSignal,
    indicatorsSnapshot: Record<string, unknown> = {},
  ): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;

    const db = prisma as NonNullable<typeof prisma>;
    const [target1 = signal.entryPrice, target2 = signal.entryPrice] = signal.targetLevels;

    try {
      await db.signalTelemetry.create({
        data: {
          id:               randomUUID(),
          signalId:         signal.id,
          symbol:           signal.symbol,
          timeframe:        signal.timeframe,
          signalType:       signal.signalType,
          confidence:       signal.confidence,
          entryPrice:       new Decimal(signal.entryPrice),
          stopLoss:         new Decimal(signal.stopLoss),
          target1:          new Decimal(target1),
          target2:          new Decimal(target2),
          riskRewardRatio:  signal.riskRewardRatio,
          marketRegime:     signal.marketRegime,
          volatilityLevel:  signal.volatilityLevel,
          confluenceFactors: signal.confluenceFactors as unknown as object,
          indicatorsSnapshot: indicatorsSnapshot as object,
          outcome:          "PENDING",
          generatedAt:      new Date(signal.generatedAt),
          expiresAt:        new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h TTL
        },
      });
    } catch (err) {
      console.error("[signal-telemetry] recordSignal failed:", (err as Error).message);
    }
  }

  /**
   * Called by AutopilotPipeline after a signal is successfully executed.
   * Links the telemetry row to the real position/order IDs.
   */
  async linkPosition(
    signalId:         string,
    positionId:       string,
    orderId:          string,
    actualEntryPrice: number,
  ): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;

    const db = prisma as NonNullable<typeof prisma>;
    try {
      await db.signalTelemetry.updateMany({
        where: { signalId },
        data: {
          positionId,
          orderId,
          actualEntryPrice: new Decimal(actualEntryPrice),
          executedAt:       new Date(),
        },
      });
    } catch (err) {
      console.error("[signal-telemetry] linkPosition failed:", (err as Error).message);
    }
  }

  /**
   * Called when a position closes. Determines WIN/LOSS/BREAKEVEN,
   * writes final MFE/MAE, duration, PNL.
   */
  async updateOutcome(
    positionId: string,
    data: {
      pnl:        number;
      exitPrice:  number;
      exitReason: string;          // MANUAL | STOP_LOSS | TAKE_PROFIT | STOP_OUT | LIQUIDATION
      closedAt:   Date;
      entryPrice: number;
      side:       "BUY" | "SELL";
      quantity:   number;
    },
  ): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;

    const db  = prisma as NonNullable<typeof prisma>;
    const row = await db.signalTelemetry.findUnique({
      where:  { positionId },
      select: { id: true, signalId: true, entryPrice: true, executedAt: true,
                stopLoss: true, target1: true },
    }).catch(() => null);

    if (!row) return;  // signal was not executed via autopilot

    // Flush MFE/MAE from in-memory tracker
    const track = this._activePositions.get(positionId);
    this._activePositions.delete(positionId);

    const BREAKEVEN_THRESHOLD = 0.0001; // price units
    let outcome: TelemetryOutcome;
    if (Math.abs(data.pnl) < BREAKEVEN_THRESHOLD) {
      outcome = "BREAKEVEN";
    } else {
      outcome = data.pnl > 0 ? "WIN" : "LOSS";
    }

    const durationSeconds = row.executedAt
      ? Math.floor((data.closedAt.getTime() - row.executedAt.getTime()) / 1000)
      : null;

    // pnlPips — for forex: price change × 10000; for indices/crypto: raw price diff
    const priceDiff = data.side === "BUY"
      ? data.exitPrice - data.entryPrice
      : data.entryPrice - data.exitPrice;
    const pnlPips = Number((priceDiff * 10_000).toFixed(1));

    const exitReasonMap: Record<string, string> = {
      MANUAL:      "MANUAL",
      STOP_LOSS:   "SL_HIT",
      TAKE_PROFIT: "TP_HIT",
      STOP_OUT:    "STOP_OUT",
      LIQUIDATION: "STOP_OUT",
      ADMIN:       "MANUAL",
    };

    try {
      await db.signalTelemetry.update({
        where: { positionId },
        data: {
          outcome,
          pnl:      new Decimal(data.pnl),
          pnlPips,
          exitPrice: new Decimal(data.exitPrice),
          exitReason: exitReasonMap[data.exitReason] ?? data.exitReason,
          durationSeconds,
          closedAt: data.closedAt,
          maxFavorableExcursion: track ? new Decimal(track.mfe) : null,
          maxAdverseExcursion:   track ? new Decimal(track.mae) : null,
        },
      });
    } catch (err) {
      console.error("[signal-telemetry] updateOutcome failed:", (err as Error).message);
    }
  }

  /**
   * Mark PENDING signals older than their expiresAt as EXPIRED.
   * Called by the scheduled job coordinator (every hour).
   */
  async expireStaleSignals(): Promise<number> {
    if (!IS_PERSISTENT || !prisma) return 0;

    const db = prisma as NonNullable<typeof prisma>;
    try {
      const result = await db.signalTelemetry.updateMany({
        where: {
          outcome:   "PENDING",
          positionId: null,           // not executed
          expiresAt: { lt: new Date() },
        },
        data: { outcome: "EXPIRED" },
      });
      return result.count;
    } catch {
      return 0;
    }
  }

  // ── In-memory MFE/MAE tracking ─────────────────────────────────────────────

  /** Start tracking MFE/MAE for a newly opened position linked to a signal. */
  startTracking(
    positionId: string,
    signalId:   string,
    symbol:     string,
    signalType: "BUY" | "SELL",
    entryPrice: number,
  ): void {
    this._activePositions.set(positionId, {
      signalId, symbol, signalType, entryPrice, mfe: 0, mae: 0, trackedSince: Date.now(),
    });
  }

  /** Update watermarks for a position on each price tick. */
  updateMFEMAE(positionId: string, markPrice: number): void {
    const t = this._activePositions.get(positionId);
    if (!t) return;

    const favorable = t.signalType === "BUY"
      ? markPrice - t.entryPrice   // BUY: up is favorable
      : t.entryPrice - markPrice;  // SELL: down is favorable

    const adverse = -favorable;

    if (favorable > t.mfe) t.mfe = favorable;
    if (adverse   > t.mae) t.mae = adverse;
  }

  // ── Event subscriptions ───────────────────────────────────────────────────

  private _attachEventListeners(): void {
    // When a position opens — start MFE/MAE tracking if linked to a signal
    eventBus.on("position.opened", async (ev) => {
      if (!IS_PERSISTENT || !prisma) return;

      const db  = prisma as NonNullable<typeof prisma>;
      const row = await db.signalTelemetry.findUnique({
        where:  { positionId: ev.positionId },
        select: { signalId: true, signalType: true },
      }).catch(() => null);

      if (!row) return;

      this.startTracking(
        ev.positionId,
        row.signalId,
        ev.symbol,
        row.signalType as "BUY" | "SELL",
        ev.entryPrice,
      );
    });

    // On each market quote, update MFE/MAE for all tracked positions on that symbol
    eventBus.on("market.quote", (ev) => {
      for (const [posId, track] of this._activePositions) {
        if (track.symbol === ev.symbol) {
          this.updateMFEMAE(posId, ev.mid);
        }
      }
    });

    // When a position closes — finalise the telemetry record.
    // REALTIME_FREEZE.md M.4: `reason` used to arrive on a separate
    // "trade.closed" event that settlement.engine.ts never actually emitted
    // -- exitReason was permanently stuck at "MANUAL" for every closed
    // position regardless of the real reason (SL/TP/stop-out/admin).
    // settlement.engine.ts now carries `reason` directly on position.closed.
    //
    // FASE 7 CLOSURE, Phase C: this used to pre-map `ev.reason` through a
    // second, local `_mapReason()` before calling updateOutcome(), which
    // ALSO maps `data.exitReason` via its own `exitReasonMap` (below).
    // Passing an already-mapped value ("SL_HIT") back through a lookup
    // table keyed by the raw enum ("STOP_LOSS") missed on every entry and
    // silently fell through to `?? data.exitReason` -- happened to be a
    // no-op for all 6 values today only because the map is a fixed point
    // of itself, not because the double call was intentional. Now passes
    // the raw `ev.reason` straight through (matches its declared type,
    // PositionClosedEvent's own literal union) and lets updateOutcome()'s
    // single exitReasonMap be the ONLY place this translation happens.
    eventBus.on("position.closed", async (ev) => {
      await this.updateOutcome(ev.positionId, {
        pnl:        ev.pnl,
        exitPrice:  ev.exitPrice,
        exitReason: ev.reason,
        closedAt:   new Date(ev.timestamp),
        entryPrice: ev.entryPrice,
        side:       ev.side,
        quantity:   ev.quantity,
      });
    });
  }
}

export const signalTelemetry = new SignalTelemetryService();
