/**
 * StopOutEngine — ESMA-compliant margin call and stop-out liquidation.
 *
 * ESMA rules (MiFID II / CFD regulation, Product Intervention Decision
 * 2018/796):
 *   - Retail clients: mandatory stop-out at 50% margin level.
 *   - Margin level = (equity / marginUsed) × 100.
 *   - When level drops below 50%, close one or more positions -- starting
 *     with the largest unrealised loss -- on terms most favourable to the
 *     client, stopping as soon as margin level has recovered back to 50%.
 *     FASE 4.2 (RISK_ENGINE_FREEZE.md Bug #4): this used to unconditionally
 *     close every open position regardless of whether fewer would have
 *     sufficed -- ESMA's rule is minimal necessary closure, not "close
 *     everything."
 *
 * Architecture:
 *   - Runs on a scheduled loop (every 30 seconds in main.ts).
 *   - For each user with open positions: compute live equity + margin level.
 *   - If level < STOP_OUT_PCT: liquidate positions, largest loss first,
 *     until margin level recovers above STOP_OUT_PCT.
 *   - Each liquidation is a real DB transaction (atomic, auditable).
 *   - Writes AuditLog, increments metrics counters, emits WebSocket event.
 *
 * Warning levels:
 *   150% → WARNING (notify client)
 *   120% → MARGIN_CALL (restrict new positions)
 *    50% → STOP_OUT (liquidate the minimal necessary positions)
 */

import { Decimal }            from "@prisma/client/runtime/library";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { immutableAudit }     from "../security/immutable.audit.js";
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
  /** FASE 4.2 (Bug #5): positions skipped because their symbol's quote is
   *  stale or missing -- only meaningful for action="STOP_OUT". */
  skippedStale?: number;
  /** CRITICAL_REMEDIATION (C7): number of OPEN positions (any action) whose
   *  quote was stale/missing when this check ran -- their true P&L is
   *  unknown and contributed 0 to marginLevel below, meaning this result's
   *  action/marginLevel cannot be trusted as a complete risk picture while
   *  this is nonzero. Present regardless of `action`, unlike skippedStale
   *  (which only exists for the STOP_OUT branch's liquidation loop). */
  staleDataPositions?: number;
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
    // FASE 4.2 (RISK_ENGINE_FREEZE.md Bug #5): a stale quote is exactly as
    // untrustworthy as a missing one for this purpose (the underlying feed
    // is silently dead) -- treat it the same way, falling back to
    // pnl=0/markPrice=entryPrice like the pre-existing no-quote case,
    // rather than computing a real money-moving decision from a price that
    // may be minutes or hours old. `staleOrMissing` is carried through so
    // the liquidation loop below never actually closes a position at that
    // untrustworthy price either.
    let totalUnrealized = 0;
    const positionsWithPnl = positions.map((pos) => {
      const quote = quoteCache.get(pos.symbol);
      const staleOrMissing = !quote || quoteCache.isStale(pos.symbol);
      let pnl = 0;
      let markPrice = pos.entryPrice.toNumber();
      if (quote && !staleOrMissing) {
        markPrice = pos.side === "BUY" ? quote.bid : quote.ask;
        const direction = pos.side === "BUY" ? 1 : -1;
        pnl = (markPrice - pos.entryPrice.toNumber()) * pos.quantity.toNumber() * direction;
      }
      totalUnrealized += pnl;
      return { ...pos, pnl, markPrice, staleOrMissing };
    });

    const equity      = balance + totalUnrealized;
    const marginUsed  = locked;
    const marginLevel = marginUsed > 0 ? (equity / marginUsed) * 100 : Infinity;

    // CRITICAL_REMEDIATION (C7): stale-quote positions contribute pnl=0 to
    // marginLevel above (Bug #5's fix, correctly preventing a fabricated
    // exit price) -- but that same fallback also makes marginLevel BLIND to
    // that position's real risk. A position genuinely deep underwater on a
    // symbol whose feed died is reported identically to a flat position:
    // marginLevel looks healthy, WARNING/MARGIN_CALL/STOP_OUT never fire,
    // and this account's true exposure grows unchecked for as long as the
    // outage lasts -- confirmed via code trace, and directly demonstrated
    // by the new stale-data-risk test below (a position that would be
    // -80,000 at its real cached price reports action="NONE" today).
    //
    // Fix: never claim to have verified this account's margin safety while
    // any open position's quote is stale/missing. This does NOT change the
    // marginLevel number itself (still no fabricated price) and does NOT
    // change liquidation behaviour (a stale position is still never settled
    // -- see the skippedStale loop below) -- it only ensures a human (risk
    // desk) is alerted that automated monitoring is degraded for this
    // account, rather than the system silently reporting "NONE" and moving
    // on. alertManager.send() already dedupes identical (type, severity)
    // alerts for 5 minutes, so a sustained outage does not spam.
    const staleDataPositions = positionsWithPnl.filter((p) => p.staleOrMissing).length;
    if (staleDataPositions > 0) {
      metrics.inc("stop_out_stale_data_risk_total", staleDataPositions);
      const staleSymbols = [...new Set(
        positionsWithPnl.filter((p) => p.staleOrMissing).map((p) => p.symbol),
      )];
      void alertManager.send({
        type:     "STOP_OUT",
        severity: "CRITICAL",
        title:    "Margin Health Unverifiable — Stale Market Data",
        message:  `User ${userId} has ${staleDataPositions} open position(s) on stale/missing-quote ` +
          `symbol(s) [${staleSymbols.join(", ")}]. Their real unrealized P&L is unknown and is being ` +
          `treated as 0 in this account's margin-level calculation (reported marginLevel=` +
          `${Number.isFinite(marginLevel) ? marginLevel.toFixed(1) + "%" : "n/a"}) -- this account's ` +
          `true risk level cannot be automatically verified until the feed recovers. Manual review recommended.`,
        metadata: { userId, staleSymbols, reportedMarginLevel: Number.isFinite(marginLevel) ? marginLevel.toFixed(2) : "n/a" },
      });
    }

    // ── Action resolution ─────────────────────────────────────────────────────

    if (!Number.isFinite(marginLevel) || marginLevel >= WARNING_PCT) {
      return { userId, marginLevel, action: "NONE", liquidated: 0, totalPnl: 0, triggeredAt, staleDataPositions };
    }

    // Emit warning notification at 150%
    // REALTIME_FREEZE.md Critical #1: this used to only call _notify() (a
    // direct db.notification.create() with no eventBus emit at all) -- the
    // WARNING threshold had no live/WS path whatsoever. Now emits the same
    // canonical "margin.warning" event MARGIN_CALL/STOP_OUT use below, so
    // WebSocket + NotificationRouter both fire for every threshold.
    if (marginLevel >= MARGIN_CALL_PCT && marginLevel < WARNING_PCT) {
      await this._saveMarginSnapshot(userId, equity, balance, marginUsed, marginLevel, "WARNING");
      eventBus.emit("margin.warning", {
        userId, marginLevelPct: marginLevel, freeMargin: Math.max(0, equity - marginUsed),
        equity, marginUsed, threshold: "WARNING", timestamp: triggeredAt,
      });
      return { userId, marginLevel, action: "WARNING", liquidated: 0, totalPnl: 0, triggeredAt, staleDataPositions };
    }

    // Restrict new orders at 100% (margin call level)
    if (marginLevel >= STOP_OUT_PCT && marginLevel < MARGIN_CALL_PCT) {
      await this._saveMarginSnapshot(userId, equity, balance, marginUsed, marginLevel, "MARGIN_CALL");

      // Write risk warning for dashboard
      await immutableAudit.write({
        actor:   "risk-engine",
        action:  "margin.call.triggered",
        entity:  `user:${userId}`,
        payload: { marginLevel: marginLevel.toFixed(2), equity, marginUsed } as object,
      });

      metrics.inc("margin_calls_total");
      // REALTIME_FREEZE.md Critical #1: was "risk.margin_call", a name with
      // zero listeners anywhere -- the event fired into the void. Now the
      // same canonical "margin.warning" event as WARNING/STOP_OUT.
      eventBus.emit("margin.warning", {
        userId, marginLevelPct: marginLevel, freeMargin: Math.max(0, equity - marginUsed),
        equity, marginUsed, threshold: "MARGIN_CALL", timestamp: triggeredAt,
      });
      return { userId, marginLevel, action: "MARGIN_CALL", liquidated: 0, totalPnl: 0, triggeredAt, staleDataPositions };
    }

    // ── STOP-OUT: liquidate the minimal necessary positions ───────────────────
    //
    // FASE 4.2 (RISK_ENGINE_FREEZE.md Bug #4): ESMA's actual rule (Product
    // Intervention Decision 2018/796) is to close "one or more [positions]...
    // on terms most favourable to the client" once margin level drops below
    // 50% -- not unconditionally close everything. Closing more than needed
    // needlessly crystallises profitable positions the client didn't choose
    // to exit and charges avoidable commission. So: close the largest-loss
    // position first (as before), but re-check margin level after each close
    // and stop as soon as it has recovered back to the 50% floor.

    // Sort by largest unrealised loss first (most adverse position closed first)
    const sorted = [...positionsWithPnl].sort((a, b) => a.pnl - b.pnl);

    let liquidated     = 0;
    let totalPnl       = 0;
    let skippedHalted  = 0;
    let skippedStale   = 0;
    let runningBalance    = balance;
    let runningUnrealized = totalUnrealized;
    let runningMarginUsed = marginUsed;

    for (const pos of sorted) {
      const runningEquity = runningBalance + runningUnrealized;
      const runningLevel  = runningMarginUsed > 0 ? (runningEquity / runningMarginUsed) * 100 : Infinity;
      if (runningLevel >= STOP_OUT_PCT) break; // recovered — minimal necessary closure done

      // FASE 4.2 Bug #5: a stale or missing quote is untrustworthy for a
      // real money-moving decision -- pos.markPrice already fell back to
      // entryPrice above (zero computed P&L), which is fine for the
      // margin-level estimate but must never be used as an actual exit
      // price. Skip; the position is re-evaluated fresh on the next 30s
      // scan / tick, same as the requote/staleness protections already
      // applied to normal MARKET orders elsewhere in this codebase.
      if (pos.staleOrMissing) {
        skippedStale++;
        continue;
      }

      // FASE 4.2 Bug #3: a halted symbol's live price is exactly the price
      // the circuit breaker flagged as anomalous (or an admin flagged as
      // untradeable) — force-closing an existing position against it is the
      // same mistake the halt exists to prevent for new orders. Skip it;
      // the recovery sweep once the halt clears (or the next 30s/tick-level
      // check) will catch it if the user is still below the floor then.
      if (!brokerSpreadConfig.isEnabled(pos.symbol)) {
        skippedHalted++;
        continue;
      }

      // Only the settlement call itself is try/caught -- bookkeeping below
      // runs unconditionally once settle() has genuinely succeeded, so a
      // problem there can never be mislabeled as a settlement failure.
      let result: Awaited<ReturnType<typeof settlementEngine.settle>>;
      try {
        result = await settlementEngine.settle({
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
      } catch (err) {
        if (err instanceof PositionAlreadyClosedError) {
          // Closed concurrently by SL/TP tick or another stop-out sweep — not
          // an error. We don't know the exact balance delta the other path
          // applied, so runningBalance is left as-is here (conservative: may
          // cause one extra position to be evaluated this sweep, never fewer
          // than actually needed) -- but the position's margin/P&L no longer
          // apply either way, since it is now closed.
          liquidated++;
          runningUnrealized -= pos.pnl;
          runningMarginUsed -= pos.marginUsed.toNumber();
        } else {
          console.error(`[stop-out] Failed to settle position ${pos.id}:`, (err as Error).message);
        }
        continue;
      }

      totalPnl += result.cappedPnl;
      liquidated++;
      // Track the effect of this closure without re-querying the DB: the
      // authoritative new balance comes straight from the settlement
      // result; this position's floating P&L and margin no longer count
      // toward the running equity/margin-level once it's closed.
      runningBalance     = result.newBalance.toNumber();
      runningUnrealized -= pos.pnl;
      runningMarginUsed -= pos.marginUsed.toNumber();
    }

    // Audit + snapshot
    await this._saveMarginSnapshot(userId, equity, balance, marginUsed, marginLevel, "STOP_OUT");

    // LEDGER_FREEZE.md §0.11: this summary write was previously unguarded --
    // an exception here was swallowed by scanAll()'s per-user try/catch into
    // an `errors` array its own only caller (main.ts) never reads, so a
    // failure here vanished with zero trace even though the money movement
    // above had already genuinely happened. The liquidation itself must
    // never be undone by an audit-write failure (the money is already
    // moved), but the failure itself must be visible somewhere.
    try {
      await immutableAudit.write({
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
          skippedStale,
        } as object,
      });
    } catch (err) {
      console.error(`[stop-out] CRITICAL: failed to write stop_out.triggered audit summary for userId=${userId}:`, (err as Error).message);
      metrics.inc("stop_out_audit_write_failures_total");
      void alertManager.send({
        type:     "STOP_OUT",
        severity: "CRITICAL",
        title:    "Stop-Out Audit Write Failed",
        message:  `Stop-out for user ${userId} closed ${liquidated} position(s) (net P&L ${totalPnl.toFixed(2)} USD) but the compliance audit summary failed to write: ${(err as Error).message}`,
        metadata: { userId, marginLevel: marginLevel.toFixed(2), positions: liquidated, totalPnl: totalPnl.toFixed(2) },
      });
    }

    // LEDGER_FREEZE.md §0.11: this counter used to be "stop_out_events_total"
    // -- the SAME name settlement.engine.ts increments once per POSITION
    // closed with reason STOP_OUT/LIQUIDATION. A single stop-out sweep that
    // closes 3 positions incremented that shared counter 4 times under one
    // name with two different units. This is a distinct concept (one sweep
    // episode, regardless of how many positions it closed) and now has its
    // own name.
    metrics.inc("stop_out_episodes_total");
    if (skippedHalted > 0) metrics.inc("stop_out_skipped_halted_total", skippedHalted);
    if (skippedStale > 0)  metrics.inc("stop_out_skipped_stale_total", skippedStale);

    // REALTIME_FREEZE.md Critical #1: was "risk.stop_out", a name with zero
    // listeners anywhere. Now the same canonical "margin.warning" event as
    // WARNING/MARGIN_CALL -- a client who was actually stopped out gets a
    // dedicated "you were stopped out" push (via NotificationRouter/WS),
    // not just the generic per-position "Position closed" notice from
    // settlementEngine.settle(). Only fires if something was actually
    // closed (a sweep that only skipped halted/stale positions has nothing
    // new to tell the client yet).
    if (liquidated > 0) {
      eventBus.emit("margin.warning", {
        userId, marginLevelPct: marginLevel, freeMargin: Math.max(0, equity - marginUsed),
        equity, marginUsed, threshold: "STOP_OUT", timestamp: triggeredAt,
        positionsClosed: liquidated, totalPnl,
      });
    }

    console.warn(`[stop-out] userId=${userId} marginLevel=${marginLevel.toFixed(1)}% closed=${liquidated} totalPnl=${totalPnl}` +
      (skippedHalted > 0 ? ` skippedHalted=${skippedHalted}` : "") +
      (skippedStale > 0  ? ` skippedStale=${skippedStale}`   : ""));

    // Alert on stop-out — individual stop-outs are WARNING; wave detection in scanAll()
    void alertManager.send({
      type:     "STOP_OUT",
      severity: "WARNING",
      title:    "Stop-Out Triggered",
      message:  `User ${userId} stop-out at ${marginLevel.toFixed(1)}% margin level. ${liquidated} position(s) closed. Net P&L: ${totalPnl.toFixed(2)} USD.`,
      metadata: { userId, marginLevel: marginLevel.toFixed(2), positions: liquidated, totalPnl: totalPnl.toFixed(2) },
    });

    return { userId, marginLevel, action: "STOP_OUT", liquidated, totalPnl, triggeredAt, skippedHalted, skippedStale, staleDataPositions };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

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
