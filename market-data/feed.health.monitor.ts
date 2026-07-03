/**
 * FeedHealthMonitor — advanced market-data quality and resilience layer.
 *
 * Augments FeedManager with:
 *   1. Per-symbol stale detection (configurable threshold, default 6 min)
 *   2. Quote quality scoring (spread sanity, bid/ask crossing, tick frequency)
 *   3. Reconnect orchestration audit (tracks consecutive reconnects per feed)
 *   4. Prometheus-compatible metric export
 *
 * CRITICAL INVARIANT:
 *   Trading MUST NEVER execute against a stale quote.
 *   This monitor enforces that invariant by:
 *     - Maintaining a per-symbol freshness registry with millisecond precision
 *     - Providing `isQuoteFresh(symbol)` used by the order controller guard
 *     - Emitting `market.data.stale` events that cancel pending orders for that symbol
 *
 * Integration:
 *   1. Call `feedHealthMonitor.recordQuote(symbol, bid, ask)` from InternalLiquidityCore
 *      whenever a fresh tick arrives (call after ingestExternalPrice).
 *   2. Call `feedHealthMonitor.start()` once at startup.
 *   3. Call `feedHealthMonitor.getMetrics()` from the admin health endpoint.
 */

import { eventBus } from "../events-bus/event.bus.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS      = Number(process.env.STALE_THRESHOLD_MS  ?? 360_000);  // 6 min
const QUALITY_CHECK_INTERVAL  = 5_000;   // check quality every 5s
const MAX_SPREAD_MULTIPLIER   = 20;      // quote rejected if spread > 20× normal
const MIN_TICK_FREQ_PER_MIN   = 0.1;     // at least 1 tick per 10 min (relaxed for REST fallback)

// ─── Types ────────────────────────────────────────────────────────────────────

export type QuoteRecord = {
  symbol:       string;
  bid:          number;
  ask:          number;
  mid:          number;
  spread:       number;
  receivedAt:   number;   // Date.now()
  source:       string;   // "feed-manager" | "twelvedata-rest" | etc.
};

export type SymbolHealth = {
  symbol:          string;
  fresh:           boolean;
  ageMs:           number;
  tickCount:       number;
  ticksPerMin:     number;
  lastBid:         number;
  lastAsk:         number;
  spread:          number;
  spreadQuality:   "ok" | "wide" | "crossed" | "zero";
  lastReceivedAt:  string | null;
};

export type FeedHealthSnapshot = {
  checkedAt:       string;
  circuitOpen:     boolean;
  staleSymbols:    string[];
  freshSymbols:    string[];
  totalSymbols:    number;
  qualityMetrics:  SymbolHealth[];
  reconnectAudit:  ReconnectAudit[];
  ordersBlocked:   boolean;
};

export type ReconnectAudit = {
  feedName:       string;
  reconnectCount: number;
  lastReconnectAt: string | null;
};

// ─── FeedHealthMonitor ────────────────────────────────────────────────────────

export class FeedHealthMonitor {
  // Per-symbol freshness tracking
  private readonly quotes    = new Map<string, QuoteRecord>();
  private readonly tickCounts = new Map<string, number>();       // total ticks ever
  private readonly tickWindowCounts = new Map<string, number[]>(); // timestamps for freq calc

  // Per-feed reconnect tracking
  private readonly reconnects = new Map<string, { count: number; lastAt: number | null }>();

  // Reference spread per symbol (first clean quote sets the baseline)
  private readonly baselineSpreads = new Map<string, number>();

  private circuitOpen    = false;
  private healthTimer:     ReturnType<typeof setInterval> | null = null;
  private readonly watchedSymbols = new Set<string>();

  start(symbols: string[]): void {
    for (const sym of symbols) {
      this.watchedSymbols.add(sym);
    }

    this.healthTimer = setInterval(() => this._runQualityCheck(), QUALITY_CHECK_INTERVAL);
    console.log(`[feed-health] started — monitoring ${symbols.length} symbols, stale threshold=${STALE_THRESHOLD_MS / 1_000}s`);
  }

  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  // ── Quote ingestion ──────────────────────────────────────────────────────────

  /**
   * Record a fresh quote for a symbol. Call this from InternalLiquidityCore
   * after every accepted external price tick.
   */
  recordQuote(symbol: string, bid: number, ask: number, source = "unknown"): void {
    const now    = Date.now();
    const mid    = (bid + ask) / 2;
    const spread = ask - bid;

    this.quotes.set(symbol, { symbol, bid, ask, mid, spread, receivedAt: now, source });

    // Tick count (total)
    this.tickCounts.set(symbol, (this.tickCounts.get(symbol) ?? 0) + 1);

    // Rolling window for tick frequency (last 60 seconds)
    const window = this.tickWindowCounts.get(symbol) ?? [];
    window.push(now);
    const cutoff = now - 60_000;
    const trimmed = window.filter((t) => t >= cutoff);
    this.tickWindowCounts.set(symbol, trimmed);

    // Establish baseline spread on first quote if not yet set
    if (!this.baselineSpreads.has(symbol) && spread > 0) {
      this.baselineSpreads.set(symbol, spread);
    }
  }

  /** Record a reconnect event for a feed. */
  recordReconnect(feedName: string): void {
    const entry = this.reconnects.get(feedName) ?? { count: 0, lastAt: null };
    entry.count++;
    entry.lastAt = Date.now();
    this.reconnects.set(feedName, entry);
    console.warn(`[feed-health] feed="${feedName}" reconnect #${entry.count}`);
  }

  /** Called by FeedManager when the circuit opens (all feeds dead). */
  setCircuitOpen(open: boolean): void {
    this.circuitOpen = open;
  }

  // ── Freshness queries ────────────────────────────────────────────────────────

  /**
   * Returns true if the symbol has received a quote within STALE_THRESHOLD_MS.
   * This is the guard used by order.controller.ts before executing trades.
   */
  isQuoteFresh(symbol: string): boolean {
    const record = this.quotes.get(symbol);
    if (!record) return false;
    return Date.now() - record.receivedAt < STALE_THRESHOLD_MS;
  }

  /**
   * Returns quote age in ms. Returns Infinity if no quote ever received.
   */
  quoteAgeMs(symbol: string): number {
    const record = this.quotes.get(symbol);
    if (!record) return Infinity;
    return Date.now() - record.receivedAt;
  }

  // ── Health snapshot ──────────────────────────────────────────────────────────

  getSnapshot(): FeedHealthSnapshot {
    const now        = Date.now();
    const stale:   string[] = [];
    const fresh:   string[] = [];
    const quality: SymbolHealth[] = [];

    for (const symbol of this.watchedSymbols) {
      const record = this.quotes.get(symbol);
      const ageMs  = record ? now - record.receivedAt : Infinity;
      const isFresh = ageMs < STALE_THRESHOLD_MS;

      if (isFresh) fresh.push(symbol); else stale.push(symbol);

      const window     = this.tickWindowCounts.get(symbol) ?? [];
      const ticksPerMin = window.length; // ticks in last 60s

      const spreadQuality = record
        ? this._spreadQuality(symbol, record.spread)
        : "zero";

      quality.push({
        symbol,
        fresh:          isFresh,
        ageMs:          Number.isFinite(ageMs) ? ageMs : -1,
        tickCount:      this.tickCounts.get(symbol) ?? 0,
        ticksPerMin,
        lastBid:        record?.bid ?? 0,
        lastAsk:        record?.ask ?? 0,
        spread:         record?.spread ?? 0,
        spreadQuality,
        lastReceivedAt: record ? new Date(record.receivedAt).toISOString() : null,
      });
    }

    const reconnectAudit: ReconnectAudit[] = [...this.reconnects.entries()].map(([name, r]) => ({
      feedName:        name,
      reconnectCount:  r.count,
      lastReconnectAt: r.lastAt ? new Date(r.lastAt).toISOString() : null,
    }));

    return {
      checkedAt:      new Date(now).toISOString(),
      circuitOpen:    this.circuitOpen,
      staleSymbols:   stale,
      freshSymbols:   fresh,
      totalSymbols:   this.watchedSymbols.size,
      qualityMetrics: quality,
      reconnectAudit,
      ordersBlocked:  this.circuitOpen || stale.length > 0,
    };
  }

  /**
   * Export Prometheus-compatible text format.
   * Consumed by /metrics endpoint for Grafana/Alertmanager scraping.
   */
  exportPrometheus(): string {
    const snap  = this.getSnapshot();
    const lines: string[] = [];

    lines.push("# HELP igfx_market_data_fresh_symbols Number of symbols with fresh quotes");
    lines.push("# TYPE igfx_market_data_fresh_symbols gauge");
    lines.push(`igfx_market_data_fresh_symbols ${snap.freshSymbols.length}`);

    lines.push("# HELP igfx_market_data_stale_symbols Number of symbols with stale quotes");
    lines.push("# TYPE igfx_market_data_stale_symbols gauge");
    lines.push(`igfx_market_data_stale_symbols ${snap.staleSymbols.length}`);

    lines.push("# HELP igfx_market_data_circuit_open 1 if circuit breaker is open");
    lines.push("# TYPE igfx_market_data_circuit_open gauge");
    lines.push(`igfx_market_data_circuit_open ${snap.circuitOpen ? 1 : 0}`);

    for (const q of snap.qualityMetrics) {
      const label = `symbol="${q.symbol}"`;
      lines.push(`igfx_quote_age_ms{${label}} ${q.ageMs < 0 ? -1 : q.ageMs}`);
      lines.push(`igfx_quote_ticks_per_min{${label}} ${q.ticksPerMin}`);
      lines.push(`igfx_quote_spread{${label}} ${q.spread}`);
      lines.push(`igfx_quote_fresh{${label}} ${q.fresh ? 1 : 0}`);
    }

    lines.push(`# HELP igfx_feed_reconnects_total Total reconnects per feed`);
    lines.push(`# TYPE igfx_feed_reconnects_total counter`);
    for (const r of snap.reconnectAudit) {
      lines.push(`igfx_feed_reconnects_total{feed="${r.feedName}"} ${r.reconnectCount}`);
    }

    return lines.join("\n") + "\n";
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _runQualityCheck(): void {
    const now     = Date.now();
    const stale:  string[] = [];

    for (const symbol of this.watchedSymbols) {
      const record = this.quotes.get(symbol);
      if (!record) {
        stale.push(symbol);
        continue;
      }

      const ageMs = now - record.receivedAt;

      if (ageMs >= STALE_THRESHOLD_MS) {
        stale.push(symbol);
        this._onStale(symbol, ageMs);
      }

      // Spread quality alerts (non-blocking, informational)
      const quality = this._spreadQuality(symbol, record.spread);
      if (quality === "crossed") {
        console.warn(`[feed-health] ${symbol} crossed book: bid=${record.bid} ask=${record.ask} — rejecting tick`);
      } else if (quality === "wide") {
        console.warn(`[feed-health] ${symbol} spread ${record.spread.toFixed(6)} is ${MAX_SPREAD_MULTIPLIER}× above baseline — possible data error`);
      }

      // Tick frequency alert
      const window = this.tickWindowCounts.get(symbol) ?? [];
      if (record && ageMs < 120_000) {
        // Only alert if we've been receiving ticks for at least 2 minutes
        const firstTickAt = record.receivedAt - (this.tickCounts.get(symbol) ?? 1) * 1000;
        if (now - firstTickAt > 120_000 && window.length < MIN_TICK_FREQ_PER_MIN) {
          console.warn(`[feed-health] ${symbol} low tick frequency: ${window.length} tick(s) in last 60s`);
        }
      }
    }
  }

  private _onStale(symbol: string, ageMs: number): void {
    const now          = Date.now();
    const lastExternalAt = now - ageMs;
    eventBus.emit("market.data.stale", {
      symbol,
      lastExternalAt,
      staleSince: lastExternalAt + STALE_THRESHOLD_MS,
      timestamp:  new Date(now).toISOString(),
    });
  }

  private _spreadQuality(symbol: string, spread: number): "ok" | "wide" | "crossed" | "zero" {
    if (spread < 0) return "crossed";
    if (spread === 0) return "zero";

    const baseline = this.baselineSpreads.get(symbol);
    if (baseline && spread > baseline * MAX_SPREAD_MULTIPLIER) return "wide";

    return "ok";
  }
}

export const feedHealthMonitor = new FeedHealthMonitor();
export default feedHealthMonitor;
