/**
 * DynamicSpreadEngine — volatility-adaptive spread widening for the IGFX B-book.
 *
 * Widens broker spreads in two conditions:
 *
 *   1. VOLATILITY: when 1-min price movement exceeds a per-asset-class threshold.
 *      Formula: spread × (1 + volatilityFactor × clamp(|changePct| / threshold, 0, 3))
 *
 *   2. EVENTS: during pre-configured high-impact economic event windows
 *      (±window minutes around the event time).
 *      Spread is multiplied by the event's multiplier during the window.
 *
 * Both conditions stack multiplicatively, capped by per-asset-class maxSpread.
 *
 * All spread changes are:
 *   - Written to AuditLog (actor = DYNAMIC_SPREAD_ENGINE)
 *   - Applied in-memory only — base spread in BrokerSpreadConfig is not changed
 *   - Returned by getEffectiveSpread(symbol) for use by InternalLiquidityCore
 *
 * Usage: call applySpread(symbol, changePct) on every price tick received.
 * The result replaces the base broker spread for the next execution window.
 */

import { prisma }           from "../shared/db.js";
import { immutableAudit }   from "../security/immutable.audit.js";
import { brokerSpreadConfig } from "./broker.spread.config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SpreadEvent = {
  name:      string;
  assetClasses: string[];    // which asset classes are affected
  windowMinutes: number;     // how many minutes before/after event to widen
  multiplier: number;        // spread × multiplier during window
  scheduledAt: Date;
};

type SpreadState = {
  effectiveSpread: number;
  multiplier:      number;
  reason:          string;
  updatedAt:       Date;
};

// ─── Asset class config ───────────────────────────────────────────────────────

const ASSET_CLASS_CONFIG: Record<string, {
  volatilityThresholdPct: number;   // % move that triggers widening
  volatilityFactor:       number;   // max multiplier at 3× threshold
  maxSpreadMultiplier:    number;   // absolute cap on any multiplier
}> = {
  FX_MAJOR:   { volatilityThresholdPct: 0.15,  volatilityFactor: 1.5, maxSpreadMultiplier: 5.0 },
  FX_MINOR:   { volatilityThresholdPct: 0.20,  volatilityFactor: 2.0, maxSpreadMultiplier: 6.0 },
  INDEX:      { volatilityThresholdPct: 0.30,  volatilityFactor: 1.5, maxSpreadMultiplier: 4.0 },
  COMMODITY:  { volatilityThresholdPct: 0.40,  volatilityFactor: 2.0, maxSpreadMultiplier: 5.0 },
  CRYPTO:     { volatilityThresholdPct: 0.80,  volatilityFactor: 2.5, maxSpreadMultiplier: 8.0 },
  EQUITY:     { volatilityThresholdPct: 0.50,  volatilityFactor: 1.5, maxSpreadMultiplier: 4.0 },
};

// Default for unrecognised asset classes
const DEFAULT_CONFIG = { volatilityThresholdPct: 0.30, volatilityFactor: 1.5, maxSpreadMultiplier: 4.0 };

// ─── Engine ───────────────────────────────────────────────────────────────────

export class DynamicSpreadEngine {
  private readonly states   = new Map<string, SpreadState>();
  private readonly events:   SpreadEvent[] = [];
  private auditEnabled      = true;

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Called on every price tick. Computes the effective spread for the symbol
   * and stores it for the next execution window.
   * @returns effective spread in price units
   */
  applySpread(symbol: string, changePct: number, assetClass: string): number {
    const baseSpread = brokerSpreadConfig.getSpread(symbol) ?? 0;
    if (baseSpread <= 0) return 0;

    const cfg       = ASSET_CLASS_CONFIG[assetClass] ?? DEFAULT_CONFIG;
    const absChange = Math.abs(changePct);

    // ── 1. Volatility multiplier ─────────────────────────────────────────────
    let volMult = 1.0;
    if (absChange > cfg.volatilityThresholdPct) {
      const ratio  = Math.min(absChange / cfg.volatilityThresholdPct, 3);
      volMult      = 1.0 + cfg.volatilityFactor * (ratio - 1) / 2;
    }

    // ── 2. Event multiplier ──────────────────────────────────────────────────
    let eventMult    = 1.0;
    let eventReason  = "";
    const now        = new Date();

    for (const ev of this.events) {
      if (!ev.assetClasses.includes(assetClass) && !ev.assetClasses.includes("ALL")) continue;
      const windowMs  = ev.windowMinutes * 60_000;
      const eventMs   = ev.scheduledAt.getTime();
      const diffMs    = Math.abs(now.getTime() - eventMs);
      if (diffMs <= windowMs) {
        if (ev.multiplier > eventMult) {
          eventMult   = ev.multiplier;
          eventReason = ev.name;
        }
      }
    }

    // ── 3. Combined multiplier with cap ─────────────────────────────────────
    const combined = Math.min(volMult * eventMult, cfg.maxSpreadMultiplier);
    const effective = Number((baseSpread * combined).toFixed(6));

    const prev = this.states.get(symbol);

    // ── 4. Log significant changes (>10% spread change) ─────────────────────
    const prevSpread = prev?.effectiveSpread ?? baseSpread;
    const pctChange  = Math.abs((effective - prevSpread) / prevSpread);

    const reason = [
      volMult  > 1.01 ? `volatility×${volMult.toFixed(2)}` : null,
      eventMult > 1.0 ? `event[${eventReason}]×${eventMult.toFixed(1)}` : null,
    ].filter(Boolean).join(" ") || "normal";

    this.states.set(symbol, { effectiveSpread: effective, multiplier: combined, reason, updatedAt: now });

    if (this.auditEnabled && pctChange > 0.10 && combined !== (prev?.multiplier ?? 1.0)) {
      void this._logToAudit(symbol, baseSpread, effective, combined, reason);
    }

    return effective;
  }

  /** Returns the currently active effective spread, or base spread if not computed yet. */
  getEffectiveSpread(symbol: string): number {
    const state = this.states.get(symbol);
    if (state) return state.effectiveSpread;
    return brokerSpreadConfig.getSpread(symbol) ?? 0;
  }

  /** Returns the current multiplier (1.0 = no widening). */
  getMultiplier(symbol: string): number {
    return this.states.get(symbol)?.multiplier ?? 1.0;
  }

  /** Returns all symbols with active spread widening (multiplier > 1.05). */
  getWideningSymbols(): { symbol: string; multiplier: number; reason: string }[] {
    return [...this.states.entries()]
      .filter(([, s]) => s.multiplier > 1.05)
      .map(([symbol, s]) => ({ symbol, multiplier: s.multiplier, reason: s.reason }));
  }

  // ── Event calendar management ────────────────────────────────────────────

  addEvent(ev: SpreadEvent, actor?: string): void {
    this.events.push(ev);
    this._pruneStaleEvents();
    console.log(`[dynamic-spread] event scheduled: ${ev.name} at ${ev.scheduledAt.toISOString()} ×${ev.multiplier}`);
    // PHASE2_REMEDIATION (H16, admin audit-log gap): a scheduled spread-
    // widening event affects every trader's effective spread on the named
    // symbols for the whole window -- had zero permanent record of who
    // scheduled it. `actor` is only supplied by the admin route; internal/
    // system callers (none currently exist) can omit it to skip the write.
    if (actor) {
      void immutableAudit.write({
        actor,
        action:  "spread.event_added",
        entity:  ev.name,
        payload: { ...ev, scheduledAt: ev.scheduledAt.toISOString() } as object,
      }).catch(() => {});
    }
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  getEvents(): SpreadEvent[] {
    this._pruneStaleEvents();
    return [...this.events];
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _pruneStaleEvents(): void {
    const cutoff = Date.now() - 2 * 60 * 60_000; // remove events older than 2h
    const before = this.events.length;
    this.events.splice(0, this.events.length,
      ...this.events.filter((e) => e.scheduledAt.getTime() + e.windowMinutes * 60_000 > cutoff)
    );
    if (this.events.length < before) {
      // Events pruned silently
    }
  }

  private async _logToAudit(
    symbol:    string,
    base:      number,
    effective: number,
    mult:      number,
    reason:    string,
  ): Promise<void> {
    if (!prisma) return;
    try {
      await immutableAudit.write({
        actor:   "DYNAMIC_SPREAD_ENGINE",
        action:  "spread.widened",
        entity:  symbol,
        payload: { baseSpread: base, effectiveSpread: effective, multiplier: mult, reason } as object,
      });
    } catch {
      // Non-fatal — spread audit logging is best-effort
    }
  }
}

export const dynamicSpreadEngine = new DynamicSpreadEngine();
