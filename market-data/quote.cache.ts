import { prisma }           from "../shared/db.js";
import { eventBus }         from "../events-bus/event.bus.js";
import type { Quote }        from "../shared/contracts.js";
import { STALE_THRESHOLD_MS } from "../liquidity-engine/internal.liquidity.core.js";

/**
 * In-process quote cache.
 * Single source of truth for the latest bid/ask/mid for every symbol.
 *
 * On every update it:
 *  1. Stores the quote in memory (O(1) lookup for OrderController)
 *  2. Persists to BrokerSetting for durability across restarts
 *  3. Broadcasts a market.quote event to frontend subscribers — real-time
 *     mark-to-market/SL-TP/stop-out all react to that event
 *     (trading-service/position.price.monitor.ts), not to this module
 *     directly. FASE 2.5: this used to also call liquidationEngine on every
 *     tick, redundantly re-doing the same DB-backed SL/TP/stop-out check
 *     position.price.monitor.ts already does in-memory — removed;
 *     LiquidationEngine is now a periodic watchdog (risk-service/
 *     liquidation.engine.ts), not a second per-tick execution engine.
 */

const _quotes = new Map<string, Quote>();

/**
 * CRITICAL_REMEDIATION Phase 1 (C8): set() used to call _persist() on
 * EVERY tick, from every replica independently, with no debounce -- live-
 * measured (CRITICAL_REMEDIATION_REPORT.md, finding C8) at ~93 writes/sec
 * against a BrokerSetting table holding 4 live rows, ~18M cumulative
 * updates, individual upserts observed taking up to 7.7s, and Postgres
 * connection-pool exhaustion severe enough to make ordinary API requests
 * (registration, deposits) fail outright even with a single test user and
 * no load-test traffic running. This is the persisted-for-restart-warmup
 * path only (see warmUp()) -- it does not need tick-level freshness, only
 * approximate freshness after a restart. Debouncing to once per symbol per
 * PERSIST_DEBOUNCE_MS cuts write volume by roughly two orders of magnitude
 * at typical multi-Hz tick rates, with no change to in-memory read/write
 * behavior (the in-memory Map, which is what the entire hot path actually
 * reads, is still updated on every single tick, unthrottled).
 */
const PERSIST_DEBOUNCE_MS = 10_000;
const _lastPersistedAt = new Map<string, number>();

export const quoteCache = {
  set(quote: Quote): void {
    const sym = quote.symbol.toUpperCase();
    _quotes.set(sym, { ...quote, symbol: sym });

    // Fire-and-forget, debounced — do not block the quote ingestion path,
    // and do not persist more often than PERSIST_DEBOUNCE_MS per symbol.
    const now = Date.now();
    const lastPersisted = _lastPersistedAt.get(sym) ?? 0;
    if (now - lastPersisted >= PERSIST_DEBOUNCE_MS) {
      _lastPersistedAt.set(sym, now);
      void _persist(sym, quote);
    }

    eventBus.emit("market.quote", {
      symbol:    sym,
      bid:       quote.bid,
      ask:       quote.ask,
      mid:       quote.mid,
      spread:    quote.spread,
      changePct: quote.changePct,
      timestamp: quote.ts ?? new Date().toISOString(),
    });
  },

  get(symbol: string): Quote | undefined {
    return _quotes.get(symbol.toUpperCase());
  },

  /**
   * Returns true if the quote for this symbol is absent or older than
   * STALE_THRESHOLD_MS.  order.controller uses this to reject orders
   * when TwelveData has not sent a fresh tick recently.
   */
  isStale(symbol: string): boolean {
    const q = _quotes.get(symbol.toUpperCase());
    if (!q?.ts) return true;
    return (Date.now() - new Date(q.ts).getTime()) > STALE_THRESHOLD_MS;
  },

  getAll(): Quote[] {
    return Array.from(_quotes.values());
  },

  /** Warm the cache from DB on startup (before the live feed connects). */
  async warmUp(): Promise<void> {
    try {
      const rows = await prisma.brokerSetting.findMany({
        where: { key: { startsWith: "quote:" } },
      });
      for (const row of rows) {
        const q = row.value as Quote;
        if (q?.symbol) _quotes.set(q.symbol.toUpperCase(), q);
      }
      console.log(`[quote-cache] Warmed ${rows.length} quotes from DB`);
    } catch {
      // DB unavailable — quotes will populate from live feed
    }
  },
};

async function _persist(symbol: string, quote: Quote): Promise<void> {
  try {
    await prisma.brokerSetting.upsert({
      where:  { key: `quote:${symbol}` },
      create: { key: `quote:${symbol}`, value: quote as object },
      update: { value: quote as object },
    });
  } catch (err) {
    // Non-fatal — in-memory cache is authoritative, this is only the
    // restart-warmup snapshot. CRITICAL_REMEDIATION (C8): previously a
    // silent empty catch, which meant a persistently-failing write path
    // (e.g. the exact connection-pool exhaustion this same finding caused)
    // had zero observability. Now debounced to at most one attempt per
    // symbol per PERSIST_DEBOUNCE_MS, so this can no longer itself spam.
    console.warn(`[quote-cache] persist failed for ${symbol}:`, (err as Error).message);
  }
}
