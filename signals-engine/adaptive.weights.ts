/**
 * AdaptiveWeightsService — loads and caches the current versioned confidence
 * weight set from the ConfidenceWeights table.
 *
 * On every signal evaluation the ConfidenceEngine calls getWeights() to obtain
 * the current weight set. When the SelfOptimizer runs and saves a new version,
 * it calls invalidate() so the next evaluation picks up the updated weights.
 *
 * Default weights (hard-coded) are used when:
 *   - Database is unavailable (sandbox mode)
 *   - No optimizer run has produced a version yet
 *   - The loaded version is corrupted / fails validation
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { DEFAULT_CONFIDENCE_WEIGHTS } from "../ai-core/confidence.engine.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DimensionKey =
  | "trendAlignment"
  | "momentumStrength"
  | "volatilityContext"
  | "volumeConfirmation"
  | "macroAlignment"
  | "sessionTiming"
  | "structureAlignment"
  | "multiTimeframeAlignment"
  | "correlationContext";

export type WeightMap = Record<DimensionKey, number>;

export type RegimeGateMap = Record<string, number>; // regime → minConfidence (0-100)

export type SymbolConfigMap = Record<string, { enabled: boolean; reason: string }>;

export type ActiveWeights = {
  version:      number;
  weights:      WeightMap;
  regimeGates:  RegimeGateMap;
  symbolConfig: SymbolConfigMap;
  isDefault:    boolean;
};

// ─── Defaults ─────────────────────────────────────────────────────────────────

// Reuse ConfidenceEngine's defaults rather than maintaining a second literal
// that has to be kept in sync by hand.
export const DEFAULT_WEIGHTS: WeightMap = { ...DEFAULT_CONFIDENCE_WEIGHTS };

export const DEFAULT_REGIME_GATES: RegimeGateMap = {
  BULLISH_TREND: 60,
  BEARISH_TREND: 60,
  RANGING:       70,
  COMPRESSION:   72,
  EXPANSION:     65,
  VOLATILE:      68,
  RISK_OFF:      999, // effectively blocked — RISK_OFF is hard-suppressed in engine
  // Task 13 Phase 8 — explicit starting gates for RegimeEngine's 4 new regimes,
  // replacing what would otherwise be _computeRegimeGates()'s generic `?? 60`
  // fallback with a defensible, regime-specific default the optimizer can then
  // adapt from real outcomes.
  PANIC:         80, // sharp ADX spike + high ATR — historically unreliable, gate strict until proven otherwise
  RECOVERY:      75, // post-panic re-basing, still unsettled — stricter than a normal trend regime
  ACCUMULATION:  70, // quiet, range-like smart-money phase — same starting gate as RANGING
  DISTRIBUTION:  72, // choppy, topping smart-money phase — same starting gate as COMPRESSION
};

export const DIMENSION_KEYS: DimensionKey[] = [
  "trendAlignment",
  "momentumStrength",
  "volatilityContext",
  "volumeConfirmation",
  "macroAlignment",
  "sessionTiming",
  "structureAlignment",
  "multiTimeframeAlignment",
  "correlationContext",
];

// ─── Service ─────────────────────────────────────────────────────────────────

class AdaptiveWeightsService {
  private _cache: ActiveWeights | null = null;
  private _loading = false;

  /**
   * Returns the current active weight set.
   * Loads from DB on first call; returns cached value on subsequent calls.
   * Falls back to defaults if DB is unavailable or no version exists yet.
   */
  async getWeights(): Promise<ActiveWeights> {
    if (this._cache) return this._cache;
    if (!IS_PERSISTENT || !prisma) return this._defaults();

    if (this._loading) return this._defaults(); // guard against reentrant load
    this._loading = true;

    try {
      const db  = prisma as NonNullable<typeof prisma>;
      const row = await db.confidenceWeights.findFirst({
        orderBy: { version: "desc" },
      });

      if (!row) {
        this._loading = false;
        return this._defaults();
      }

      const weights     = this._validateWeights(row.weights as Record<string, unknown>);
      const regimeGates = this._validateRegimeGates(row.regimeGates as Record<string, unknown>);
      const symbolConfig = row.symbolConfig as SymbolConfigMap ?? {};

      this._cache = {
        version:      row.version,
        weights,
        regimeGates,
        symbolConfig,
        isDefault:    false,
      };
      this._loading = false;
      return this._cache;

    } catch (err) {
      console.error("[adaptive-weights] failed to load from DB:", (err as Error).message);
      this._loading = false;
      return this._defaults();
    }
  }

  /**
   * Called by SelfOptimizer after writing a new version — forces the next
   * getWeights() call to re-read from DB.
   */
  invalidate(): void {
    this._cache = null;
    console.log("[adaptive-weights] cache invalidated — next signal evaluation will reload weights");
  }

  /**
   * Save a new weight version to the database.
   * Returns the new version number.
   */
  async saveVersion(
    weights:      WeightMap,
    regimeGates:  RegimeGateMap,
    symbolConfig: SymbolConfigMap,
    meta: {
      sampleSize:   number;
      winRate:      number;
      profitFactor: number;
      sharpeRatio:  number;
    },
  ): Promise<number> {
    if (!IS_PERSISTENT || !prisma) throw new Error("Database required to save weights");

    const db  = prisma as NonNullable<typeof prisma>;
    const last = await db.confidenceWeights.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    const nextVersion = (last?.version ?? 0) + 1;

    await db.confidenceWeights.create({
      data: {
        version:      nextVersion,
        weights:      weights as unknown as object,
        regimeGates:  regimeGates as unknown as object,
        symbolConfig: symbolConfig as unknown as object,
        sampleSize:   meta.sampleSize,
        winRate:      meta.winRate,
        profitFactor: meta.profitFactor,
        sharpeRatio:  meta.sharpeRatio,
        computedAt:   new Date(),
      },
    });

    this.invalidate();
    console.log(`[adaptive-weights] version ${nextVersion} saved — ${meta.sampleSize} samples, winRate=${meta.winRate.toFixed(1)}%, PF=${meta.profitFactor.toFixed(2)}`);
    return nextVersion;
  }

  /** Get all historical versions for the admin dashboard. */
  async getHistory(limit = 20): Promise<Array<{
    version: number; sampleSize: number; winRate: number;
    profitFactor: number; sharpeRatio: number; computedAt: Date;
  }>> {
    if (!IS_PERSISTENT || !prisma) return [];
    const db = prisma as NonNullable<typeof prisma>;
    return db.confidenceWeights.findMany({
      orderBy: { version: "desc" },
      take:    limit,
      select: { version: true, sampleSize: true, winRate: true, profitFactor: true, sharpeRatio: true, computedAt: true },
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _defaults(): ActiveWeights {
    return {
      version:      0,
      weights:      { ...DEFAULT_WEIGHTS },
      regimeGates:  { ...DEFAULT_REGIME_GATES },
      symbolConfig: {},
      isDefault:    true,
    };
  }

  private _validateWeights(raw: Record<string, unknown>): WeightMap {
    const validated: Partial<WeightMap> = {};
    for (const key of DIMENSION_KEYS) {
      const v = Number(raw[key]);
      validated[key] = isNaN(v) || v < 0 ? DEFAULT_WEIGHTS[key] : v;
    }
    // Normalize to sum 100
    const total = Object.values(validated).reduce((a, b) => a + b!, 0);
    if (total === 0) return { ...DEFAULT_WEIGHTS };
    for (const key of DIMENSION_KEYS) {
      validated[key] = Math.round((validated[key]! / total) * 100 * 10) / 10;
    }
    return validated as WeightMap;
  }

  private _validateRegimeGates(raw: Record<string, unknown>): RegimeGateMap {
    const out: RegimeGateMap = { ...DEFAULT_REGIME_GATES };
    for (const [regime, val] of Object.entries(raw)) {
      const n = Number(val);
      if (!isNaN(n) && n >= 0 && n <= 100) out[regime] = n;
    }
    return out;
  }
}

export const adaptiveWeights = new AdaptiveWeightsService();
