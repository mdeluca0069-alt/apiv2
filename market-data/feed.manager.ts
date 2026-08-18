/**
 * FeedManager — production-grade market data feed orchestrator.
 *
 * Architecture:
 *   PRIMARY   → TwelveData WebSocket (FX/metals/indices, real bid/ask, lowest latency)
 *   SECONDARY → Binance WebSocket (crypto — public market-data stream, no API key,
 *               no plan restrictions, genuinely free and unlimited for this use)
 *   TERTIARY  → TwelveData REST polling every REST_ROTATION_MS (batch rotation)
 *
 * Finnhub was tried as the secondary FX/commodities source but this account's
 * plan does not actually include real-time OANDA forex data (confirmed via a
 * direct REST call returning "You don't have access to this resource" for
 * forex symbols, despite the WS silently accepting the subscription) — so it
 * was dropped from the price-feed path. Crypto comes from Binance directly
 * instead of via Finnhub's Binance passthrough, for the same reason: a more
 * reliable, plan-restriction-free source.
 *
 * STAGING-ONLY Finnhub source (finnhub-ws / finnhub-rest, below): a
 * SEPARATE, opt-in adapter used only to demonstrate this engine works
 * end-to-end against a provider other than TwelveData, scoped to the 5 US
 * equities Finnhub Free reliably streams (AAPL, MSFT, NVDA, TSLA, AMZN) —
 * NOT a replacement for the PRIMARY/SECONDARY/TERTIARY lineup above, and
 * inert unless MARKET_DATA_STAGING_PROVIDER=finnhub (main.ts). Gated behind
 * its own FeedLeaderElection instance (jobId "market-data-finnhub",
 * separate from TwelveData's lease) for the same reason TwelveData is
 * leader-gated: avoid N replicas opening N redundant connections against
 * one API key. See FINNHUB_STAGING_IMPLEMENTATION_REPORT.md.
 *
 * Each feed independently calls `ingestExternalPrice()` on the liquidity core
 * so any live source keeps quotes fresh (STALE_THRESHOLD_MS resets on each tick).
 *
 * Failover rules:
 *   If PRIMARY fails:  Binance-WS (crypto only) + TwelveData-REST continue independently.
 *   If ALL fail simultaneously for CIRCUIT_BREAK_MS:
 *     - Set `circuitOpen = true`
 *     - New order placements are blocked at the order controller level
 *     - Monitoring of existing positions continues via last known prices
 *     - CRITICAL alert emitted to event bus
 *     - Circuit resets automatically when any feed recovers
 *
 * Feed health monitor:
 *   Polls `lastQuoteAt` per feed every HEALTH_CHECK_INTERVAL_MS.
 *   Exposes `getHealth()` for admin API.
 */

import { TwelveDataFeed }     from "./feeds/twelvedata.feed.js";
import { BinanceFeed }        from "./feeds/binance.feed.js";
import { fetchCurrentPrices } from "./feeds/twelvedata.rest.js";
import { eventBus }         from "../events-bus/event.bus.js";
import { feedCircuit }      from "../shared/feed.circuit.js";
import { immutableAudit }   from "../security/immutable.audit.js";
// STAGING-ONLY (see this file's header comment) — only ever instantiated
// when FeedManagerOptions.finnhub is set, which main.ts only does behind
// MARKET_DATA_STAGING_PROVIDER=finnhub.
import { FinnhubFeed }                                     from "./feeds/finnhub.feed.js";
import { fetchCurrentPrices as fetchFinnhubCurrentPrices } from "./feeds/finnhub.rest.js";

// ─── Config ───────────────────────────────────────────────────────────────────

// TwelveData free plan: 8 API credits/minute, ~800/day.
// REST is tertiary — WebSocket (8 symbols via TwelveData + crypto via Binance) covers real-time.
// Rotate batches every 5 min: 4 batches × 5 min = 20-min full cycle → ~288 calls/day (within 800/day limit).
const REST_BATCH_SIZE          = 5;         // symbols per REST /price call
const REST_ROTATION_MS         = 300_000;   // rotate to next batch every 5 min (was 15s — exhausted 800/day quota in ~3h)
const HEALTH_CHECK_INTERVAL_MS = 5_000;     // How often to evaluate feed health
const CIRCUIT_BREAK_MS         = 120_000;   // Time with ALL feeds dead → open circuit (2 min, up from 1 min)
const FEED_DEAD_THRESHOLD_MS   = 60_000;    // A feed is "dead" if no quotes for this long (up from 30s)

// STAGING ONLY — Finnhub Free has no batch /quote endpoint (one HTTP call
// per symbol, see finnhub.rest.ts), so its tertiary poll interval is its
// own separate constant, deliberately conservative: 5 symbols × one poll
// every 60s is nowhere near the free-tier per-minute cap, and this feed's
// role is fallback only — real-time coverage already comes from finnhub-ws.
const FINNHUB_REST_ROTATION_MS = 60_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type FeedName = "twelvedata-ws" | "binance-ws" | "twelvedata-rest" | "finnhub-ws" | "finnhub-rest";

export type FeedHealth = {
  name:        FeedName;
  status:      "healthy" | "degraded" | "dead";
  lastQuoteAt: string | null;
  quoteCount:  number;
  errorCount:  number;
};

export type FeedManagerHealth = {
  circuitOpen:   boolean;
  activeFeed:    FeedName | "none";
  feeds:         FeedHealth[];
  symbolsLive:   number;
  allDeadSince:  string | null;
  checkedAt:     string;
};

export type FeedManagerOptions = {
  apiKey:        string;
  symbols:       string[];
  wsSymbols:     string[];   // subset for TwelveData WS (free plan limit = 8)
  /**
   * Routes each external price into InternalLiquidityCore.
   * This is the single canonical write path for quoteCache.
   * `source` (MARKET_DATA_FREEZE.md §0.6) identifies which feed produced
   * this tick, so a lower-priority source can't overwrite a higher-
   * priority one's more recent data purely by arriving later at the server.
   */
  ingestPrice: (symbol: string, mid: number, bid?: number, ask?: number, source?: FeedName) => void;
  /**
   * STAGING ONLY. When set, enables the Finnhub Free adapter (finnhub-ws +
   * finnhub-rest) as an additional, leader-gated source — see this file's
   * header comment. `undefined` (the default) leaves FeedManager's
   * behavior byte-identical to before this option existed: no Finnhub
   * class is ever constructed, no timer is ever started. main.ts only
   * supplies this when MARKET_DATA_STAGING_PROVIDER=finnhub AND
   * FINNHUB_API_KEY are both set.
   */
  finnhub?: {
    apiKey:     string;
    wsSymbols:  string[];
    restSymbols: string[];
  };
};

// ─── Per-feed stats ───────────────────────────────────────────────────────────

class FeedStats {
  lastQuoteAt: number | null = null;
  quoteCount   = 0;
  errorCount   = 0;

  record(): void { this.lastQuoteAt = Date.now(); this.quoteCount++; }
  error():  void { this.errorCount++; }

  status(now: number): "healthy" | "degraded" | "dead" {
    if (!this.lastQuoteAt) return "dead";
    const age = now - this.lastQuoteAt;
    if (age < FEED_DEAD_THRESHOLD_MS / 2) return "healthy";
    if (age < FEED_DEAD_THRESHOLD_MS)    return "degraded";
    return "dead";
  }
}

// ─── FeedManager ─────────────────────────────────────────────────────────────

export class FeedManager {
  private readonly stats: Record<FeedName, FeedStats> = {
    "twelvedata-ws":   new FeedStats(),
    "binance-ws":      new FeedStats(),
    "twelvedata-rest": new FeedStats(),
    "finnhub-ws":      new FeedStats(),
    "finnhub-rest":    new FeedStats(),
  };

  private wsFeed:        TwelveDataFeed | null = null;
  private binanceFeed:   BinanceFeed | null = null;
  private restTimer:     NodeJS.Timeout | null = null;
  private healthTimer:   NodeJS.Timeout | null = null;
  private restBatchIdx   = 0;  // rotating batch pointer

  // STAGING ONLY — see FeedManagerOptions.finnhub's own docstring.
  private finnhubFeed:      FinnhubFeed | null = null;
  private finnhubRestTimer: NodeJS.Timeout | null = null;

  private circuitOpen     = false;
  private allDeadSince: number | null = null;
  private running         = false;
  private primaryRunning  = false;
  private finnhubRunning  = false;

  constructor(private readonly opts: FeedManagerOptions) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Starts the SECONDARY feed (Binance-WS, crypto — free, unauthenticated,
   * no per-key plan limit, safe for every replica to run independently)
   * plus the health monitor. Does NOT start the PRIMARY feed (TwelveData
   * WS+REST) — call `startPrimary()` for that, and only after winning
   * TwelveData feed leadership (market-data/feed.leader.election.ts).
   *
   * MULTI-REPLICA TWELVEDATA REMEDIATION: this used to also start the
   * TwelveData WS+REST feeds unconditionally here, on every replica. With
   * N replicas all authenticating to TwelveData with the same API key,
   * their combined connect/subscribe/reconnect traffic exceeded
   * TwelveData's free-plan per-key rate limit — confirmed live (Hostinger
   * staging, 2026-08-17): TwelveData rejected the WS connections outright
   * ("exceeds the limit of 100 events per minute"), and this app's own
   * reconnect logic generated more of exactly the traffic being rejected,
   * so the storm never settled on any replica. See
   * feed.leader.election.ts's own docstring for the full fix.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this._startBinanceFeed();
    this._startHealthMonitor();

    console.log("[feed-manager] started — secondary=Binance-WS (primary=TwelveData-WS/REST gated by feed leadership)");
  }

  /**
   * Starts the PRIMARY feed (TwelveData WS + REST tertiary). Call only
   * when this replica currently holds TwelveData feed leadership. Safe to
   * call multiple times (idempotent — a no-op if already running).
   */
  startPrimary(): void {
    if (this.primaryRunning) return;
    this.primaryRunning = true;

    this._startWsFeed();
    this._startRestPolling();

    console.log("[feed-manager] primary (TwelveData WS+REST) started — this replica is feed leader");
  }

  /**
   * Stops the PRIMARY feed. Call the instant this replica loses TwelveData
   * feed leadership, so at most one replica ever holds an active
   * TwelveData connection — never zero for long (another replica's
   * `startPrimary()` fires around the same time via the same leadership
   * transition) and never two at once.
   */
  stopPrimary(): void {
    if (!this.primaryRunning) return;
    this.primaryRunning = false;

    this.wsFeed?.stop();
    this.wsFeed = null;
    if (this.restTimer) { clearInterval(this.restTimer); this.restTimer = null; }

    console.log("[feed-manager] primary (TwelveData WS+REST) stopped — this replica is no longer feed leader");
  }

  /** Whether this replica currently runs the primary (TwelveData) feed. */
  isPrimaryRunning(): boolean {
    return this.primaryRunning;
  }

  /**
   * STAGING ONLY. Starts the Finnhub WS + REST-tertiary adapter. Call only
   * when this replica currently holds Finnhub feed leadership (jobId
   * "market-data-finnhub", separate lease from TwelveData's — see
   * main.ts). No-op if `opts.finnhub` was never supplied (the default) —
   * mirrors startPrimary()'s idempotency/gating contract exactly.
   */
  startFinnhub(): void {
    if (!this.opts.finnhub) return;
    if (this.finnhubRunning) return;
    this.finnhubRunning = true;

    this._startFinnhubFeed();
    this._startFinnhubRestPolling();

    console.log("[feed-manager] Finnhub (STAGING) started — this replica is Finnhub feed leader");
  }

  /**
   * STAGING ONLY. Stops the Finnhub adapter. Call the instant this
   * replica loses Finnhub feed leadership — same invariant as
   * stopPrimary(): at most one replica ever holds an active Finnhub
   * connection at a time.
   */
  stopFinnhub(): void {
    if (!this.finnhubRunning) return;
    this.finnhubRunning = false;

    this.finnhubFeed?.stop();
    this.finnhubFeed = null;
    if (this.finnhubRestTimer) { clearInterval(this.finnhubRestTimer); this.finnhubRestTimer = null; }

    console.log("[feed-manager] Finnhub (STAGING) stopped — this replica is no longer Finnhub feed leader");
  }

  /** STAGING ONLY. Whether this replica currently runs the Finnhub adapter. */
  isFinnhubRunning(): boolean {
    return this.finnhubRunning;
  }

  stop(): void {
    this.running = false;
    this.stopPrimary();
    this.stopFinnhub();
    this.binanceFeed?.stop();
    if (this.healthTimer) clearInterval(this.healthTimer);
    console.log("[feed-manager] stopped");
  }

  // ── Public API ────────────────────────────────────────────────────────────

  isCircuitOpen(): boolean { return this.circuitOpen; }

  /** Force an immediate TwelveData REST fetch for every symbol (ignores rotation timer). */
  async forceRefreshAll(actor?: string): Promise<number> {
    if (!this.opts.apiKey) return 0;
    let refreshed = 0;
    const totalBatches = Math.ceil(this.opts.symbols.length / REST_BATCH_SIZE);
    for (let i = 0; i < totalBatches; i++) {
      const batch     = this.opts.symbols.slice(i * REST_BATCH_SIZE, (i + 1) * REST_BATCH_SIZE);
      const tdSymbols = batch.map((s) => this._toTdSymbol(s));
      try {
        const prices = await fetchCurrentPrices(this.opts.apiKey, tdSymbols);
        for (const [sym, price] of prices) {
          if (price > 0) {
            this.stats["twelvedata-rest"].record();
            this._closeCircuit("twelvedata-rest");
            this.opts.ingestPrice(sym, price, undefined, undefined, "twelvedata-rest");
            refreshed++;
          }
        }
      } catch { /* continue to next batch */ }
    }
    // PHASE2_REMEDIATION (H16, admin audit-log gap): admin-forced REST
    // refresh bypasses the normal rotation timer -- `actor` is only
    // supplied by the admin route (POST /admin/feed/refresh), so only that
    // manual override is written to the permanent audit trail.
    if (actor) {
      void immutableAudit.write({ actor, action: "feed.force_refresh", entity: "platform", payload: { refreshed } as object }).catch(() => {});
    }
    return refreshed;
  }

  getHealth(): FeedManagerHealth {
    const now    = Date.now();
    const feeds  = (["twelvedata-ws", "binance-ws", "twelvedata-rest", "finnhub-ws", "finnhub-rest"] as FeedName[]).map((name) => {
      const s = this.stats[name];
      return {
        name,
        status:      s.status(now),
        lastQuoteAt: s.lastQuoteAt ? new Date(s.lastQuoteAt).toISOString() : null,
        quoteCount:  s.quoteCount,
        errorCount:  s.errorCount,
      } satisfies FeedHealth;
    });

    const activeFeed = feeds.find((f) => f.status === "healthy")?.name ?? "none";

    return {
      circuitOpen:   this.circuitOpen,
      activeFeed,
      feeds,
      symbolsLive:   this.opts.symbols.length,
      allDeadSince:  this.allDeadSince ? new Date(this.allDeadSince).toISOString() : null,
      checkedAt:     new Date(now).toISOString(),
    };
  }

  // ── PRIMARY: TwelveData WebSocket ─────────────────────────────────────────

  private _startWsFeed(): void {
    if (!this.opts.apiKey) return;

    this.wsFeed = new TwelveDataFeed({
      apiKey:  this.opts.apiKey,
      symbols: this.opts.wsSymbols,
      onQuote: (q) => {
        this.stats["twelvedata-ws"].record();
        this._closeCircuit("twelvedata-ws");
        this.opts.ingestPrice(
          q.symbol, q.mid,
          q.isRealSpread ? q.bid  : undefined,
          q.isRealSpread ? q.ask  : undefined,
          "twelvedata-ws",
        );
      },
      onError: (err) => {
        this.stats["twelvedata-ws"].error();
        console.warn("[feed-manager] TwelveData-WS error:", err.message);
      },
      onReconnect: (attempt) => {
        console.warn(`[feed-manager] TwelveData-WS reconnect attempt #${attempt}`);
      },
    });

    this.wsFeed.start();
  }

  // ── SECONDARY: Binance WebSocket (crypto only — free, no API key, no plan limits) ──

  private _startBinanceFeed(): void {
    this.binanceFeed = new BinanceFeed({
      symbols: this.opts.symbols,
      onQuote: (q) => {
        this.stats["binance-ws"].record();
        this._closeCircuit("binance-ws");
        this.opts.ingestPrice(q.symbol, q.mid, q.bid, q.ask, "binance-ws");
      },
      onError: (err) => {
        this.stats["binance-ws"].error();
        console.warn("[feed-manager] Binance-WS error:", err.message);
      },
      onReconnect: (attempt) => {
        console.warn(`[feed-manager] Binance-WS reconnect attempt #${attempt}`);
      },
    });

    this.binanceFeed.start();
  }

  // ── TERTIARY: TwelveData REST polling ────────────────────────────────────

  private _startRestPolling(): void {
    if (!this.opts.apiKey) {
      console.warn("[feed-manager] TwelveData-REST disabled — no API key");
      return;
    }

    // Rotate batches: call immediately, then every REST_ROTATION_MS
    void this._pollRestBatch();
    this.restTimer = setInterval(() => void this._pollRestBatch(), REST_ROTATION_MS);
    console.log(`[feed-manager] TwelveData-REST batch rotation every ${REST_ROTATION_MS}ms (${REST_BATCH_SIZE} symbols/batch)`);
  }

  // ─── TwelveData REST symbol normalisation ─────────────────────────────────
  private _toTdSymbol(igfx: string): string {
    // 6-letter FX pairs: EURUSD → EUR/USD
    if (/^[A-Z]{6}$/.test(igfx)) return `${igfx.slice(0, 3)}/${igfx.slice(3)}`;
    // Commodity futures: WTI → WTI, BRENT → BRENT, keep as-is
    return igfx;
  }

  private async _pollRestBatch(): Promise<void> {
    if (!this.running) return;

    // Rotate through symbol batches
    const start   = this.restBatchIdx * REST_BATCH_SIZE;
    const batch   = this.opts.symbols.slice(start, start + REST_BATCH_SIZE);
    if (batch.length === 0) { this.restBatchIdx = 0; return; }

    this.restBatchIdx = (this.restBatchIdx + 1) % Math.ceil(this.opts.symbols.length / REST_BATCH_SIZE);

    const tdSymbols = batch.map((s) => this._toTdSymbol(s));

    try {
      const prices = await fetchCurrentPrices(this.opts.apiKey, tdSymbols);

      if (prices.size === 0) {
        this.stats["twelvedata-rest"].error();
        return;
      }

      for (const [sym, price] of prices) {
        if (price > 0) {
          this.stats["twelvedata-rest"].record();
          this._closeCircuit("twelvedata-rest");
          this.opts.ingestPrice(sym, price, undefined, undefined, "twelvedata-rest");
        }
      }
    } catch {
      this.stats["twelvedata-rest"].error();
    }
  }

  // ── STAGING ONLY: Finnhub WS + REST-tertiary (opt-in, leader-gated) ───────

  private _startFinnhubFeed(): void {
    const cfg = this.opts.finnhub;
    if (!cfg) return;

    this.finnhubFeed = new FinnhubFeed({
      apiKey:  cfg.apiKey,
      symbols: cfg.wsSymbols,
      onQuote: (q) => {
        this.stats["finnhub-ws"].record();
        this._closeCircuit("finnhub-ws");
        this.opts.ingestPrice(q.symbol, q.mid, q.bid, q.ask, "finnhub-ws");
      },
      onError: (err) => {
        this.stats["finnhub-ws"].error();
        console.warn("[feed-manager] Finnhub-WS (STAGING) error:", err.message);
      },
      onReconnect: (attempt) => {
        console.warn(`[feed-manager] Finnhub-WS (STAGING) reconnect attempt #${attempt}`);
      },
    });

    this.finnhubFeed.start();
  }

  private _startFinnhubRestPolling(): void {
    const cfg = this.opts.finnhub;
    if (!cfg) return;

    // Call immediately, then every FINNHUB_REST_ROTATION_MS. No batching —
    // Finnhub Free's /quote has no batch endpoint, and the staging symbol
    // set (5 equities) is small enough that a single sequential pass per
    // cycle is already well under the free-tier rate limit (see
    // finnhub.rest.ts's own header comment).
    void this._pollFinnhubRestBatch();
    this.finnhubRestTimer = setInterval(() => void this._pollFinnhubRestBatch(), FINNHUB_REST_ROTATION_MS);
    console.log(`[feed-manager] Finnhub-REST (STAGING) polling every ${FINNHUB_REST_ROTATION_MS}ms (${cfg.restSymbols.length} symbols, sequential)`);
  }

  private async _pollFinnhubRestBatch(): Promise<void> {
    const cfg = this.opts.finnhub;
    if (!cfg || !this.finnhubRunning) return;

    try {
      const prices = await fetchFinnhubCurrentPrices(cfg.apiKey, cfg.restSymbols);

      if (prices.size === 0) {
        this.stats["finnhub-rest"].error();
        return;
      }

      for (const [sym, price] of prices) {
        if (price > 0) {
          this.stats["finnhub-rest"].record();
          this._closeCircuit("finnhub-rest");
          this.opts.ingestPrice(sym, price, undefined, undefined, "finnhub-rest");
        }
      }
    } catch {
      this.stats["finnhub-rest"].error();
    }
  }

  // ── Health monitor + circuit breaker ──────────────────────────────────────

  private _startHealthMonitor(): void {
    this.healthTimer = setInterval(() => this._checkHealth(), HEALTH_CHECK_INTERVAL_MS);
  }

  private _checkHealth(): void {
    const now   = Date.now();
    // NOTE: finnhub-ws/finnhub-rest are included here for completeness, but
    // this does NOT change circuit-breaker behavior when Finnhub is
    // disabled (the default/production path): .every() requires ALL
    // listed feeds dead before opening the circuit, and finnhub-ws/
    // finnhub-rest are PERMANENTLY "dead" (no lastQuoteAt ever recorded)
    // whenever opts.finnhub is unset — two permanently-true entries added
    // to an .every() check can only ever make the overall result depend
    // on the OTHER three exactly as before; they can never be the reason
    // the check flips from false to true, since they never contribute a
    // "not dead" that would need offsetting. Proven by
    // feed.manager.finnhub.gating.spec.ts's dedicated regression test.
    const allFeeds = ["twelvedata-ws", "binance-ws", "twelvedata-rest", "finnhub-ws", "finnhub-rest"] as FeedName[];
    const allDead  = allFeeds.every((name) => this.stats[name].status(now) === "dead");

    if (allDead) {
      if (!this.allDeadSince) {
        this.allDeadSince = now;
        console.error("[feed-manager] ALL feeds are dead — monitoring circuit...");
      }

      const deadFor = now - this.allDeadSince;

      if (deadFor >= CIRCUIT_BREAK_MS && !this.circuitOpen) {
        this._openCircuit();
      }
    } else {
      this.allDeadSince = null;

      if (this.circuitOpen) {
        const recoveredFeed = allFeeds.find((n) => this.stats[n].status(now) !== "dead");
        console.log(`[feed-manager] circuit CLOSED — feed recovered: ${recoveredFeed}`);
        this.circuitOpen = false;
      }
    }
  }

  private _openCircuit(): void {
    this.circuitOpen = true;
    feedCircuit.open();
    console.error(
      "[feed-manager] CIRCUIT OPEN — all market data feeds dead for " +
      `${CIRCUIT_BREAK_MS / 1000}s. ` +
      "New orders BLOCKED. Existing positions monitored on last known prices."
    );

    // PHASE E (failure-injection audit): emitted directly, no type-bypass
    // needed now that RiskWarningEvent.userId is optional -- see that
    // type's docstring. main.ts's "risk.warning" handler routes CRITICAL
    // severity to pushToStaff() regardless of userId, so this platform-
    // wide alert actually reaches risk/admin staff now (it previously
    // never could: the handler only ever called
    // enqueueAndPush(event.userId, ...), which silently drops any event
    // whose userId doesn't match a currently-connected client -- true for
    // every connection when userId is absent).
    eventBus.emit("risk.warning", {
      severity: "CRITICAL",
      reason:   "FEED_CIRCUIT_OPEN",
      message:  "All market data feeds offline — new orders blocked",
      timestamp: new Date().toISOString(),
    });
  }

  private _closeCircuit(feed: FeedName): void {
    if (this.circuitOpen) {
      this.circuitOpen  = false;
      this.allDeadSince = null;
      feedCircuit.close();
      console.log(`[feed-manager] circuit CLOSED — recovered via ${feed}`);
    }
  }
}
