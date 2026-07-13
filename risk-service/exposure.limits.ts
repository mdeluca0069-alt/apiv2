/**
 * ExposureRegistry — real-time global exposure tracking per instrument.
 *
 * For a B-book broker, unhedged exposure is the primary risk.
 * This registry tracks:
 *   - grossExposure: total notional across ALL open positions for a symbol
 *   - netExposure:   (longNotional - shortNotional) — the broker's net book position
 *
 * Hard limits (configurable) cap total gross exposure per instrument.
 * When a limit is reached, new orders are rejected with INSTRUMENT_HALTED.
 *
 * Architecture:
 *   - In-memory map, updated synchronously on every order fill and position close.
 *   - Loaded from DB at startup (sum of all OPEN positions).
 *   - No DB writes — this is a runtime cache, not audit data.
 *   - Thread-safe for Node.js single-threaded execution model.
 *
 * Event hooks:
 *   - openPosition(symbol, side, quantity, price)  — called by ExecutionEngine after fill
 *   - closePosition(symbol, side, quantity, price) — called by SettlementEngine after close
 */

import type { Prisma } from "@prisma/client";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

/** See order.lifecycle.ts — same composability contract. */
type Db = Prisma.TransactionClient | typeof prisma;

// ─── Configurable limits (USD notional) ──────────────────────────────────────
//
// These are conservative starting points for a retail CFD broker.
// GROSS limit = maximum total notional across all clients on one side combined.
// NET   limit = maximum directional imbalance the broker will carry unhedged.
//
// Set to Infinity to disable a limit — but never do this in production without
// a hedging counterparty in place.

export const EXPOSURE_LIMITS: Record<string, { grossUsd: number; netUsd: number }> = {
  EURUSD:  { grossUsd: 10_000_000,  netUsd: 2_000_000 },
  GBPUSD:  { grossUsd: 10_000_000,  netUsd: 2_000_000 },
  USDJPY:  { grossUsd: 10_000_000,  netUsd: 2_000_000 },
  EURGBP:  { grossUsd:  5_000_000,  netUsd: 1_000_000 },
  AUDUSD:  { grossUsd:  5_000_000,  netUsd: 1_000_000 },
  XAUUSD:  { grossUsd:  5_000_000,  netUsd: 1_000_000 },
  US500:   { grossUsd:  8_000_000,  netUsd: 2_000_000 },
  US100:   { grossUsd:  8_000_000,  netUsd: 2_000_000 },
  DE40:    { grossUsd:  5_000_000,  netUsd: 1_000_000 },
  UK100:   { grossUsd:  5_000_000,  netUsd: 1_000_000 },
  WTI:     { grossUsd:  3_000_000,  netUsd:   500_000 },
  BRENT:   { grossUsd:  3_000_000,  netUsd:   500_000 },
  BTCUSD:  { grossUsd:  2_000_000,  netUsd:   500_000 },
  ETHUSD:  { grossUsd:  2_000_000,  netUsd:   500_000 },
  AAPL:    { grossUsd:  3_000_000,  netUsd:   750_000 },
  MSFT:    { grossUsd:  3_000_000,  netUsd:   750_000 },
  NVDA:    { grossUsd:  2_000_000,  netUsd:   500_000 },
  TSLA:    { grossUsd:  2_000_000,  netUsd:   500_000 },
  AMZN:    { grossUsd:  2_000_000,  netUsd:   500_000 },
};

// Default limits for unlisted instruments
const DEFAULT_LIMIT = { grossUsd: 1_000_000, netUsd: 250_000 };

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExposureEntry = {
  longNotional:  number;   // Σ(quantity × price) for all OPEN BUY positions
  shortNotional: number;   // Σ(quantity × price) for all OPEN SELL positions
};

export type ExposureSnapshot = ExposureEntry & {
  symbol:        string;
  grossNotional: number;   // longNotional + shortNotional
  netNotional:   number;   // |longNotional - shortNotional|  (signed: positive = long bias)
  offsetNotional: number;  // FASE 3.8 (Group D): 2 × min(longNotional, shortNotional) —
                            // the notional that opposing client positions already cancel
                            // out internally, and so never needs external hedging at all.
                            // grossNotional === offsetNotional + |netNotional| always holds.
  limitGross:    number;
  limitNet:      number;
  grossPct:      number;   // grossNotional / limitGross × 100
  netPct:        number;   // |netNotional| / limitNet × 100
};

export type ExposureCheckResult =
  | { ok: true }
  | { ok: false; reason: "INSTRUMENT_HALTED"; detail: string };

// ─── Registry ────────────────────────────────────────────────────────────────

export class ExposureRegistry {
  private readonly state = new Map<string, ExposureEntry>();

  /**
   * Load current exposure from all OPEN positions in the DB.
   * Must be called at startup after quoteCache.warmUp().
   */
  async load(): Promise<void> {
    if (!IS_PERSISTENT) {
      console.log("[exposure-registry] running with empty state (no DB)");
      return;
    }

    try {
      const db        = prisma as NonNullable<typeof prisma>;
      const positions = await db.position.findMany({
        where:  { status: "OPEN" },
        select: { symbol: true, side: true, quantity: true, entryPrice: true },
      });

      for (const pos of positions) {
        const notional = pos.quantity.toNumber() * pos.entryPrice.toNumber();
        this._add(pos.symbol, pos.side as "BUY" | "SELL", notional);
      }

      console.log(
        `[exposure-registry] loaded exposure from ${positions.length} open positions ` +
        `(${this.state.size} instruments)`
      );
    } catch (err) {
      console.warn("[exposure-registry] load failed — starting empty:", (err as Error).message);
    }
  }

  /**
   * Pre-trade check: will the new position breach gross or net limits?
   * Called by RiskEngine.preTradeCheck() before order execution.
   */
  checkCanOpen(
    symbol:   string,
    side:     "BUY" | "SELL",
    notional: number,
  ): ExposureCheckResult {
    const key    = symbol.toUpperCase();
    const limits = EXPOSURE_LIMITS[key] ?? DEFAULT_LIMIT;
    const entry  = this.state.get(key) ?? { longNotional: 0, shortNotional: 0 };

    const newLong  = entry.longNotional  + (side === "BUY"  ? notional : 0);
    const newShort = entry.shortNotional + (side === "SELL" ? notional : 0);
    const newGross = newLong + newShort;
    const newNet   = Math.abs(newLong - newShort);

    if (newGross > limits.grossUsd) {
      return {
        ok:     false,
        reason: "INSTRUMENT_HALTED",
        detail: `${key} gross exposure would be ${newGross.toFixed(0)} USD (limit: ${limits.grossUsd.toFixed(0)} USD)`,
      };
    }

    if (newNet > limits.netUsd) {
      return {
        ok:     false,
        reason: "INSTRUMENT_HALTED",
        detail: `${key} net exposure would be ${newNet.toFixed(0)} USD (limit: ${limits.netUsd.toFixed(0)} USD)`,
      };
    }

    return { ok: true };
  }

  /**
   * FASE 2.3 — atomic, cluster-wide exposure check.
   *
   * checkCanOpen() above is a fast, non-authoritative pre-trade read of the
   * in-process Map — still used by RiskEngine.preTradeCheck() to reject
   * obviously-over-limit orders early, before any DB work happens. But that
   * Map is per-worker: in a multi-worker cluster it is never synchronized
   * across processes, so its numbers can diverge from the real cluster-wide
   * total (up to ~N× under-enforcement with N workers — see
   * SYSTEM_ARCHITECTURE_FREEZE.md). It is not, and must never become, a
   * second source of truth: `Position` rows are the only authority.
   *
   * This method is the authoritative gate. It must be called inside the same
   * DB transaction that will create the position, so the check and the write
   * it gates are atomic together:
   *   1. Acquires a Postgres advisory lock scoped to `symbol`
   *      (pg_advisory_xact_lock — auto-released at transaction end, no
   *      manual unlock). This serializes concurrent opens on the same
   *      instrument across every worker in the cluster, not just this
   *      process — two different workers can no longer both read a
   *      still-under-limit exposure and both proceed to breach it.
   *   2. Computes gross/net exposure LIVE from `Position` (status=OPEN)
   *      under that lock, never from the in-process cache.
   */
  async checkCanOpenAtomic(
    tx:       Db,
    symbol:   string,
    side:     "BUY" | "SELL",
    notional: number,
  ): Promise<ExposureCheckResult> {
    const key = symbol.toUpperCase();

    // FASE 2.3 perf: lock acquisition and the exposure read are one round
    // trip via a CTE, instead of two separate statements — this lock is held
    // until the caller's transaction commits (that's what makes it correct —
    // see the doc comment above), so every order for this symbol queued
    // behind it pays for each round trip done while holding it. `lock_acquired`
    // always has exactly one row (a bodyless SELECT), so the CROSS JOIN can't
    // drop any Position rows; pg_advisory_xact_lock() is VOLATILE, so Postgres
    // cannot skip or reorder its evaluation out of the query.
    const rows = await tx.$queryRaw<Array<{ side: string; notional: string | null }>>`
      WITH lock_acquired AS (SELECT pg_advisory_xact_lock(hashtext(${key})))
      SELECT p.side, SUM(p.quantity * p."entryPrice") AS notional
      FROM "Position" p, lock_acquired
      WHERE p.symbol = ${key} AND p.status = 'OPEN'
      GROUP BY p.side
    `;

    let longNotional  = 0;
    let shortNotional = 0;
    for (const row of rows) {
      const n = row.notional ? parseFloat(row.notional) : 0;
      if (row.side === "BUY") longNotional = n;
      else if (row.side === "SELL") shortNotional = n;
    }

    const limits   = EXPOSURE_LIMITS[key] ?? DEFAULT_LIMIT;
    const newLong  = longNotional  + (side === "BUY"  ? notional : 0);
    const newShort = shortNotional + (side === "SELL" ? notional : 0);
    const newGross = newLong + newShort;
    const newNet   = Math.abs(newLong - newShort);

    if (newGross > limits.grossUsd) {
      return {
        ok:     false,
        reason: "INSTRUMENT_HALTED",
        detail: `${key} gross exposure would be ${newGross.toFixed(0)} USD (limit: ${limits.grossUsd.toFixed(0)} USD)`,
      };
    }
    if (newNet > limits.netUsd) {
      return {
        ok:     false,
        reason: "INSTRUMENT_HALTED",
        detail: `${key} net exposure would be ${newNet.toFixed(0)} USD (limit: ${limits.netUsd.toFixed(0)} USD)`,
      };
    }
    return { ok: true };
  }

  /**
   * Called synchronously after a position fill.
   * ExecutionEngine calls this after creating the position row.
   */
  openPosition(symbol: string, side: "BUY" | "SELL", notional: number): void {
    this._add(symbol.toUpperCase(), side, notional);
  }

  /**
   * Called synchronously after a position closes.
   * SettlementEngine calls this after the Serializable transaction commits.
   */
  closePosition(symbol: string, side: "BUY" | "SELL", notional: number): void {
    this._sub(symbol.toUpperCase(), side, notional);
  }

  /**
   * Returns a snapshot of current exposure for all tracked instruments.
   * Used by admin dashboard and reconciliation.
   */
  getAll(): ExposureSnapshot[] {
    const result: ExposureSnapshot[] = [];

    for (const [symbol, entry] of this.state) {
      const limits      = EXPOSURE_LIMITS[symbol] ?? DEFAULT_LIMIT;
      const gross       = entry.longNotional + entry.shortNotional;
      const net         = entry.longNotional - entry.shortNotional; // signed
      const offset      = 2 * Math.min(entry.longNotional, entry.shortNotional);

      result.push({
        symbol,
        longNotional:  entry.longNotional,
        shortNotional: entry.shortNotional,
        grossNotional: gross,
        netNotional:   net,
        offsetNotional: offset,
        limitGross:    limits.grossUsd,
        limitNet:      limits.netUsd,
        grossPct:      limits.grossUsd > 0 ? (gross / limits.grossUsd) * 100 : 0,
        netPct:        limits.netUsd   > 0 ? (Math.abs(net) / limits.netUsd) * 100 : 0,
      });
    }

    return result.sort((a, b) => b.grossPct - a.grossPct);
  }

  get(symbol: string): ExposureSnapshot | null {
    const key   = symbol.toUpperCase();
    const entry = this.state.get(key);
    if (!entry) return null;

    const limits = EXPOSURE_LIMITS[key] ?? DEFAULT_LIMIT;
    const gross  = entry.longNotional + entry.shortNotional;
    const net    = entry.longNotional - entry.shortNotional;
    const offset = 2 * Math.min(entry.longNotional, entry.shortNotional);

    return {
      symbol:        key,
      longNotional:  entry.longNotional,
      shortNotional: entry.shortNotional,
      grossNotional: gross,
      netNotional:   net,
      offsetNotional: offset,
      limitGross:    limits.grossUsd,
      limitNet:      limits.netUsd,
      grossPct:      limits.grossUsd > 0 ? (gross / limits.grossUsd) * 100 : 0,
      netPct:        limits.netUsd   > 0 ? (Math.abs(net) / limits.netUsd) * 100 : 0,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _add(symbol: string, side: "BUY" | "SELL", notional: number): void {
    const existing = this.state.get(symbol) ?? { longNotional: 0, shortNotional: 0 };
    if (side === "BUY") {
      this.state.set(symbol, { ...existing, longNotional: existing.longNotional + notional });
    } else {
      this.state.set(symbol, { ...existing, shortNotional: existing.shortNotional + notional });
    }
  }

  private _sub(symbol: string, side: "BUY" | "SELL", notional: number): void {
    const existing = this.state.get(symbol);
    if (!existing) return;

    if (side === "BUY") {
      const updated = { ...existing, longNotional: Math.max(0, existing.longNotional - notional) };
      this.state.set(symbol, updated);
    } else {
      const updated = { ...existing, shortNotional: Math.max(0, existing.shortNotional - notional) };
      this.state.set(symbol, updated);
    }
  }
}

export const exposureRegistry = new ExposureRegistry();
