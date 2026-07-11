/**
 * SymbolCircuitBreaker — per-symbol automated trading halt on an abnormal
 * short-window price move.
 *
 * FASE 3.2 (Internal Liquidity Engine). Distinct from everything else that
 * already reacts to price movement in this codebase:
 *   - `dynamic.spread.engine.ts` reacts to DAILY change-from-open and only
 *     WIDENS the spread — a pricing response, never a trading halt.
 *   - `quoteCache.isStale()` / `feed.health.monitor.ts` detect a feed gone
 *     SILENT (no ticks) — this engine detects the opposite: ticks arriving
 *     that move the price too FAST, a flash-move/bad-tick signal, not a
 *     staleness signal.
 *   - `risk-service/kill.switch.ts` / `global.risk.supervisor.ts` are
 *     platform-wide — this is the missing per-symbol analog.
 *
 * Mechanism: on every tick, track a short rolling window of recent prices
 * per symbol. If the price has moved more than the asset class's threshold
 * since the oldest tick still in that window, halt new order acceptance
 * for that symbol via the SAME enforcement point admin manual disables
 * already use (`brokerSpreadConfig.isEnabled()`, checked in
 * order.controller.ts both for new orders and for pending orders about to
 * trigger) — no second, parallel gate. Auto-recovers after a fixed
 * cooldown UNLESS the condition re-trips, via a periodic sweep
 * (main.ts, leader-elected like every other periodic job in this repo).
 *
 * Does NOT touch a symbol an admin disabled through the ordinary
 * /admin/broker/spread route — only re-enables symbols THIS engine itself
 * halted (tracked internally), so it can never override deliberate admin
 * intent on auto-recovery.
 */

import { brokerSpreadConfig } from "../liquidity-engine/broker.spread.config.js";
import { alertManager }       from "../alerting/alert.manager.js";
import { metrics }            from "../gateway/metrics.js";

const WINDOW_MS   = 10_000;   // "abnormal move" measured over this rolling window
const COOLDOWN_MS = 5 * 60_000; // halt duration before auto-recovery is attempted

// Percent move within WINDOW_MS that trips the breaker. Deliberately a much
// higher bar than dynamic.spread.engine.ts's widening thresholds (which
// react to daily change, not a 10s window) — this should only fire on a
// genuine flash move or bad tick, not ordinary volatility.
const HALT_THRESHOLD_PCT: Record<string, number> = {
  FX_MAJOR:  0.5,
  FX_MINOR:  0.7,
  INDEX:     1.0,
  COMMODITY: 1.3,
  CRYPTO:    3.0,
  EQUITY:    2.0,
};
const DEFAULT_HALT_THRESHOLD_PCT = 1.5;

type TickRecord = { price: number; ts: number };

export type HaltState = {
  symbol:      string;
  haltedAt:    string;
  cooldownEndsAt: string;
  movePct:     number;
  windowMs:    number;
};

export class SymbolCircuitBreaker {
  private readonly recentTicks = new Map<string, TickRecord[]>();
  // Symbols THIS engine halted, with when the cooldown ends — never includes
  // symbols an admin disabled directly, so the recovery sweep never touches those.
  private readonly haltedByBreaker = new Map<string, { haltedAt: number; movePct: number }>();

  /**
   * Record a new tick and trip the breaker if the price moved more than the
   * asset class's threshold within the rolling window. Called from
   * InternalLiquidityCore.ingestExternalPrice() on every accepted tick —
   * mirrors how dynamicSpreadEngine.applySpread() and
   * feedHealthMonitor.recordQuote() are already wired into that same path.
   */
  recordTick(symbol: string, price: number, assetClass: string): void {
    if (!isFinite(price) || price <= 0) return;
    const now = Date.now();

    const window = this.recentTicks.get(symbol) ?? [];
    window.push({ price, ts: now });
    const cutoff = now - WINDOW_MS;
    const trimmed = window.filter((t) => t.ts >= cutoff);
    this.recentTicks.set(symbol, trimmed);

    if (trimmed.length < 2) return; // need at least two ticks to measure a move

    const oldest = trimmed[0];
    const movePct = Math.abs((price - oldest.price) / oldest.price) * 100;
    const threshold = HALT_THRESHOLD_PCT[assetClass] ?? DEFAULT_HALT_THRESHOLD_PCT;

    if (movePct <= threshold) return;

    if (this.haltedByBreaker.has(symbol)) {
      // Already ours — still moving abnormally, extend the cooldown without
      // re-alerting or re-calling setEnabled (it's already disabled).
      this.haltedByBreaker.set(symbol, { haltedAt: Date.now(), movePct });
      return;
    }

    if (brokerSpreadConfig.isEnabled(symbol)) {
      // Currently enabled and not already ours — take ownership and halt.
      void this._trip(symbol, movePct, threshold);
    }
    // else: already disabled by someone else (an admin) and not tracked as
    // ours — never take ownership of a halt we didn't cause, or the
    // recovery sweep could re-enable a symbol an admin deliberately disabled.
  }

  /** True if this engine (not an admin) is currently holding this symbol halted. */
  isHaltedByBreaker(symbol: string): boolean {
    return this.haltedByBreaker.has(symbol.toUpperCase());
  }

  /** Snapshot of every symbol currently halted by this engine, for admin visibility. */
  getHaltedSymbols(): HaltState[] {
    return [...this.haltedByBreaker.entries()].map(([symbol, h]) => ({
      symbol,
      haltedAt:       new Date(h.haltedAt).toISOString(),
      cooldownEndsAt: new Date(h.haltedAt + COOLDOWN_MS).toISOString(),
      movePct:        h.movePct,
      windowMs:        WINDOW_MS,
    }));
  }

  /**
   * Admin-triggered early clear, before the cooldown elapses (the
   * /admin/symbol-circuit-breaker/:symbol/reset route). Caller must have
   * already confirmed isHaltedByBreaker(symbol) — this doesn't touch a
   * symbol it didn't halt itself.
   */
  async clear(symbol: string, adminId: string): Promise<void> {
    const key = symbol.toUpperCase();
    await brokerSpreadConfig.setEnabled(key, true, adminId);
    this.haltedByBreaker.delete(key);
    console.log(`[symbol-circuit-breaker] ${key} manually cleared by ${adminId}`);
  }

  /**
   * Periodic recovery sweep — main.ts calls this every 30s (leader-elected).
   * Re-enables any symbol this engine halted whose cooldown has elapsed.
   * A symbol that re-trips before its cooldown ends gets its halt extended
   * (handled naturally: _trip() overwrites the haltedAt timestamp).
   */
  async runRecoverySweep(): Promise<{ recovered: string[] }> {
    const now = Date.now();
    const recovered: string[] = [];

    for (const [symbol, h] of this.haltedByBreaker) {
      if (now - h.haltedAt < COOLDOWN_MS) continue;
      try {
        await brokerSpreadConfig.setEnabled(symbol, true, "system:circuit-breaker");
        this.haltedByBreaker.delete(symbol);
        recovered.push(symbol);
        console.log(`[symbol-circuit-breaker] ${symbol} cooldown elapsed — trading resumed`);
      } catch (err) {
        console.error(`[symbol-circuit-breaker] failed to resume ${symbol}:`, (err as Error).message);
      }
    }

    return { recovered };
  }

  /** Takes ownership of a fresh halt — caller (recordTick) has already
   *  confirmed this symbol isn't already tracked as ours. */
  private async _trip(symbol: string, movePct: number, threshold: number): Promise<void> {
    try {
      await brokerSpreadConfig.setEnabled(symbol, false, "system:circuit-breaker");
      this.haltedByBreaker.set(symbol, { haltedAt: Date.now(), movePct });
      console.warn(
        `[symbol-circuit-breaker] ${symbol} HALTED — moved ${movePct.toFixed(3)}% in ${WINDOW_MS / 1000}s ` +
        `(threshold ${threshold}%), cooldown ${COOLDOWN_MS / 60_000}min`
      );
      metrics.inc("symbol_circuit_breaker_trips_total");
      void alertManager.symbolCircuitBreakerTripped(symbol, movePct, WINDOW_MS / 1000);
    } catch (err) {
      console.error(`[symbol-circuit-breaker] failed to halt ${symbol}:`, (err as Error).message);
    }
  }
}

export const symbolCircuitBreaker = new SymbolCircuitBreaker();
export default symbolCircuitBreaker;
