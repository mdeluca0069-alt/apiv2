/**
 * AutopilotService — manages per-user autopilot configuration.
 *
 * Configuration is persisted in the AutopilotConfig table.
 * In SANDBOX mode (no DB) the config lives in memory only.
 * Every config change writes an immutable AuditLog entry.
 */
import { immutableAudit } from "../security/immutable.audit.js";
import { z }          from "zod";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }              from "../events-bus/event.bus.js";
import { autopilotEligibility }  from "./autopilot.eligibility.js";
import { autopilotConsentService } from "./autopilot.consent.js";

// ─── Validation schema ────────────────────────────────────────────────────────

export const AutopilotConfigInputSchema = z.object({
  enabled:        z.boolean().optional(),
  mode:           z.enum(["CONSERVATIVE", "BALANCED", "AGGRESSIVE"]).optional(),
  minConfidence:  z.number().min(0.4).max(0.99).optional(),
  maxRiskPerTrade: z.number().min(0.005).max(0.15).optional(),
  maxOpenTrades:  z.number().int().min(1).max(20).optional(),
  maxExposurePct: z.number().min(1).max(100).optional(),
  allowedSymbols: z.array(z.string().min(3)).optional(),
  blockedSymbols: z.array(z.string().min(3)).optional(),
  stopDrawdownPct: z.number().min(1).max(50).optional(),
  capitalPct:     z.number().min(10).max(100).optional(),
  // Safety gates (generalized from the old platform-only bot to every user)
  eventLockMinutes: z.number().int().min(0).max(240).optional(),
  maxDailyTrades:   z.number().int().min(1).max(100).optional(),
  // Trade management — applied continuously to open positions by AutopilotPositionManager
  breakEvenTriggerR:   z.number().min(0.1).max(5).optional(),
  trailingStopEnabled: z.boolean().optional(),
  trailingActivationR: z.number().min(0.1).max(10).optional(),
  atrTrailMultiple:    z.number().min(0.5).max(10).optional(),
  regimeExitEnabled:   z.boolean().optional(),
  maxHoursOpen:        z.number().int().min(1).max(720).optional(),
  // Real-client safety layer
  maxDailyLossPct:     z.number().min(1).max(50).optional(),
  maxSpreadBps:        z.number().int().min(1).max(200).optional(),
});

export type AutopilotConfigInput = z.infer<typeof AutopilotConfigInputSchema>;

export type AutopilotConfigFull = {
  userId:          string;
  enabled:         boolean;
  mode:            "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
  minConfidence:   number;
  maxRiskPerTrade: number;
  maxOpenTrades:   number;
  maxExposurePct:  number;
  allowedSymbols:  string[];
  blockedSymbols:  string[];
  stopDrawdownPct: number;
  capitalPct:      number;
  eventLockMinutes:    number;
  maxDailyTrades:      number;
  breakEvenTriggerR:   number;
  trailingStopEnabled: boolean;
  trailingActivationR: number;
  atrTrailMultiple:    number;
  regimeExitEnabled:   boolean;
  maxHoursOpen:        number;
  // Real-client safety layer
  maxDailyLossPct:      number;
  maxSpreadBps:         number;
  consentVersion?:      string;
  consentAcceptedAt?:   string;
  dailyLossLockedUntil?: string;
  // Task 14 Phase 3 — set only via adminSetPause(), never via the client's own saveConfig().
  pausedByAdmin:   boolean;
  pausedReason?:   string;
  pausedAt?:       string;
  tier:            string;
  lastDecision?:   { symbol: string; action: string; reason: string; timestamp: string };
  updatedAt:       string;
};

// ─── In-memory fallback (sandbox mode) ───────────────────────────────────────

const _memoryStore = new Map<string, AutopilotConfigFull>();

// Short-TTL read-through cache for persistent-DB mode.
// getConfig() is called on every autopilot signal evaluation; caching here
// eliminates the most frequent DB round-trip in the system. Config changes
// are written through immediately by saveConfig(), keeping staleness ≤ TTL.
const CONFIG_CACHE_TTL_MS = 5_000; // 5 s — signal cycles run every 30 s
type CacheEntry = { value: AutopilotConfigFull; expiresAt: number };
const _configCache = new Map<string, CacheEntry>();

function defaultConfig(userId: string): AutopilotConfigFull {
  return {
    userId,
    enabled:         false,
    mode:            "BALANCED",
    minConfidence:   0.70,
    maxRiskPerTrade: 0.05,
    maxOpenTrades:   3,
    maxExposurePct:  20,
    allowedSymbols:  ["EURUSD", "XAUUSD", "US500", "BTCUSD"],
    blockedSymbols:  [],
    stopDrawdownPct: 10,
    capitalPct:      100,
    eventLockMinutes:    30,
    maxDailyTrades:      10,
    breakEvenTriggerR:   1.0,
    trailingStopEnabled: true,
    trailingActivationR: 1.5,
    atrTrailMultiple:    2.0,
    regimeExitEnabled:   true,
    maxHoursOpen:        48,
    maxDailyLossPct:     5.0,
    maxSpreadBps:        15,
    pausedByAdmin:   false,
    tier:            "STANDARD",
    updatedAt:       new Date().toISOString(),
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class AutopilotService {

  async getConfig(userId: string): Promise<AutopilotConfigFull> {
    if (!IS_PERSISTENT) {
      if (!_memoryStore.has(userId)) _memoryStore.set(userId, defaultConfig(userId));
      return _memoryStore.get(userId)!;
    }

    const cached = _configCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const row = await prisma.autopilotConfig.findUnique({ where: { userId } });
    const value = row ? this._toFull(row) : defaultConfig(userId);
    _configCache.set(userId, { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
    return value;
  }

  async saveConfig(
    userId: string,
    input:  AutopilotConfigInput,
    actorId = userId,
  ): Promise<AutopilotConfigFull> {
    const validated = AutopilotConfigInputSchema.parse(input);

    // Turning autopilot ON requires server-side eligibility (KYC/tier/funded
    // account) and a recorded consent acceptance — checked here regardless of
    // what the client UI already enforced, and again inside the pipeline on
    // every signal as defense in depth.
    if (validated.enabled === true) {
      const current = await this.getConfig(userId);
      if (!current.enabled) {
        const elig = await autopilotEligibility.assertEligible(userId);
        if (!elig.eligible) {
          throw Object.assign(new Error(`AUTOPILOT_NOT_ELIGIBLE: ${elig.reason}`), { statusCode: 403 });
        }
        const consent = await autopilotConsentService.getStatus(userId);
        if (!consent.accepted) {
          throw Object.assign(new Error("AUTOPILOT_CONSENT_REQUIRED"), { statusCode: 422 });
        }
      }
    }

    if (!IS_PERSISTENT) {
      const existing = _memoryStore.get(userId) ?? defaultConfig(userId);
      const updated: AutopilotConfigFull = {
        ...existing,
        ...validated,
        updatedAt: new Date().toISOString(),
      };
      _memoryStore.set(userId, updated);
      eventBus.emit("autopilot.config_changed", { userId, enabled: updated.enabled });
      return updated;
    }

    const row = await prisma.autopilotConfig.upsert({
      where:  { userId },
      create: { userId, ...this._toDbInput(validated) },
      update: this._toDbInput(validated),
    });

    await immutableAudit.write({
      actor:   actorId,
      action:  "autopilot.config_updated",
      entity:  userId,
      payload: validated as object,
    });

    const full = this._toFull(row);
    _configCache.delete(userId); // invalidate TTL cache so next read is fresh
    eventBus.emit("autopilot.config_changed", { userId, enabled: full.enabled });
    return full;
  }

  /**
   * Admin-only pause/resume for a single client's autopilot — separate from
   * the client's own `enabled` toggle (saveConfig()) so the client's next
   * config save can never silently undo an admin-imposed pause. Mirrors
   * saveConfig()'s persist+audit pattern exactly.
   */
  async adminSetPause(
    userId: string,
    paused: boolean,
    reason: string | undefined,
    actorId: string,
  ): Promise<AutopilotConfigFull> {
    const pausedAt = paused ? new Date().toISOString() : undefined;

    if (!IS_PERSISTENT) {
      const existing = _memoryStore.get(userId) ?? defaultConfig(userId);
      const updated: AutopilotConfigFull = {
        ...existing,
        pausedByAdmin: paused,
        pausedReason:  paused ? reason : undefined,
        pausedAt,
        updatedAt: new Date().toISOString(),
      };
      _memoryStore.set(userId, updated);
      return updated;
    }

    const row = await prisma.autopilotConfig.upsert({
      where:  { userId },
      create: {
        userId,
        pausedByAdmin: paused,
        pausedReason:  paused ? reason : null,
        pausedAt:      paused ? new Date() : null,
      },
      update: {
        pausedByAdmin: paused,
        pausedReason:  paused ? reason : null,
        pausedAt:      paused ? new Date() : null,
      },
    });

    await immutableAudit.write({
      actor:   actorId,
      action:  "autopilot.admin_pause",
      entity:  userId,
      payload: { paused, reason } as object,
    });

    _configCache.delete(userId);
    return this._toFull(row);
  }

  /**
   * Per-client daily loss breaker (distinct from adminSetPause): set by
   * AutopilotPositionManager when a single client's realized+floating P&L
   * for the day breaches their own maxDailyLossPct. Blocks new entries for
   * that client until `until` (end of UTC day) — existing open positions are
   * still managed normally (break-even/trailing/time-stop keep running).
   */
  async setDailyLossLock(userId: string, until: Date, actorId: string): Promise<void> {
    if (!IS_PERSISTENT) {
      const existing = _memoryStore.get(userId) ?? defaultConfig(userId);
      _memoryStore.set(userId, { ...existing, dailyLossLockedUntil: until.toISOString() });
      return;
    }

    await prisma.autopilotConfig.upsert({
      where:  { userId },
      create: { userId, dailyLossLockedUntil: until },
      update: { dailyLossLockedUntil: until },
    });

    _configCache.delete(userId);

    await immutableAudit.write({
      actor:   actorId,
      action:  "autopilot.daily_loss_lock",
      entity:  userId,
      payload: { lockedUntil: until.toISOString() },
    });
  }

  async recordDecision(
    userId:  string,
    symbol:  string,
    action:  string,
    reason:  string,
  ): Promise<void> {
    const decision = { symbol, action, reason, timestamp: new Date().toISOString() };

    if (!IS_PERSISTENT) {
      const cfg = _memoryStore.get(userId) ?? defaultConfig(userId);
      _memoryStore.set(userId, { ...cfg, lastDecision: decision });
      return;
    }

    await prisma.autopilotConfig.update({
      where: { userId },
      data:  { lastDecision: decision as object },
    });

    await immutableAudit.write({
      actor:   "AUTOPILOT_ENGINE",
      action:  `autopilot.decision.${action.toLowerCase()}`,
      entity:  userId,
      payload: decision as object,
    });
  }

  private _toDbInput(input: AutopilotConfigInput): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (input.enabled        !== undefined) out.enabled        = input.enabled;
    if (input.mode           !== undefined) out.mode           = input.mode;
    if (input.minConfidence  !== undefined) out.minConfidence  = input.minConfidence;
    if (input.maxRiskPerTrade !== undefined) out.maxRiskPerTrade = input.maxRiskPerTrade;
    if (input.maxOpenTrades  !== undefined) out.maxOpenTrades  = input.maxOpenTrades;
    if (input.maxExposurePct !== undefined) out.maxExposurePct = input.maxExposurePct;
    if (input.allowedSymbols !== undefined) out.allowedSymbols = input.allowedSymbols;
    if (input.blockedSymbols !== undefined) out.blockedSymbols = input.blockedSymbols;
    if (input.stopDrawdownPct !== undefined) out.stopDrawdownPct = input.stopDrawdownPct;
    if (input.capitalPct     !== undefined) out.capitalPct     = input.capitalPct;
    if (input.eventLockMinutes    !== undefined) out.eventLockMinutes    = input.eventLockMinutes;
    if (input.maxDailyTrades      !== undefined) out.maxDailyTrades      = input.maxDailyTrades;
    if (input.breakEvenTriggerR   !== undefined) out.breakEvenTriggerR   = input.breakEvenTriggerR;
    if (input.trailingStopEnabled !== undefined) out.trailingStopEnabled = input.trailingStopEnabled;
    if (input.trailingActivationR !== undefined) out.trailingActivationR = input.trailingActivationR;
    if (input.atrTrailMultiple    !== undefined) out.atrTrailMultiple    = input.atrTrailMultiple;
    if (input.regimeExitEnabled   !== undefined) out.regimeExitEnabled   = input.regimeExitEnabled;
    if (input.maxHoursOpen        !== undefined) out.maxHoursOpen        = input.maxHoursOpen;
    if (input.maxDailyLossPct     !== undefined) out.maxDailyLossPct     = input.maxDailyLossPct;
    if (input.maxSpreadBps        !== undefined) out.maxSpreadBps        = input.maxSpreadBps;
    return out;
  }

  private _toFull(row: Record<string, unknown>): AutopilotConfigFull {
    return {
      userId:          String(row.userId ?? ""),
      enabled:         Boolean(row.enabled ?? false),
      mode:            (row.mode as AutopilotConfigFull["mode"]) ?? "BALANCED",
      minConfidence:   Number(row.minConfidence ?? 0.70),
      maxRiskPerTrade: Number(row.maxRiskPerTrade ?? 0.05),
      maxOpenTrades:   Number(row.maxOpenTrades ?? 3),
      maxExposurePct:  Number(row.maxExposurePct ?? 20),
      allowedSymbols:  Array.isArray(row.allowedSymbols) ? row.allowedSymbols.map(String) : [],
      blockedSymbols:  Array.isArray(row.blockedSymbols) ? row.blockedSymbols.map(String) : [],
      stopDrawdownPct: Number(row.stopDrawdownPct ?? 10),
      capitalPct:      Number(row.capitalPct ?? 100),
      eventLockMinutes:    Number(row.eventLockMinutes ?? 30),
      maxDailyTrades:      Number(row.maxDailyTrades ?? 10),
      breakEvenTriggerR:   Number(row.breakEvenTriggerR ?? 1.0),
      trailingStopEnabled: row.trailingStopEnabled !== undefined ? Boolean(row.trailingStopEnabled) : true,
      trailingActivationR: Number(row.trailingActivationR ?? 1.5),
      atrTrailMultiple:    Number(row.atrTrailMultiple ?? 2.0),
      regimeExitEnabled:   row.regimeExitEnabled !== undefined ? Boolean(row.regimeExitEnabled) : true,
      maxHoursOpen:        Number(row.maxHoursOpen ?? 48),
      maxDailyLossPct:     Number(row.maxDailyLossPct ?? 5.0),
      maxSpreadBps:        Number(row.maxSpreadBps ?? 15),
      consentVersion:      row.consentVersion ? String(row.consentVersion) : undefined,
      consentAcceptedAt:   row.consentAcceptedAt instanceof Date ? row.consentAcceptedAt.toISOString() : undefined,
      dailyLossLockedUntil: row.dailyLossLockedUntil instanceof Date ? row.dailyLossLockedUntil.toISOString() : undefined,
      pausedByAdmin:   Boolean(row.pausedByAdmin ?? false),
      pausedReason:    row.pausedReason ? String(row.pausedReason) : undefined,
      pausedAt:        row.pausedAt instanceof Date ? row.pausedAt.toISOString() : undefined,
      tier:            String(row.tier ?? "STANDARD"),
      lastDecision:    row.lastDecision
        ? (row.lastDecision as AutopilotConfigFull["lastDecision"])
        : undefined,
      updatedAt:       row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt ?? new Date().toISOString()),
    };
  }
}

export const autopilotService = new AutopilotService();
