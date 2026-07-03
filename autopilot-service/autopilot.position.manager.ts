/**
 * AutopilotPositionManager — continuous trade management for autopilot-opened
 * positions, the part a "fire and forget" autopilot is missing compared to a
 * real MetaTrader-style EA: break-even stop moves, ATR trailing stops, an
 * early exit when the market regime flips against an unprofitable trade, and
 * a time-stop for trades that go nowhere.
 *
 * Runs every 30s via jobCoordinator (same distributed-lock pattern as
 * stop-out-scan). Only ever touches positions tagged openedByAutopilot=true —
 * manual trades are never modified by this service.
 *
 * Exit-on-regime-flip and the time-stop only ever fire while floating P&L is
 * at or below zero — this service never cuts a winning trade early, only a
 * thesis that hasn't worked out yet.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { autopilotService }      from "./autopilot.service.js";
import { positionService }       from "../trading-service/position.service.js";
import { marginController }      from "../risk-service/margin.controller.js";
import { quoteCache }            from "../market-data/quote.cache.js";
import { getRegimeSnapshot }     from "../ai-core/regime.snapshot.js";
import { eventBus }              from "../events-bus/event.bus.js";
import { alertManager }          from "../alerting/alert.manager.js";
import { metrics }               from "../gateway/metrics.js";
import type { BrokerState }      from "../shared/state.js";
import type { Principal }        from "../shared/contracts.js";

const SYSTEM_ACTOR: Principal = {
  sub: "system_autopilot_circuit_breaker",
  email: "system@igfxpro.internal",
  fullName: "Autopilot Circuit Breaker",
  tenantId: "tenant_igfxpro",
  tier: "ENTERPRISE",
  roles: ["admin"],
  permissions: [],
  kycStatus: "approved",
  mfaRequired: false,
};

type OpenPositionRow = {
  id: string; userId: string; symbol: string; side: string;
  entryPrice: { toNumber(): number };
  stopLoss: { toNumber(): number } | null;
  initialStopLoss: { toNumber(): number } | null;
  pnl: { toNumber(): number };
  openedAt: Date;
  breakEvenApplied: boolean;
  trailingActive: boolean;
};

// Task 14 Phase 7 — if either silent-fallback counter grows by at least this
// many in a single 30s management cycle, something upstream (correlation
// matrix or regime snapshot) is degraded broadly enough to be worth paging.
const FALLBACK_ALERT_THRESHOLD = 10;

export class AutopilotPositionManager {
  private _lastCorrFallbackTotal      = 0;
  private _lastRegimeUnavailableTotal = 0;

  async manageOpenTrades(state: BrokerState): Promise<{ checked: number; managed: number }> {
    if (!IS_PERSISTENT) return { checked: 0, managed: 0 };
    const db = prisma as NonNullable<typeof prisma>;

    const positions = await db.position.findMany({
      where:  { status: "OPEN", openedByAutopilot: true },
      select: {
        id: true, userId: true, symbol: true, side: true,
        entryPrice: true, stopLoss: true, initialStopLoss: true, pnl: true,
        openedAt: true, breakEvenApplied: true, trailingActive: true,
      },
    });

    let managed = 0;
    for (const pos of positions) {
      try {
        if (await this._manageOne(pos, state)) managed++;
      } catch (err) {
        console.error(`[autopilot-mgr] error managing position ${pos.id}:`, (err as Error).message);
      }
    }

    await this._checkCircuitBreaker(state);
    await this._checkPerClientDailyLoss();

    return { checked: positions.length, managed };
  }

  private async _manageOne(pos: OpenPositionRow, state: BrokerState): Promise<boolean> {
    const quote = quoteCache.get(pos.symbol);
    if (!quote) return false;

    const cfg   = await autopilotService.getConfig(pos.userId);
    const side  = pos.side as "BUY" | "SELL";
    const entry = pos.entryPrice.toNumber();
    // cTrader convention: a BUY closes at bid, a SELL closes at ask — use the
    // same side for R-multiple/management math as settlement will actually use.
    const currentPrice = side === "BUY" ? quote.bid : quote.ask;
    const floatingPnl  = pos.pnl.toNumber();

    let R: number | null = null;
    const initialSL = pos.initialStopLoss?.toNumber();
    if (initialSL !== undefined && initialSL !== null) {
      const riskDistance = Math.abs(entry - initialSL);
      if (riskDistance > 0) {
        const favorable = side === "BUY" ? currentPrice - entry : entry - currentPrice;
        R = favorable / riskDistance;
      }
    }

    // ── Regime-flip early exit — only cuts a thesis that hasn't worked yet ──
    if (cfg.regimeExitEnabled && floatingPnl <= 0) {
      const snap = getRegimeSnapshot(pos.symbol, "1H");
      if (snap.status !== "ACTIVE") {
        metrics.inc("autopilot_regime_unavailable_total");
      } else if (snap.trending) {
        const against = (side === "BUY"  && snap.regime === "BEARISH_TREND") ||
                         (side === "SELL" && snap.regime === "BULLISH_TREND");
        if (against) {
          await positionService.close(pos.id, pos.userId, state);
          await autopilotService.recordDecision(
            pos.userId, pos.symbol, "MANAGED",
            `Closed early — regime flipped to ${snap.regime} against ${side} position (flat/at-loss, never cuts a winner)`,
          );
          eventBus.emit("autopilot.position_managed", {
            positionId: pos.id, userId: pos.userId, symbol: pos.symbol, action: "REGIME_EXIT",
            timestamp: new Date().toISOString(),
          });
          return true;
        }
      }
    }

    // ── Time-stop — no progress after maxHoursOpen ───────────────────────────
    const hoursOpen = (Date.now() - pos.openedAt.getTime()) / 3_600_000;
    if (floatingPnl <= 0 && hoursOpen > cfg.maxHoursOpen) {
      await positionService.close(pos.id, pos.userId, state);
      await autopilotService.recordDecision(
        pos.userId, pos.symbol, "MANAGED",
        `Closed — open ${hoursOpen.toFixed(1)}h with no progress (limit ${cfg.maxHoursOpen}h)`,
      );
      eventBus.emit("autopilot.position_managed", {
        positionId: pos.id, userId: pos.userId, symbol: pos.symbol, action: "TIME_STOP",
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    if (R === null) return false; // no frozen initial SL — can't size break-even/trailing safely

    let acted = false;
    let liveStopLoss = pos.stopLoss?.toNumber();

    // ── Break-even stop move ─────────────────────────────────────────────────
    if (R >= cfg.breakEvenTriggerR && !pos.breakEvenApplied) {
      const buffer = entry * 0.0002; // tiny buffer past entry so spread noise doesn't re-trigger SL instantly
      const candidateSL = side === "BUY" ? entry + buffer : entry - buffer;
      const improves = liveStopLoss === undefined || liveStopLoss === null
        ? true
        : side === "BUY" ? candidateSL > liveStopLoss : candidateSL < liveStopLoss;

      if (improves) {
        const res = await positionService.updateSLTP(pos.id, pos.userId, { stopLoss: candidateSL });
        if (res.ok) {
          await prisma!.position.update({ where: { id: pos.id }, data: { breakEvenApplied: true } });
          await autopilotService.recordDecision(
            pos.userId, pos.symbol, "MANAGED",
            `Break-even applied at R=${R.toFixed(2)} — SL moved to ${candidateSL.toFixed(5)}`,
          );
          eventBus.emit("autopilot.position_managed", {
            positionId: pos.id, userId: pos.userId, symbol: pos.symbol, action: "BREAK_EVEN",
            stopLoss: candidateSL, timestamp: new Date().toISOString(),
          });
          liveStopLoss = candidateSL;
          acted = true;
        }
      }
    }

    // ── ATR trailing stop — only ever ratchets tighter, never loosens ───────
    if (cfg.trailingStopEnabled && R >= cfg.trailingActivationR) {
      const snap = getRegimeSnapshot(pos.symbol, "1H");
      if (snap.status !== "ACTIVE") {
        metrics.inc("autopilot_regime_unavailable_total");
      } else if (snap.atr) {
        const candidateSL = side === "BUY"
          ? currentPrice - snap.atr * cfg.atrTrailMultiple
          : currentPrice + snap.atr * cfg.atrTrailMultiple;
        const tightens = liveStopLoss === undefined || liveStopLoss === null
          ? true
          : side === "BUY" ? candidateSL > liveStopLoss : candidateSL < liveStopLoss;

        if (tightens) {
          const res = await positionService.updateSLTP(pos.id, pos.userId, { stopLoss: candidateSL });
          if (res.ok) {
            await prisma!.position.update({ where: { id: pos.id }, data: { trailingActive: true } });
            await autopilotService.recordDecision(
              pos.userId, pos.symbol, "MANAGED",
              `Trailing stop moved to ${candidateSL.toFixed(5)} (ATR=${snap.atr.toFixed(5)}×${cfg.atrTrailMultiple})`,
            );
            eventBus.emit("autopilot.position_managed", {
              positionId: pos.id, userId: pos.userId, symbol: pos.symbol, action: "TRAILING_STOP",
              stopLoss: candidateSL, timestamp: new Date().toISOString(),
            });
            acted = true;
          }
        }
      }
    }

    return acted;
  }

  /**
   * Platform-wide safety net: if aggregate realized autopilot P&L across ALL
   * users today breaches olosGovernance.maxDailyAutopilotDrawdownPct of total
   * platform equity, disable autopilot platform-wide and alert. This is
   * separate from each user's own per-account stopDrawdownPct.
   */
  private async _checkCircuitBreaker(state: BrokerState): Promise<void> {
    await this._checkFallbackVisibility();

    const gov = state.getOlosGovernance();
    if (!gov.autopilotEnabled) return;

    const db = prisma as NonNullable<typeof prisma>;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const closedToday = await db.position.aggregate({
      where: { openedByAutopilot: true, status: "CLOSED", closedAt: { gte: startOfToday } },
      _sum:  { pnl: true },
    });
    const realizedPnl = closedToday._sum.pnl?.toNumber() ?? 0;
    if (realizedPnl >= 0) return;

    const equityAgg = await db.walletAccount.aggregate({ _sum: { balance: true } });
    const platformEquity = equityAgg._sum.balance?.toNumber() ?? 0;
    if (platformEquity <= 0) return;

    const drawdownPct = (Math.abs(realizedPnl) / platformEquity) * 100;
    if (drawdownPct < gov.maxDailyAutopilotDrawdownPct) return;

    state.adminUpdateOlosGovernance(SYSTEM_ACTOR, { autopilotEnabled: false });

    const detail = `Realized autopilot P&L today: ${realizedPnl.toFixed(2)} USD ` +
      `(${drawdownPct.toFixed(2)}% of platform equity, threshold ${gov.maxDailyAutopilotDrawdownPct}%). ` +
      `Autopilot has been automatically disabled platform-wide for all users.`;

    console.error(`[autopilot-mgr] CIRCUIT BREAKER TRIPPED — ${detail}`);
    await alertManager.send({
      type:     "AUTOPILOT_CIRCUIT_BREAKER",
      severity: "CRITICAL",
      title:    "Autopilot disabled platform-wide — daily drawdown limit breached",
      message:  detail,
      metadata: { realizedPnl, drawdownPct, maxDailyAutopilotDrawdownPct: gov.maxDailyAutopilotDrawdownPct },
    });
  }

  /**
   * Per-client daily loss breaker — distinct from the platform-wide
   * circuit breaker above. Each client's own realized (closed today) plus
   * floating (currently open) autopilot P&L is compared against their own
   * maxDailyLossPct of equity. A breach locks only that client's new entries
   * until the next UTC day (existing open positions keep being managed
   * normally — this never force-closes a position, only blocks new ones,
   * mirroring how the platform-wide breaker behaves).
   */
  private async _checkPerClientDailyLoss(): Promise<void> {
    if (!IS_PERSISTENT) return;
    const db = prisma as NonNullable<typeof prisma>;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [closedToday, openNow] = await Promise.all([
      db.position.groupBy({
        by:    ["userId"],
        where: { openedByAutopilot: true, status: "CLOSED", closedAt: { gte: startOfToday } },
        _sum:  { pnl: true },
      }),
      db.position.groupBy({
        by:    ["userId"],
        where: { openedByAutopilot: true, status: "OPEN" },
        _sum:  { pnl: true },
      }),
    ]);

    const lossByUser = new Map<string, number>();
    for (const row of closedToday) lossByUser.set(row.userId, (lossByUser.get(row.userId) ?? 0) + (row._sum.pnl?.toNumber() ?? 0));
    for (const row of openNow)     lossByUser.set(row.userId, (lossByUser.get(row.userId) ?? 0) + (row._sum.pnl?.toNumber() ?? 0));

    const now = new Date();
    const endOfUtcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

    for (const [userId, pnl] of lossByUser) {
      if (pnl >= 0) continue;

      const cfg = await autopilotService.getConfig(userId);
      if (cfg.dailyLossLockedUntil && new Date(cfg.dailyLossLockedUntil) > now) continue; // already locked

      let equity: number;
      try {
        equity = (await marginController.getMarginState(userId)).equity;
      } catch {
        continue; // can't verify equity — never lock on a lookup failure
      }
      if (equity <= 0) continue;

      const lossPct = (Math.abs(pnl) / equity) * 100;
      if (lossPct < cfg.maxDailyLossPct) continue;

      await autopilotService.setDailyLossLock(userId, endOfUtcDay, SYSTEM_ACTOR.sub);
      eventBus.emit("autopilot.daily_loss_lock", {
        userId, pnl, lossPct, maxDailyLossPct: cfg.maxDailyLossPct,
        lockedUntil: endOfUtcDay.toISOString(), timestamp: now.toISOString(),
      });
      await alertManager.send({
        type:     "AUTOPILOT_DAILY_LOSS_LOCK",
        severity: "WARNING",
        title:    `Autopilot daily loss limit reached for client ${userId}`,
        message:  `Today's autopilot P&L for this client is ${pnl.toFixed(2)} USD ` +
          `(${lossPct.toFixed(2)}% of equity, limit ${cfg.maxDailyLossPct}%). ` +
          `New autopilot entries are locked for this client until tomorrow; open positions continue to be managed normally.`,
        metadata: { userId, pnl, lossPct, maxDailyLossPct: cfg.maxDailyLossPct },
      });
    }
  }

  /**
   * Task 14 Phase 7 — the correlation-check and regime-snapshot fallbacks are
   * both silent by design (they must never block a trade or a management
   * rule). This makes a sustained spike visible without changing either
   * fallback's own never-block behavior.
   */
  private async _checkFallbackVisibility(): Promise<void> {
    const corrTotal   = metrics.get("autopilot_correlation_fallback_total");
    const regimeTotal = metrics.get("autopilot_regime_unavailable_total");
    const corrDelta    = corrTotal - this._lastCorrFallbackTotal;
    const regimeDelta  = regimeTotal - this._lastRegimeUnavailableTotal;
    this._lastCorrFallbackTotal      = corrTotal;
    this._lastRegimeUnavailableTotal = regimeTotal;

    if (corrDelta < FALLBACK_ALERT_THRESHOLD && regimeDelta < FALLBACK_ALERT_THRESHOLD) return;

    await alertManager.send({
      type:     "AUTOPILOT_FALLBACK_SPIKE",
      severity: "WARNING",
      title:    "Autopilot fallback paths firing unusually often",
      message:  `In the last management cycle: correlation-check fallback +${corrDelta}, regime-snapshot-unavailable +${regimeDelta}. ` +
        `Neither blocks a trade, but a sustained spike usually means an upstream dependency (correlation matrix or regime snapshot) is degraded.`,
      metadata: { corrDelta, regimeDelta, corrTotal, regimeTotal },
    });
  }
}

export const autopilotPositionManager = new AutopilotPositionManager();
