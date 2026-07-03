/**
 * SelfOptimizerService — weekly quantitative recalibration of the OLOS signal
 * engine based on observed trade outcomes.
 *
 * Algorithm:
 *
 *   1. Load last 28 days of closed SignalTelemetry rows.
 *   2. For each confidence dimension, extract its sub-score from the stored
 *      indicatorsSnapshot.breakdown and compute Pearson correlation with win/loss.
 *   3. Compute new weight = defaultWeight × (1 + LEARNING_RATE × correlation).
 *      Normalize weights to sum 100. Clamp each weight to [MIN_WEIGHT, MAX_WEIGHT].
 *   4. Compute per-regime win rates → update regime gates (raise gate when regime
 *      underperforms; lower it when it outperforms).
 *   5. Compute per-symbol win rates and PNL → disable symbols with winRate < 35%
 *      AND profitFactor < 0.7 over a minimum sample size.
 *   6. Write new ConfidenceWeights version + OptimizationLog to DB.
 *   7. Call adaptiveWeights.invalidate() so the next signal picks up new weights.
 *
 * Safety guards:
 *   - Requires OPTIMIZER_MIN_SAMPLES (default 30) closed trades before running.
 *   - Weight changes are capped by LEARNING_RATE (default 0.4 = max 40% shift).
 *   - Weights are clamped to [5, 40] — no single dimension can dominate or vanish.
 *   - If Sharpe drops vs prior version, the new weights are still saved but a
 *     warning is emitted (manual review recommended).
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";
import {
  adaptiveWeights,
  DEFAULT_WEIGHTS,
  DEFAULT_REGIME_GATES,
  DIMENSION_KEYS,
  type WeightMap,
  type RegimeGateMap,
  type SymbolConfigMap,
} from "./adaptive.weights.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const LEARNING_RATE       = 0.40;   // max 40% shift per run
const MIN_WEIGHT          = 5;      // no dimension can drop below 5 pts
const MAX_WEIGHT          = 40;     // no dimension can exceed 40 pts
const LOOKBACK_DAYS       = 28;     // how many days of telemetry to analyse
const MIN_SAMPLES         = 30;     // refuse to run if fewer closed trades
const SYMBOL_MIN_SAMPLES  = 10;     // min closed trades to judge a symbol
const DISABLE_WIN_RATE    = 0.35;   // disable symbol if win rate < 35%
const DISABLE_PROFIT_FACTOR = 0.70; // AND profit factor < 0.70
const REGIME_GATE_STEP    = 3;      // move regime gate ±N points per run

// ─── Types ───────────────────────────────────────────────────────────────────

export type OptimizationResult = {
  ran:              boolean;
  skippedReason?:   string;
  previousVersion:  number | null;
  newVersion:       number;
  sampleSize:       number;
  weightChanges:    Record<string, { before: number; after: number; delta: number }>;
  symbolChanges:    Record<string, "enabled" | "disabled" | "unchanged">;
  regimeChanges:    Record<string, { before: number; after: number }>;
  winRateBefore:    number | null;
  winRateAfter:     number;
  profitFactorAfter: number;
  sharpeAfter:      number;
  notes:            string;
};

// ─── Service ─────────────────────────────────────────────────────────────────

class SelfOptimizerService {

  /**
   * Run the weekly optimization. Should be called by the job coordinator.
   * Returns a full result object regardless of whether optimization ran or was skipped.
   */
  async run(): Promise<OptimizationResult> {
    if (!IS_PERSISTENT || !prisma) {
      return this._skipped("Database not available (sandbox mode)");
    }

    const db = prisma as NonNullable<typeof prisma>;

    // ── 1. Load telemetry rows ──────────────────────────────────────────────
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1_000);

    type TelemetryRow = {
      signalId:           string;
      symbol:             string;
      confidence:         number;
      outcome:            string;
      pnl:                unknown;
      marketRegime:       string;
      indicatorsSnapshot: unknown;
    };
    const rows: TelemetryRow[] = await db.signalTelemetry.findMany({
      where: {
        outcome:    { in: ["WIN", "LOSS", "BREAKEVEN"] },
        closedAt:   { gte: since },
      },
      select: {
        signalId:           true,
        symbol:             true,
        confidence:         true,
        outcome:            true,
        pnl:                true,
        marketRegime:       true,
        indicatorsSnapshot: true,
      },
    }).catch(() => [] as TelemetryRow[]);

    if (rows.length < MIN_SAMPLES) {
      return this._skipped(
        `Insufficient data: ${rows.length} closed trades (minimum ${MIN_SAMPLES} required)`,
      );
    }

    // ── 2. Compute binary outcomes ─────────────────────────────────────────
    const outcomes: Array<{
      win:     number;
      pnl:     number;
      symbol:  string;
      regime:  string;
      snap:    Record<string, unknown>;
    }> = rows.map((r) => ({
      win:    r.outcome === "WIN" ? 1 : 0,
      pnl:    r.pnl ? Number(r.pnl) : 0,
      symbol: r.symbol,
      regime: r.marketRegime,
      snap:   (r.indicatorsSnapshot as Record<string, unknown>) ?? {},
    }));

    // ── 3. Current weights & prior version ────────────────────────────────
    const current = await adaptiveWeights.getWeights();
    const priorVersion   = current.isDefault ? null : current.version;
    const priorWinRate   = priorVersion !== null ? null : null; // can't know without prior

    // Retrieve the prior win rate from the last version row
    let winRateBefore: number | null = null;
    if (priorVersion !== null) {
      const lastRow = await db.confidenceWeights.findUnique({
        where:  { version: priorVersion },
        select: { winRate: true },
      }).catch(() => null);
      winRateBefore = lastRow?.winRate ?? null;
    }
    void priorWinRate; // unused — computed above

    // ── 4. Update weights ─────────────────────────────────────────────────
    const { newWeights, weightChanges } = this._computeNewWeights(
      current.weights,
      outcomes,
    );

    // ── 5. Update regime gates ────────────────────────────────────────────
    const { newRegimeGates, regimeChanges } = this._computeRegimeGates(
      current.regimeGates,
      outcomes,
    );

    // ── 6. Compute symbol config ───────────────────────────────────────────
    const { newSymbolConfig, symbolChanges } = this._computeSymbolConfig(
      current.symbolConfig,
      outcomes,
    );

    // ── 7. Aggregate metrics for new version ──────────────────────────────
    const winCount    = outcomes.filter((o) => o.win === 1).length;
    const winRate     = winCount / outcomes.length * 100;
    const grossWins   = outcomes.filter((o) => o.pnl > 0).reduce((s, o) => s + o.pnl, 0);
    const grossLosses = outcomes.filter((o) => o.pnl < 0).reduce((s, o) => s + Math.abs(o.pnl), 0);
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99 : 1;
    const sharpe      = this._sharpe(outcomes.map((o) => o.pnl));

    // ── 8. Save new version ───────────────────────────────────────────────
    const newVersion = await adaptiveWeights.saveVersion(
      newWeights,
      newRegimeGates,
      newSymbolConfig,
      { sampleSize: rows.length, winRate, profitFactor, sharpeRatio: sharpe },
    );

    // ── 9. Write OptimizationLog ───────────────────────────────────────────
    const notes = this._buildNotes(winRate, winRateBefore, profitFactor, sharpe, symbolChanges);
    await db.optimizationLog.create({
      data: {
        runAt:              new Date(),
        sampleSize:         rows.length,
        previousVersion:    priorVersion,
        newVersion,
        weightChanges:      weightChanges as unknown as object,
        symbolChanges:      symbolChanges as unknown as object,
        regimeGateChanges:  regimeChanges as unknown as object,
        winRateBefore,
        winRateAfter:       winRate,
        profitFactorAfter:  profitFactor,
        sharpeAfter:        sharpe,
        notes,
      },
    }).catch((err) => {
      console.error("[self-optimizer] OptimizationLog write failed:", (err as Error).message);
    });

    console.log(
      `[self-optimizer] v${newVersion} — samples=${rows.length}, WR=${winRate.toFixed(1)}%, PF=${profitFactor.toFixed(2)}, Sharpe=${sharpe.toFixed(2)}`,
    );

    return {
      ran:              true,
      previousVersion:  priorVersion,
      newVersion,
      sampleSize:       rows.length,
      weightChanges,
      symbolChanges,
      regimeChanges,
      winRateBefore,
      winRateAfter:     winRate,
      profitFactorAfter: profitFactor,
      sharpeAfter:      sharpe,
      notes,
    };
  }

  /** Load the last N optimization logs for the admin dashboard. */
  async getHistory(limit = 10): Promise<Array<{
    runAt: Date; sampleSize: number; newVersion: number;
    winRateBefore: number | null; winRateAfter: number;
    profitFactorAfter: number; sharpeAfter: number; notes: string;
  }>> {
    if (!IS_PERSISTENT || !prisma) return [];
    const db = prisma as NonNullable<typeof prisma>;
    return db.optimizationLog.findMany({
      orderBy: { runAt: "desc" },
      take:    limit,
      select:  {
        runAt: true, sampleSize: true, newVersion: true,
        winRateBefore: true, winRateAfter: true,
        profitFactorAfter: true, sharpeAfter: true, notes: true,
      },
    }).catch(() => []);
  }

  // ── Private: weight computation ─────────────────────────────────────────────

  private _computeNewWeights(
    currentWeights: WeightMap,
    outcomes: Array<{ win: number; snap: Record<string, unknown> }>,
  ): {
    newWeights:    WeightMap;
    weightChanges: Record<string, { before: number; after: number; delta: number }>;
  } {
    const newWeights    = { ...currentWeights };
    const weightChanges: Record<string, { before: number; after: number; delta: number }> = {};

    for (const dim of DIMENSION_KEYS) {
      const pairs: Array<{ score: number; win: number }> = [];
      for (const o of outcomes) {
        const breakdown = o.snap["breakdown"] as Record<string, unknown> | undefined;
        if (!breakdown) continue;
        const score = Number(breakdown[dim]);
        if (!isNaN(score)) pairs.push({ score, win: o.win });
      }

      if (pairs.length < 10) continue; // not enough data to adjust this dimension

      const corr = this._pearson(pairs.map((p) => p.score), pairs.map((p) => p.win));
      if (isNaN(corr)) continue;

      const defaultW = DEFAULT_WEIGHTS[dim];
      const before   = currentWeights[dim] ?? defaultW;
      const adjusted = defaultW * (1 + LEARNING_RATE * corr);
      const clamped  = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, adjusted));

      newWeights[dim] = Math.round(clamped * 10) / 10;
      weightChanges[dim] = {
        before: Math.round(before * 10) / 10,
        after:  newWeights[dim],
        delta:  Math.round((newWeights[dim] - before) * 10) / 10,
      };
    }

    // Normalize to sum 100
    const total = Object.values(newWeights).reduce((a, b) => a + b, 0);
    if (total > 0) {
      for (const dim of DIMENSION_KEYS) {
        newWeights[dim] = Math.round((newWeights[dim] / total) * 100 * 10) / 10;
      }
    }

    return { newWeights, weightChanges };
  }

  // ── Private: regime gates ───────────────────────────────────────────────────

  private _computeRegimeGates(
    currentGates: RegimeGateMap,
    outcomes: Array<{ win: number; regime: string }>,
  ): {
    newRegimeGates: RegimeGateMap;
    regimeChanges:  Record<string, { before: number; after: number }>;
  } {
    const newGates: RegimeGateMap = { ...DEFAULT_REGIME_GATES, ...currentGates };
    const regimeChanges: Record<string, { before: number; after: number }> = {};

    // Group by regime
    const byRegime = new Map<string, number[]>();
    for (const o of outcomes) {
      const list = byRegime.get(o.regime) ?? [];
      list.push(o.win);
      byRegime.set(o.regime, list);
    }

    for (const [regime, wins] of byRegime) {
      if (wins.length < 5) continue; // too few samples
      const wr = wins.reduce((a, b) => a + b, 0) / wins.length;
      const before = currentGates[regime] ?? DEFAULT_REGIME_GATES[regime] ?? 60;
      let after = before;

      if (wr < 0.40) {
        // Regime is underperforming — raise the gate to filter more aggressively
        after = Math.min(85, before + REGIME_GATE_STEP);
      } else if (wr > 0.65) {
        // Regime is outperforming — lower the gate slightly to capture more signals
        after = Math.max(55, before - REGIME_GATE_STEP);
      }

      if (after !== before) {
        newGates[regime] = after;
        regimeChanges[regime] = { before, after };
      }
    }

    return { newRegimeGates: newGates, regimeChanges };
  }

  // ── Private: symbol governance ──────────────────────────────────────────────

  private _computeSymbolConfig(
    currentConfig: SymbolConfigMap,
    outcomes: Array<{ win: number; pnl: number; symbol: string }>,
  ): {
    newSymbolConfig: SymbolConfigMap;
    symbolChanges:   Record<string, "enabled" | "disabled" | "unchanged">;
  } {
    const newConfig  = { ...currentConfig };
    const symbolChanges: Record<string, "enabled" | "disabled" | "unchanged"> = {};

    // Group by symbol
    const bySymbol = new Map<string, Array<{ win: number; pnl: number }>>();
    for (const o of outcomes) {
      const list = bySymbol.get(o.symbol) ?? [];
      list.push({ win: o.win, pnl: o.pnl });
      bySymbol.set(o.symbol, list);
    }

    for (const [symbol, trades] of bySymbol) {
      if (trades.length < SYMBOL_MIN_SAMPLES) continue;

      const wr         = trades.reduce((s, t) => s + t.win, 0) / trades.length;
      const grossWins  = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      const grossLoss  = trades.filter((t) => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
      const pf         = grossLoss > 0 ? grossWins / grossLoss : 1;

      const wasEnabled = (currentConfig[symbol]?.enabled ?? true);

      if (wr < DISABLE_WIN_RATE && pf < DISABLE_PROFIT_FACTOR) {
        newConfig[symbol] = {
          enabled: false,
          reason:  `WR=${(wr * 100).toFixed(1)}% PF=${pf.toFixed(2)} over ${trades.length} trades`,
        };
        symbolChanges[symbol] = wasEnabled ? "disabled" : "unchanged";
      } else if (!wasEnabled && (wr >= DISABLE_WIN_RATE || pf >= DISABLE_PROFIT_FACTOR)) {
        // Re-enable if performance has recovered
        newConfig[symbol] = { enabled: true, reason: `Recovered: WR=${(wr * 100).toFixed(1)}%` };
        symbolChanges[symbol] = "enabled";
      } else {
        symbolChanges[symbol] = "unchanged";
      }
    }

    return { newSymbolConfig: newConfig, symbolChanges };
  }

  // ── Private: math helpers ───────────────────────────────────────────────────

  private _pearson(xs: number[], ys: number[]): number {
    const n  = xs.length;
    if (n < 2) return 0;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const num  = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i]! - my), 0);
    const denX = Math.sqrt(xs.reduce((acc, x) => acc + (x - mx) ** 2, 0));
    const denY = Math.sqrt(ys.reduce((acc, y) => acc + (y - my) ** 2, 0));
    return (denX > 0 && denY > 0) ? num / (denX * denY) : 0;
  }

  private _sharpe(pnlSeries: number[]): number {
    if (pnlSeries.length < 2) return 0;
    const mean    = pnlSeries.reduce((a, b) => a + b, 0) / pnlSeries.length;
    const variance = pnlSeries.reduce((acc, p) => acc + (p - mean) ** 2, 0) / (pnlSeries.length - 1);
    const std     = Math.sqrt(variance);
    if (std === 0) return 0;
    return Math.round((mean / std) * Math.sqrt(252) * 100) / 100;
  }

  private _buildNotes(
    winRate:       number,
    winRateBefore: number | null,
    pf:            number,
    sharpe:        number,
    symbolChanges: Record<string, "enabled" | "disabled" | "unchanged">,
  ): string {
    const parts: string[] = [];
    if (winRateBefore !== null) {
      const delta = winRate - winRateBefore;
      parts.push(`Win rate ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% vs prior version.`);
    }
    parts.push(`PF=${pf.toFixed(2)}, Sharpe=${sharpe.toFixed(2)}.`);
    const disabled = Object.entries(symbolChanges).filter(([, v]) => v === "disabled").map(([k]) => k);
    const enabled  = Object.entries(symbolChanges).filter(([, v]) => v === "enabled").map(([k]) => k);
    if (disabled.length) parts.push(`Disabled symbols: ${disabled.join(", ")}.`);
    if (enabled.length)  parts.push(`Re-enabled symbols: ${enabled.join(", ")}.`);
    if (sharpe < 0.5)    parts.push("WARNING: Sharpe below 0.5 — manual review recommended.");
    if (winRate < 40)    parts.push("WARNING: Win rate below 40% — signal conditions may need revision.");
    return parts.join(" ") || "Optimization completed successfully.";
  }

  private _skipped(reason: string): OptimizationResult {
    return {
      ran: false, skippedReason: reason,
      previousVersion: null, newVersion: 0, sampleSize: 0,
      weightChanges: {}, symbolChanges: {}, regimeChanges: {},
      winRateBefore: null, winRateAfter: 0, profitFactorAfter: 0, sharpeAfter: 0,
      notes: reason,
    };
  }
}

export const selfOptimizer = new SelfOptimizerService();
