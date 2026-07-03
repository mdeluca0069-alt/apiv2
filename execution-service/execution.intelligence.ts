/**
 * ExecutionIntelligenceEngine — decides HOW an autopilot signal should be executed,
 * not just whether. Runs synchronously on every autopilot signal evaluation — no DB
 * calls, only already-available in-memory signals — so it stays fast and is fully
 * unit-testable without mocking Prisma.
 *
 * Real, non-fabricated signal sources only:
 *   - feedHealthMonitor   — per-symbol spread quality + quote freshness (in-memory)
 *   - getRegimeSnapshot   — real ADX/ATR replay, in-memory candle cache
 *   - globalRiskSupervisor — platform-wide execution latency/failure rate, computed
 *                            every 30s by Phase 1 and reused here for free (no extra DB load)
 *
 * Decision bands are deterministic and non-overlapping. CANCEL/DELAY both skip the
 * current signal cycle — there is no fabricated retry queue; the real retry mechanism
 * is that autopilot re-evaluates a fresh signal next cycle. SWITCH_TO_LIMIT is the one
 * action that genuinely "parks and waits": it places a real resting LIMIT order at the
 * mid price (avoiding the inflated spread) with a bounded expiry handled by the existing
 * pending-order-expiry job.
 */
import { feedHealthMonitor } from "../market-data/feed.health.monitor.js";
import { getRegimeSnapshot } from "../ai-core/regime.snapshot.js";
import { globalRiskSupervisor } from "../risk-service/global.risk.supervisor.js";

// ─── Config (named, env-overridable — no magic numbers) ──────────────────────

const SPREAD_RATIO_FLOOR        = Number(process.env.EI_SPREAD_RATIO_FLOOR        ?? 0.3);
const SPREAD_RATIO_CEILING      = Number(process.env.EI_SPREAD_RATIO_CEILING      ?? 0.7);
const SPREAD_RATIO_MAX_PENALTY  = Number(process.env.EI_SPREAD_RATIO_MAX_PENALTY  ?? 40);
const SPREAD_WIDE_PENALTY       = Number(process.env.EI_SPREAD_WIDE_PENALTY       ?? 15);

const STALE_WARN_MS             = Number(process.env.EI_STALE_WARN_MS             ?? 60_000);
const STALE_WARN_PENALTY        = Number(process.env.EI_STALE_WARN_PENALTY        ?? 15);

const VOL_EXTREME_PENALTY       = Number(process.env.EI_VOL_EXTREME_PENALTY       ?? 25);
const VOL_HIGH_PENALTY          = Number(process.env.EI_VOL_HIGH_PENALTY          ?? 12);

const EXEC_FAIL_WARN            = Number(process.env.EI_EXEC_FAIL_WARN            ?? 0.10);
const EXEC_FAIL_PENALTY         = Number(process.env.EI_EXEC_FAIL_PENALTY         ?? 15);
const EXEC_LATENCY_WARN_MS      = Number(process.env.EI_EXEC_LATENCY_WARN_MS      ?? 500);
const EXEC_LATENCY_PENALTY      = Number(process.env.EI_EXEC_LATENCY_PENALTY      ?? 10);

const LOW_CONFIDENCE            = Number(process.env.EI_LOW_CONFIDENCE            ?? 0.65);
const LOW_CONFIDENCE_PENALTY    = Number(process.env.EI_LOW_CONFIDENCE_PENALTY    ?? 10);

const PROCEED_MIN_SCORE         = Number(process.env.EI_PROCEED_MIN_SCORE         ?? 70);
const RESIZE_MIN_SCORE          = Number(process.env.EI_RESIZE_MIN_SCORE          ?? 50);
const SWITCH_MIN_SCORE          = Number(process.env.EI_SWITCH_MIN_SCORE          ?? 35);

const RESIZE_FACTOR_FLOOR       = Number(process.env.EI_RESIZE_FACTOR_FLOOR       ?? 0.4);
const RESIZE_FACTOR_RANGE       = Number(process.env.EI_RESIZE_FACTOR_RANGE       ?? 0.6);

export const EI_LIMIT_EXPIRY_MIN = Number(process.env.EI_LIMIT_EXPIRY_MIN ?? 15);

// ─── Types ─────────────────────────────────────────────────────────────────

export type ExecutionAction = "PROCEED" | "RESIZE" | "SWITCH_TO_LIMIT" | "DELAY" | "CANCEL";

export type ExecutionIntelligenceInput = {
  symbol:        string;
  side:          "BUY" | "SELL";
  confidence:    number;   // 0–1
  quantity:      number;
  midPrice:      number;
  spreadBps:     number;
  maxSpreadBps:  number;
};

export type ExecutionSignals = {
  spreadBps:                      number;
  spreadRatio:                    number;
  spreadQuality:                  "ok" | "wide" | "crossed" | "zero";
  quoteAgeMs:                     number;
  quoteFresh:                     boolean;
  volatilityLevel:                string | null;
  atrNormalized:                  number | null;
  platformAvgExecutionLatencyMs:  number;
  platformExecutionFailureRate:   number;
};

export type ExecutionIntelligenceResult = {
  action:          ExecutionAction;
  executionScore:  number;
  reasons:         string[];
  adjustedQuantity?: number;
  limitPrice?:       number;
  limitExpiresAt?:   string;
  signals:           ExecutionSignals;
};

type Penalty = { name: string; points: number; reason: string; spreadRelated: boolean };

export class ExecutionIntelligenceEngine {

  evaluate(input: ExecutionIntelligenceInput): ExecutionIntelligenceResult {
    const signals = this._computeSignals(input);

    // ── Hard stops — bypass scoring entirely; these are integrity issues, not
    //    a matter of degree. ───────────────────────────────────────────────
    if (signals.spreadQuality === "crossed") {
      return this._result("CANCEL", 0, [`Crossed book on ${input.symbol}`], signals);
    }
    if (!signals.quoteFresh) {
      return this._result("CANCEL", 0, [`Stale quote on ${input.symbol} (age ${signals.quoteAgeMs}ms)`], signals);
    }

    const penalties = this._computePenalties(input, signals);
    const score = Math.max(0, Math.min(100, 100 - penalties.reduce((s, p) => s + p.points, 0)));
    const reasons = penalties.map((p) => p.reason);

    if (score >= PROCEED_MIN_SCORE) {
      return this._result("PROCEED", score, reasons.length > 0 ? reasons : ["Conditions nominal"], signals);
    }

    if (score >= RESIZE_MIN_SCORE) {
      const factor = RESIZE_FACTOR_FLOOR + RESIZE_FACTOR_RANGE * ((score - RESIZE_MIN_SCORE) / (PROCEED_MIN_SCORE - RESIZE_MIN_SCORE));
      const adjustedQuantity = Math.max(1, Math.round(input.quantity * factor));
      return this._result("RESIZE", score, reasons, signals, { adjustedQuantity });
    }

    if (score >= SWITCH_MIN_SCORE) {
      const dominant = penalties.reduce((max, p) => (p.points > max.points ? p : max), penalties[0]);
      if (dominant?.spreadRelated) {
        const limitExpiresAt = new Date(Date.now() + EI_LIMIT_EXPIRY_MIN * 60_000).toISOString();
        return this._result("SWITCH_TO_LIMIT", score, reasons, signals, {
          limitPrice: input.midPrice,
          limitExpiresAt,
        });
      }
      return this._result("DELAY", score, reasons, signals);
    }

    return this._result("CANCEL", score, reasons, signals);
  }

  private _result(
    action: ExecutionAction,
    executionScore: number,
    reasons: string[],
    signals: ExecutionSignals,
    extra: Partial<Pick<ExecutionIntelligenceResult, "adjustedQuantity" | "limitPrice" | "limitExpiresAt">> = {},
  ): ExecutionIntelligenceResult {
    return { action, executionScore, reasons, signals, ...extra };
  }

  private _computeSignals(input: ExecutionIntelligenceInput): ExecutionSignals {
    const snapshot = feedHealthMonitor.getSnapshot();
    const symbolHealth = snapshot.qualityMetrics.find((q) => q.symbol === input.symbol);
    const spreadQuality = symbolHealth?.spreadQuality ?? "zero";
    const quoteAgeMs = feedHealthMonitor.quoteAgeMs(input.symbol);
    const quoteFresh = feedHealthMonitor.isQuoteFresh(input.symbol);

    const regime = getRegimeSnapshot(input.symbol, "1H");
    const volatilityLevel = regime.status === "ACTIVE" ? regime.volatilityLevel : null;
    const atrNormalized   = regime.status === "ACTIVE" ? regime.atrNormalized   : null;

    const supervisorSignals = globalRiskSupervisor.getState().signals;

    return {
      spreadBps:    input.spreadBps,
      spreadRatio:  input.maxSpreadBps > 0 ? input.spreadBps / input.maxSpreadBps : 0,
      spreadQuality,
      quoteAgeMs,
      quoteFresh,
      volatilityLevel,
      atrNormalized,
      platformAvgExecutionLatencyMs: supervisorSignals?.avgExecutionLatencyMs ?? 0,
      platformExecutionFailureRate:  supervisorSignals?.executionFailureRate  ?? 0,
    };
  }

  private _computePenalties(input: ExecutionIntelligenceInput, s: ExecutionSignals): Penalty[] {
    const penalties: Penalty[] = [];

    if (s.spreadRatio > SPREAD_RATIO_FLOOR) {
      const clamped = Math.min(s.spreadRatio, SPREAD_RATIO_CEILING);
      const points = Math.round(
        ((clamped - SPREAD_RATIO_FLOOR) / (SPREAD_RATIO_CEILING - SPREAD_RATIO_FLOOR)) * SPREAD_RATIO_MAX_PENALTY,
      );
      if (points > 0) {
        penalties.push({
          name: "spread_ratio", points, spreadRelated: true,
          reason: `Spread ${s.spreadBps.toFixed(1)}bps is ${(s.spreadRatio * 100).toFixed(0)}% of max`,
        });
      }
    }

    if (s.spreadQuality === "wide") {
      penalties.push({
        name: "spread_wide", points: SPREAD_WIDE_PENALTY, spreadRelated: true,
        reason: `Feed-health flags ${input.symbol} spread as wide`,
      });
    }

    if (s.quoteAgeMs > STALE_WARN_MS) {
      penalties.push({
        name: "quote_age", points: STALE_WARN_PENALTY, spreadRelated: false,
        reason: `Quote age ${Math.round(s.quoteAgeMs / 1000)}s exceeds warn threshold`,
      });
    }

    if (s.volatilityLevel === "EXTREME") {
      penalties.push({
        name: "volatility", points: VOL_EXTREME_PENALTY, spreadRelated: false,
        reason: `${input.symbol} volatility EXTREME (ATR ${s.atrNormalized?.toFixed(2)}%)`,
      });
    } else if (s.volatilityLevel === "HIGH") {
      penalties.push({
        name: "volatility", points: VOL_HIGH_PENALTY, spreadRelated: false,
        reason: `${input.symbol} volatility HIGH (ATR ${s.atrNormalized?.toFixed(2)}%)`,
      });
    }

    if (s.platformExecutionFailureRate >= EXEC_FAIL_WARN) {
      penalties.push({
        name: "exec_failure_rate", points: EXEC_FAIL_PENALTY, spreadRelated: false,
        reason: `Platform execution failure rate ${(s.platformExecutionFailureRate * 100).toFixed(0)}%`,
      });
    }

    if (s.platformAvgExecutionLatencyMs >= EXEC_LATENCY_WARN_MS) {
      penalties.push({
        name: "exec_latency", points: EXEC_LATENCY_PENALTY, spreadRelated: false,
        reason: `Platform execution latency ${s.platformAvgExecutionLatencyMs.toFixed(0)}ms`,
      });
    }

    if (input.confidence < LOW_CONFIDENCE) {
      penalties.push({
        name: "low_confidence", points: LOW_CONFIDENCE_PENALTY, spreadRelated: false,
        reason: `Signal confidence ${(input.confidence * 100).toFixed(0)}% below comfort threshold`,
      });
    }

    return penalties;
  }
}

export const executionIntelligence = new ExecutionIntelligenceEngine();
export default executionIntelligence;
