/**
 * GlobalRiskSupervisor — institutional safety layer for Autopilot, independent
 * of (and additive to) the existing platform kill-switch and per-client/
 * platform daily-loss breakers.
 *
 * Continuously evaluates real, already-available signals — never fabricated —
 * and derives one of four modes:
 *
 *   NORMAL               — no restriction
 *   SAFE_MODE            — new autopilot entries require a higher confidence bar
 *   EMERGENCY_MODE        — no new autopilot entries platform-wide
 *   FULL_AUTOPILOT_STOP   — no new autopilot entries, most severe signals
 *
 * Position management (break-even/trailing/time-stop/regime-exit) is NEVER
 * affected by this supervisor — protective management must keep running in
 * every mode. Only new-entry gating in autopilot.pipeline.ts reads this.
 *
 * Escalation (worse mode) is immediate. Recovery (better mode) requires the
 * improved severity to hold for RECOVERY_CYCLES consecutive evaluate() calls
 * — hysteresis to avoid mode-flapping. An admin override fully replaces
 * automatic control until explicitly released back to "AUTO", mirroring the
 * adminSetPause vs. client-toggle separation already used for autopilot pause.
 *
 * Persisted as a singleton row in BrokerSetting (same pattern as kill.switch.ts)
 * — no new Prisma model needed.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { randomUUID } from "node:crypto";
import { checkDatabaseHealth, checkRedisHealth, checkMarketDataHealth } from "../shared/health.check.js";
import { feedHealthMonitor } from "../market-data/feed.health.monitor.js";
import { getRegimeSnapshot } from "../ai-core/regime.snapshot.js";
import { metrics } from "../gateway/metrics.js";
import { alertManager } from "../alerting/alert.manager.js";
import { publishControlChannel, subscribeControlChannel } from "../shared/control.channel.js";

const SETTING_KEY = "global_risk_supervisor";
const CHANNEL      = "risk-supervisor";

export type SupervisorMode = "NORMAL" | "SAFE_MODE" | "EMERGENCY_MODE" | "FULL_AUTOPILOT_STOP";

const MODE_BY_SEVERITY: Record<0 | 1 | 2 | 3, SupervisorMode> = {
  0: "NORMAL",
  1: "SAFE_MODE",
  2: "EMERGENCY_MODE",
  3: "FULL_AUTOPILOT_STOP",
};
const SEVERITY_BY_MODE: Record<SupervisorMode, 0 | 1 | 2 | 3> = {
  NORMAL: 0, SAFE_MODE: 1, EMERGENCY_MODE: 2, FULL_AUTOPILOT_STOP: 3,
};

// ── Thresholds (env-overridable, never magic numbers buried in logic) ────────
const CONSECUTIVE_LOSS_SAFE       = Number(process.env.RISK_SUP_CONSEC_LOSS_SAFE       ?? 5);
const CONSECUTIVE_LOSS_EMERGENCY  = Number(process.env.RISK_SUP_CONSEC_LOSS_EMERGENCY  ?? 8);
const CONSECUTIVE_LOSS_STOP       = Number(process.env.RISK_SUP_CONSEC_LOSS_STOP       ?? 12);

const DRAWDOWN_SAFE_PCT       = Number(process.env.RISK_SUP_DRAWDOWN_SAFE_PCT       ?? 3);
const DRAWDOWN_EMERGENCY_PCT  = Number(process.env.RISK_SUP_DRAWDOWN_EMERGENCY_PCT  ?? 6);
const DRAWDOWN_STOP_PCT       = Number(process.env.RISK_SUP_DRAWDOWN_STOP_PCT       ?? 10);

const DB_DEGRADED_LATENCY_MS  = Number(process.env.RISK_SUP_DB_DEGRADED_MS ?? 500);

const EXEC_FAILURE_RATE_SAFE      = Number(process.env.RISK_SUP_EXEC_FAIL_SAFE      ?? 0.15);
const EXEC_FAILURE_RATE_EMERGENCY = Number(process.env.RISK_SUP_EXEC_FAIL_EMERGENCY ?? 0.30);
const EXEC_LATENCY_SAFE_MS        = Number(process.env.RISK_SUP_EXEC_LATENCY_SAFE_MS      ?? 800);
const EXEC_LATENCY_EMERGENCY_MS   = Number(process.env.RISK_SUP_EXEC_LATENCY_EMERGENCY_MS ?? 2000);

const STALE_SYMBOLS_SAFE      = Number(process.env.RISK_SUP_STALE_SYMBOLS_SAFE      ?? 1);
const STALE_SYMBOLS_EMERGENCY = Number(process.env.RISK_SUP_STALE_SYMBOLS_EMERGENCY ?? 3);

const WS_DROP_RATIO_SAFE      = Number(process.env.RISK_SUP_WS_DROP_RATIO_SAFE      ?? 0.3);
const WS_DROP_RATIO_EMERGENCY = Number(process.env.RISK_SUP_WS_DROP_RATIO_EMERGENCY ?? 0.6);

const VOL_BURST_MULTIPLIER       = Number(process.env.RISK_SUP_VOL_BURST_MULTIPLIER ?? 2.5);
const VOL_BURST_SYMBOLS_SAFE      = Number(process.env.RISK_SUP_VOL_BURST_SYMBOLS_SAFE      ?? 2);
const VOL_BURST_SYMBOLS_EMERGENCY = Number(process.env.RISK_SUP_VOL_BURST_SYMBOLS_EMERGENCY ?? 5);
const VOL_BASELINE_EMA_ALPHA      = Number(process.env.RISK_SUP_VOL_BASELINE_ALPHA ?? 0.1);

const ABNORMAL_SPREAD_SYMBOLS_SAFE      = Number(process.env.RISK_SUP_SPREAD_SYMBOLS_SAFE      ?? 2);
const ABNORMAL_SPREAD_SYMBOLS_EMERGENCY = Number(process.env.RISK_SUP_SPREAD_SYMBOLS_EMERGENCY ?? 5);

const RECOVERY_CYCLES = Number(process.env.RISK_SUP_RECOVERY_CYCLES ?? 5);
const EXEC_WINDOW_MS  = Number(process.env.RISK_SUP_EXEC_WINDOW_MS ?? 30 * 60_000); // 30 min

export const SAFE_MODE_MIN_CONFIDENCE = Number(process.env.RISK_SUP_SAFE_MODE_MIN_CONFIDENCE ?? 0.80);

export type SupervisorSignals = {
  consecutiveLosses:     number;
  platformDrawdownPct:   number;
  dbStatus:               "operational" | "degraded" | "offline";
  dbLatencyMs:            number | null;
  redisStatus:            "operational" | "degraded" | "offline";
  marketDataStatus:       "operational" | "degraded" | "offline";
  staleSymbolCount:       number;
  wsConnectionsActive:    number;
  wsDropRatio:            number;
  executionFailureRate:   number;
  avgExecutionLatencyMs:  number;
  volatilityBurstSymbols: string[];
  abnormalSpreadSymbols:  string[];
};

export type SupervisorEvaluation = {
  mode:        SupervisorMode;
  reason:      string;
  triggeredBy: "system" | "admin";
  changedAt:   string;
  signals:     SupervisorSignals;
};

type AdminOverride = { mode: SupervisorMode; reason: string; actorId: string; setAt: string } | null;

type PersistedState = {
  mode:        SupervisorMode;
  reason:      string;
  triggeredBy: "system" | "admin";
  changedAt:   string;
  signals:     SupervisorSignals | null;
  adminOverride: AdminOverride;
};

function emptySignals(): SupervisorSignals {
  return {
    consecutiveLosses: 0, platformDrawdownPct: 0,
    dbStatus: "operational", dbLatencyMs: null,
    redisStatus: "operational", marketDataStatus: "operational",
    staleSymbolCount: 0, wsConnectionsActive: 0, wsDropRatio: 0,
    executionFailureRate: 0, avgExecutionLatencyMs: 0,
    volatilityBurstSymbols: [], abnormalSpreadSymbols: [],
  };
}

function initialState(): PersistedState {
  return { mode: "NORMAL", reason: "No restriction", triggeredBy: "system", changedAt: new Date().toISOString(), signals: null, adminOverride: null };
}

export class GlobalRiskSupervisor {
  private _cached: PersistedState = initialState();
  private _clearStreak = 0;
  private _lastWsConnections: number | null = null;
  private readonly _volBaseline = new Map<string, number>();

  async load(): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;
    try {
      const row = await prisma.brokerSetting.findUnique({ where: { key: SETTING_KEY } });
      if (row) this._cached = row.value as PersistedState;
    } catch {
      // DB unavailable — keep previous in-memory state
    }
  }

  /**
   * Fix #6: subscribes to cross-worker mode changes (admin overrides AND
   * automatic escalations from whichever worker is the leader-elected
   * evaluator) so every worker's autopilot.pipeline.ts gate sees the same
   * mode within milliseconds, instead of only the worker that made the
   * change. Call once at startup, after load(). No-op with no Redis configured.
   */
  async startSync(): Promise<void> {
    await subscribeControlChannel(CHANNEL, (payload) => {
      this._cached = payload as PersistedState;
      console.warn(`[risk-supervisor] state synced from another worker: mode=${this._cached.mode}`);
    });
  }

  getMode(): SupervisorMode {
    return this._cached.mode;
  }

  getState(): PersistedState {
    return { ...this._cached };
  }

  /** Admin-forced mode. Pass mode "AUTO" (cast as needed by caller) via clearOverride() to hand control back. */
  async forceMode(mode: SupervisorMode, reason: string, actorId: string): Promise<void> {
    const changedAt = new Date().toISOString();
    this._cached = {
      mode, reason, triggeredBy: "admin", changedAt,
      signals: this._cached.signals,
      adminOverride: { mode, reason, actorId, setAt: changedAt },
    };
    await this._persist();
    await this._auditAndAlert(mode, reason, "admin");
  }

  async clearOverride(actorId: string): Promise<void> {
    this._cached = { ...this._cached, adminOverride: null };
    await prisma?.auditLog.create({
      data: { id: randomUUID(), actor: actorId, action: "risk_supervisor.override_cleared", entity: "global", payload: {} },
    }).catch(() => undefined);

    if (!IS_PERSISTENT || !prisma) {
      await this._persist();
      return;
    }

    // Snap directly to the current real signals, bypassing the recovery-streak
    // hysteresis — an admin handing control back wants to see reality
    // immediately, not wait out a cooldown that was paused during the override.
    this._clearStreak = 0;
    const signals = await this._computeSignals();
    const { severity, reasons } = this._severityFromSignals(signals);
    const reason = reasons.length > 0 ? reasons.join("; ") : "No restriction";
    await this._applyMode(MODE_BY_SEVERITY[severity], reason, signals);
  }

  /**
   * Run one evaluation cycle. Computes all signals, derives target severity,
   * applies hysteresis, and persists + alerts only on an actual mode change.
   */
  async evaluate(): Promise<SupervisorEvaluation> {
    if (!IS_PERSISTENT || !prisma) {
      return { mode: "NORMAL", reason: "Sandbox mode — no restriction", triggeredBy: "system", changedAt: new Date().toISOString(), signals: emptySignals() };
    }

    const signals = await this._computeSignals();
    const { severity, reasons } = this._severityFromSignals(signals);
    const targetMode = MODE_BY_SEVERITY[severity];

    if (this._cached.adminOverride) {
      // Admin override fully replaces automatic control until cleared.
      return { mode: this._cached.mode, reason: this._cached.reason, triggeredBy: "admin", changedAt: this._cached.changedAt, signals };
    }

    const currentSeverity = SEVERITY_BY_MODE[this._cached.mode];
    const reason = reasons.length > 0 ? reasons.join("; ") : "No restriction";

    if (severity > currentSeverity) {
      // Escalate immediately.
      this._clearStreak = 0;
      await this._applyMode(targetMode, reason, signals);
    } else if (severity < currentSeverity) {
      this._clearStreak++;
      if (this._clearStreak >= RECOVERY_CYCLES) {
        this._clearStreak = 0;
        await this._applyMode(targetMode, reason, signals);
      } else {
        // Hold current mode until the recovery streak completes; keep signals fresh for explainability.
        this._cached = { ...this._cached, signals };
        await this._persist();
      }
    } else {
      this._clearStreak = 0;
      this._cached = { ...this._cached, signals };
      await this._persist();
    }

    return { mode: this._cached.mode, reason: this._cached.reason, triggeredBy: this._cached.triggeredBy, changedAt: this._cached.changedAt, signals };
  }

  private async _applyMode(mode: SupervisorMode, reason: string, signals: SupervisorSignals): Promise<void> {
    const changed = mode !== this._cached.mode;
    const changedAt = changed ? new Date().toISOString() : this._cached.changedAt;
    this._cached = { mode, reason, triggeredBy: "system", changedAt, signals, adminOverride: null };
    await this._persist();
    if (changed) await this._auditAndAlert(mode, reason, "system");
  }

  private async _auditAndAlert(mode: SupervisorMode, reason: string, actor: "system" | "admin"): Promise<void> {
    await prisma?.auditLog.create({
      data: {
        id: randomUUID(),
        actor: actor === "admin" ? "admin" : "system_risk_supervisor",
        action: "risk_supervisor.mode_changed",
        entity: "global",
        payload: { mode, reason } as object,
      },
    }).catch(() => undefined);

    const severity = mode === "NORMAL" ? "INFO" : mode === "SAFE_MODE" ? "WARNING" : "CRITICAL";
    await alertManager.send({
      type: "GLOBAL_RISK_SUPERVISOR_MODE_CHANGED",
      severity,
      title: `Risk Supervisor → ${mode}`,
      message: reason,
      metadata: { mode },
    });
  }

  private async _persist(): Promise<void> {
    if (!prisma) return;
    await prisma.brokerSetting.upsert({
      where: { key: SETTING_KEY },
      create: { key: SETTING_KEY, value: this._cached as object },
      update: { value: this._cached as object },
    }).catch(() => undefined);
    void publishControlChannel(CHANNEL, this._cached);
  }

  // ── Signal computation ────────────────────────────────────────────────────

  private async _computeSignals(): Promise<SupervisorSignals> {
    const db = prisma as NonNullable<typeof prisma>;
    const windowStart = new Date(Date.now() - EXEC_WINDOW_MS);

    const [
      consecutiveLosses,
      platformDrawdownPct,
      dbHealth,
      redisHealth,
      marketHealth,
      execOrders,
    ] = await Promise.all([
      this._consecutiveLosses(db),
      this._platformDrawdownPct(db),
      checkDatabaseHealth(),
      checkRedisHealth(),
      Promise.resolve(checkMarketDataHealth()),
      db.order.findMany({
        where: { createdAt: { gte: windowStart } },
        select: { status: true, createdAt: true, filledAt: true },
      }).catch(() => []),
    ]);

    const feedSnapshot = feedHealthMonitor.getSnapshot();
    const staleSymbolCount = feedSnapshot.staleSymbols.length;
    const abnormalSpreadSymbols = feedSnapshot.qualityMetrics
      .filter((q) => q.spreadQuality === "wide" || q.spreadQuality === "crossed")
      .map((q) => q.symbol);

    const wsConnectionsActive = metrics.get("ws_connections_active");
    const wsDropRatio = this._lastWsConnections && this._lastWsConnections > 0
      ? Math.max(0, (this._lastWsConnections - wsConnectionsActive) / this._lastWsConnections)
      : 0;
    this._lastWsConnections = wsConnectionsActive;

    const actionable = execOrders.filter((o) => o.status === "FILLED" || o.status === "REJECTED" || o.status === "CANCELLED");
    const failed = execOrders.filter((o) => o.status === "REJECTED" || o.status === "CANCELLED");
    const executionFailureRate = actionable.length > 0 ? failed.length / actionable.length : 0;

    const latencies = execOrders
      .filter((o) => o.status === "FILLED" && o.filledAt)
      .map((o) => o.filledAt!.getTime() - o.createdAt.getTime())
      .filter((ms) => ms >= 0 && ms < 60_000);
    const avgExecutionLatencyMs = latencies.length > 0 ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0;

    const volatilityBurstSymbols = this._volatilityBurstSymbols(feedSnapshot.qualityMetrics.map((q) => q.symbol));

    return {
      consecutiveLosses, platformDrawdownPct,
      dbStatus: dbHealth.status, dbLatencyMs: dbHealth.latencyMs,
      redisStatus: redisHealth.status, marketDataStatus: marketHealth.status,
      staleSymbolCount, wsConnectionsActive, wsDropRatio,
      executionFailureRate, avgExecutionLatencyMs,
      volatilityBurstSymbols, abnormalSpreadSymbols,
    };
  }

  private async _consecutiveLosses(db: NonNullable<typeof prisma>): Promise<number> {
    const recent = await db.position.findMany({
      where: { openedByAutopilot: true, status: "CLOSED" },
      orderBy: { closedAt: "desc" },
      take: 50,
      select: { pnl: true },
    }).catch(() => []);

    let streak = 0;
    for (const p of recent) {
      if (p.pnl.toNumber() < 0) streak++;
      else break;
    }
    return streak;
  }

  private async _platformDrawdownPct(db: NonNullable<typeof prisma>): Promise<number> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [closedToday, equityAgg] = await Promise.all([
      db.position.aggregate({
        where: { openedByAutopilot: true, status: "CLOSED", closedAt: { gte: startOfToday } },
        _sum: { pnl: true },
      }).catch(() => ({ _sum: { pnl: null } })),
      db.walletAccount.aggregate({ _sum: { balance: true } }).catch(() => ({ _sum: { balance: null } })),
    ]);

    const realizedPnl = closedToday._sum.pnl?.toNumber() ?? 0;
    const platformEquity = equityAgg._sum.balance?.toNumber() ?? 0;
    if (realizedPnl >= 0 || platformEquity <= 0) return 0;
    return (Math.abs(realizedPnl) / platformEquity) * 100;
  }

  private _volatilityBurstSymbols(symbols: string[]): string[] {
    const bursting: string[] = [];
    for (const symbol of symbols) {
      const snap = getRegimeSnapshot(symbol, "1H");
      if (snap.status !== "ACTIVE" || snap.atrNormalized === null) continue;

      const baseline = this._volBaseline.get(symbol);
      if (baseline !== undefined && baseline > 0 && snap.atrNormalized > baseline * VOL_BURST_MULTIPLIER) {
        bursting.push(symbol);
      }

      const updated = baseline === undefined ? snap.atrNormalized : (1 - VOL_BASELINE_EMA_ALPHA) * baseline + VOL_BASELINE_EMA_ALPHA * snap.atrNormalized;
      this._volBaseline.set(symbol, updated);
    }
    return bursting;
  }

  // ── Severity derivation (pure, deterministic, explainable) ───────────────

  private _severityFromSignals(s: SupervisorSignals): { severity: 0 | 1 | 2 | 3; reasons: string[] } {
    let severity: 0 | 1 | 2 | 3 = 0;
    const reasons: string[] = [];

    const bump = (level: 0 | 1 | 2 | 3, reason: string) => {
      if (level > severity) severity = level;
      reasons.push(reason);
    };

    if (s.dbStatus === "offline") bump(3, "Database offline");
    else if (s.dbStatus === "degraded" || (s.dbLatencyMs !== null && s.dbLatencyMs > DB_DEGRADED_LATENCY_MS)) bump(1, `Database latency ${s.dbLatencyMs}ms`);

    if (s.redisStatus === "offline") bump(1, "Redis offline (job coordination degraded)");

    if (s.marketDataStatus === "offline") bump(2, "Market data feed circuit open");
    else if (s.staleSymbolCount >= STALE_SYMBOLS_EMERGENCY) bump(2, `${s.staleSymbolCount} stale symbols`);
    else if (s.staleSymbolCount >= STALE_SYMBOLS_SAFE) bump(1, `${s.staleSymbolCount} stale symbol(s)`);

    if (s.consecutiveLosses >= CONSECUTIVE_LOSS_STOP) bump(3, `${s.consecutiveLosses} consecutive autopilot losses`);
    else if (s.consecutiveLosses >= CONSECUTIVE_LOSS_EMERGENCY) bump(2, `${s.consecutiveLosses} consecutive autopilot losses`);
    else if (s.consecutiveLosses >= CONSECUTIVE_LOSS_SAFE) bump(1, `${s.consecutiveLosses} consecutive autopilot losses`);

    if (s.platformDrawdownPct >= DRAWDOWN_STOP_PCT) bump(3, `Platform drawdown ${s.platformDrawdownPct.toFixed(2)}%`);
    else if (s.platformDrawdownPct >= DRAWDOWN_EMERGENCY_PCT) bump(2, `Platform drawdown ${s.platformDrawdownPct.toFixed(2)}%`);
    else if (s.platformDrawdownPct >= DRAWDOWN_SAFE_PCT) bump(1, `Platform drawdown ${s.platformDrawdownPct.toFixed(2)}%`);

    if (s.executionFailureRate >= EXEC_FAILURE_RATE_EMERGENCY) bump(2, `Execution failure rate ${(s.executionFailureRate * 100).toFixed(0)}%`);
    else if (s.executionFailureRate >= EXEC_FAILURE_RATE_SAFE) bump(1, `Execution failure rate ${(s.executionFailureRate * 100).toFixed(0)}%`);

    if (s.avgExecutionLatencyMs >= EXEC_LATENCY_EMERGENCY_MS) bump(2, `Execution latency ${s.avgExecutionLatencyMs.toFixed(0)}ms`);
    else if (s.avgExecutionLatencyMs >= EXEC_LATENCY_SAFE_MS) bump(1, `Execution latency ${s.avgExecutionLatencyMs.toFixed(0)}ms`);

    if (s.wsDropRatio >= WS_DROP_RATIO_EMERGENCY) bump(2, `WebSocket connections dropped ${(s.wsDropRatio * 100).toFixed(0)}%`);
    else if (s.wsDropRatio >= WS_DROP_RATIO_SAFE) bump(1, `WebSocket connections dropped ${(s.wsDropRatio * 100).toFixed(0)}%`);

    if (s.volatilityBurstSymbols.length >= VOL_BURST_SYMBOLS_EMERGENCY) bump(2, `Volatility burst on ${s.volatilityBurstSymbols.length} symbols`);
    else if (s.volatilityBurstSymbols.length >= VOL_BURST_SYMBOLS_SAFE) bump(1, `Volatility burst on ${s.volatilityBurstSymbols.length} symbol(s)`);

    if (s.abnormalSpreadSymbols.length >= ABNORMAL_SPREAD_SYMBOLS_EMERGENCY) bump(2, `Abnormal spread on ${s.abnormalSpreadSymbols.length} symbols`);
    else if (s.abnormalSpreadSymbols.length >= ABNORMAL_SPREAD_SYMBOLS_SAFE) bump(1, `Abnormal spread on ${s.abnormalSpreadSymbols.length} symbol(s)`);

    return { severity, reasons };
  }
}

export const globalRiskSupervisor = new GlobalRiskSupervisor();
