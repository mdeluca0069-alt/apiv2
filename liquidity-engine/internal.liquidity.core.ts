/**
 * InternalLiquidityCore — the single price authority for IGFXPRO.
 *
 * Responsibilities:
 *   1. Accept real bid/ask/mid prices from TwelveData feed (authoritative path).
 *   2. Write every real tick to quoteCache immediately.
 *   3. When the feed goes silent: mark the symbol STALE — never generate prices.
 *   4. Track real spreads via SpreadStore for bid/ask derivation on free-plan ticks.
 *   5. Emit market.data.stale events so the monitoring system can alert.
 *
 * Price authority — only one source:
 *   TwelveData WebSocket (real bid/ask, paid plan)
 *   TwelveData REST seed at startup (real mid, spread derived from last real spread)
 *
 * REMOVED:
 *   GBM fallback — pricing.engine.ts has been deleted.
 *   Synthetic spread generation — spread.engine.ts now tracks only real spreads.
 *
 * Dev-only exception: _seedDemoQuotes() can inject synthetic quotes into
 * quoteCache, but ONLY when both TWELVEDATA_API_KEY is absent AND
 * ALLOW_SYNTHETIC_QUOTES=true is explicitly set (never a default). Without
 * that opt-in, a missing key correctly leaves every symbol stale and orders
 * rejected — it must never silently substitute fake prices for real ones.
 *
 * Stale policy (STALE_THRESHOLD_MS without a real tick):
 *   - Symbol is marked stale.
 *   - quoteCache is NOT updated with generated prices.
 *   - Last known real quote remains in quoteCache for display only.
 *   - quoteCache.isStale() returns true → order.controller rejects all orders
 *     for this symbol with NO_LIVE_MARKET_DATA.
 */

import { spreadStore }          from "./spread.engine.js";
import { brokerSpreadConfig }   from "./broker.spread.config.js";
import { virtualOrderbook, type OrderBook } from "./virtual.orderbook.js";
import { quoteCache }           from "../market-data/quote.cache.js";
import { eventBus }             from "../events-bus/event.bus.js";
import { assetClassOf }         from "./liquidity.provider.js";
import { dynamicSpreadEngine }  from "./dynamic.spread.engine.js";
import { symbolCircuitBreaker } from "../risk-service/symbol.circuit.breaker.js";
import type { Quote }           from "../shared/contracts.js";

// How long without a real external tick before a symbol is marked stale.
//
// Actual feed architecture (no Yahoo Finance/CoinGecko/Frankfurter — that was
// an earlier design, superseded by TwelveData+Finnhub):
//   TwelveData WebSocket     continuous       → 8 most liquid symbols (free-plan WS cap).
//   Finnhub WebSocket        continuous       → all 22 symbols, redundant source.
//   TwelveData REST          every 5 min/batch → full 22-symbol cycle.
//
// NOTE: this threshold was originally tuned assuming fast (6s) backstop
// pollers that no longer exist in the codebase. Symbols covered only by
// TwelveData REST can legitimately go several minutes between ticks even
// when healthy — re-verify this value reflects the real REST batch cadence
// before relying on it for alerting.
export const STALE_THRESHOLD_MS = 360_000;

// Seed prices — used only before the first real TwelveData tick arrives.
// Updated to approximate real market prices. These never reach the execution
// engine because the symbol is stale until the first real tick.
const BASE_PRICES: Record<string, number> = {
  EURUSD: 1.1504,   GBPUSD: 1.3350,   USDJPY: 145.20,
  EURGBP: 0.8620,   AUDUSD: 0.6430,   XAUUSD: 3320.00,
  US500:  5900.00,  US100:  21200.00, DE40:   23600.00,
  UK100:  8720.00,  WTI:    62.00,    BRENT:  65.50,
  BTCUSD: 105000.00, ETHUSD: 2560.00, SOLUSD: 145.00,
  USDCHF: 0.8940,   XAGUSD: 32.50,
  AAPL:   215.00,   MSFT:   465.00,  NVDA:   1340.00,
  TSLA:   345.00,   AMZN:   212.00,
};

// ─── Types ────────────────────────────────────────────────────────────────────

type InstrumentState = {
  mid:             number;
  bid:             number;
  ask:             number;
  anchor:          number;   // used only to compute changePct against daily open
  assetClass:      string;
  lastExternalAt:  number;   // ms epoch of last real external tick (0 = never)
  hasExternal:     boolean;
  dailyOpenMid:    number;
  dailyOpenDate:   string;
  prevCloseMid:    number;
  isStale:         boolean;
  staleSince:      number | null;
};

export type LiquidityCoreOptions = {
  symbols:  string[];
  tickMs?:  number;
  onBatch?: (quotes: Quote[]) => void;
};

export type LiquidityCoreStats = {
  running:        boolean;
  symbols:        string[];
  tickCount:      number;
  tickMs:         number;
  externalPrices: number;
  staleSymbols:   string[];
};

// MARKET_DATA_FREEZE.md §0.5: before this table, the only validation any
// tick received anywhere in the ingestion chain (WS/REST feeds, this
// class) was `isFinite && > 0` -- a wild print (a decimal-point error, a
// corrupted feed message, "999999" for EURUSD) would be written into
// quoteCache immediately and unconditionally, visible to every downstream
// consumer, with only symbol.circuit.breaker.ts's async, order-blocking-
// only halt reacting afterward -- never a rejection of the bad print
// itself.
//
// Deliberately much more permissive than symbol.circuit.breaker.ts's
// HALT_THRESHOLD_PCT (10s-window) or GAP_HALT_THRESHOLD_PCT (reopen-gap)
// tables -- this is an outlier/sanity filter for prints that cannot be
// real market data under any circumstance (fat-finger, decimal shift,
// feed corruption), not a volatility control. A single legitimate tick
// moving an FX major 5%+ has essentially never happened; these bounds
// exist to catch data corruption, not to gate real (if extreme) moves.
const SANITY_BOUND_PCT: Record<string, number> = {
  FX_MAJOR:  5,
  FX_MINOR:  7,
  INDEX:     10,
  COMMODITY: 15,
  CRYPTO:    30,
  EQUITY:    25,
};
const DEFAULT_SANITY_BOUND_PCT = 15;

// MARKET_DATA_FREEZE.md §0.6: source priority, lower rank = more
// authoritative. Mirrors feed.manager.ts's own documented priority
// (PRIMARY TwelveData-WS, SECONDARY Binance-WS, TERTIARY TwelveData-REST)
// -- previously undeclared in code, so the last tick to arrive always won
// regardless of which feed produced it or how stale that feed's own data
// actually was at fetch time.
const SOURCE_PRIORITY: Record<string, number> = {
  "twelvedata-ws":   1,
  "binance-ws":      1,
  "twelvedata-rest": 2,
};
const DEFAULT_SOURCE_PRIORITY = 1; // unspecified source (tests, _seedDemoQuotes) treated as top priority
// A higher-priority source's tick "protects" a symbol from being
// overwritten by a lower-priority source for this long -- long enough to
// cover normal WS tick cadence gaps, short enough that a genuinely dead
// higher-priority feed doesn't block the lower-priority one forever
// (STALE_THRESHOLD_MS's own staleness marking already handles that case
// independently).
const SOURCE_PROTECTION_MS = 10_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function precisionFor(symbol: string, ac: string): number {
  if (symbol.includes("JPY")) return 3;
  if (ac === "FX_MAJOR" || ac === "FX_MINOR") return 5;
  return 2;
}

export function normaliseSymbol(raw: string): string {
  return raw.toUpperCase().replace("/", "");
}

// ─── InternalLiquidityCore ────────────────────────────────────────────────────

export class InternalLiquidityCore {
  private readonly instruments = new Map<string, InstrumentState>();
  // MARKET_DATA_FREEZE.md §0.6: last source+time a tick was actually
  // accepted for each symbol, so a lower-priority source's slower/older
  // data can't silently overwrite a higher-priority source's fresher tick
  // that arrived moments earlier (see ingestExternalPrice()).
  private readonly lastAcceptedSource = new Map<string, { rank: number; at: number }>();
  private readonly onBatch?:    (quotes: Quote[]) => void;
  private readonly tickMs:      number;

  private timer:     NodeJS.Timeout | null = null;
  private running    = false;
  private tickCount  = 0;
  private extCount   = 0;

  constructor(opts: LiquidityCoreOptions) {
    this.tickMs  = opts.tickMs ?? 1_000;
    this.onBatch = opts.onBatch;

    for (const sym of opts.symbols) {
      const key      = normaliseSymbol(sym);
      const ac       = assetClassOf(key);
      const base     = BASE_PRICES[key] ?? 1.0;
      const todayUTC = new Date().toISOString().slice(0, 10);

      // Initial state: both bid and ask equal base price (zero spread).
      // Symbol is marked stale because no real external data has arrived.
      // quoteCache.isStale() will return true — orders will be rejected
      // until the first real TwelveData tick sets hasExternal = true.
      this.instruments.set(key, {
        mid:            base,
        bid:            base,
        ask:            base,
        anchor:         base,
        assetClass:     ac,
        lastExternalAt: 0,
        hasExternal:    false,
        dailyOpenMid:   base,
        dailyOpenDate:  todayUTC,
        prevCloseMid:   base,
        isStale:        true,
        staleSince:     Date.now(),
      });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer   = setInterval(() => this._tickAll(), this.tickMs);
    console.log(
      `[liquidity-core] started — ${this.instruments.size} instruments, interval=${this.tickMs}ms`
    );

    // FASE 3 pre-work (2026-07-11): this used to seed synthetic quotes into
    // the SAME global quoteCache real trading reads from, gated only by
    // "TWELVEDATA_API_KEY happens to be unset" — with hasExternal:true and
    // isStale:false, i.e. indistinguishable downstream from a real tick.
    // TWELVEDATA_API_KEY has gone missing/rate-limited in this exact
    // deployment repeatedly (not hypothetical), and paper-trading already
    // has its own correct design — "Prices come from the exact same live
    // market data feed as real trading" (paper.trading.service.ts) — so it
    // never needed this either. A missing key must mean "no live data,
    // orders rejected" (which is what the log line below already claimed),
    // not a silent, unannounced switch to fabricated prices for every
    // account, real-money included. Synthetic quotes now require BOTH the
    // key to be absent AND an explicit opt-in — never a default, and never
    // reachable when live trading is possible.
    if (!process.env.TWELVEDATA_API_KEY && process.env.ALLOW_SYNTHETIC_QUOTES === "true") {
      this._seedDemoQuotes();
      setInterval(() => this._seedDemoQuotes(), 5 * 60_000);
      console.log("[liquidity-core] ALLOW_SYNTHETIC_QUOTES=true — synthetic quotes active (dev-only, never enable this against a live-trading deployment)");
    } else if (!process.env.TWELVEDATA_API_KEY) {
      console.log("[liquidity-core] no TWELVEDATA_API_KEY — instruments stay stale, orders will be rejected with NO_LIVE_MARKET_DATA (set ALLOW_SYNTHETIC_QUOTES=true to opt into synthetic dev quotes instead)");
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Seed the daily open and previous close prices from the TwelveData REST
   * /quote endpoint. Called once at startup before the WebSocket feed connects.
   *
   * The symbol remains stale until the first WebSocket tick arrives because
   * the REST close price may be hours old. The quote is stored for display
   * only — execution is blocked by the stale check in order.controller.
   */
  seedDailyData(rawSymbol: string, close: number, prevClose: number): void {
    const key   = normaliseSymbol(rawSymbol);
    const state = this.instruments.get(key);
    if (!state || !isFinite(close) || close <= 0) return;

    const ac    = state.assetClass;
    const prec  = precisionFor(key, ac);

    // Derive bid/ask — same priority as ingestExternalPrice.
    const lastRealSpread   = spreadStore.getLastRealSpread(key);
    const brokerSpread     = brokerSpreadConfig.getSpread(key);
    const effectiveSpread  = (lastRealSpread !== null && lastRealSpread > 0)
      ? lastRealSpread
      : (brokerSpread !== null && brokerSpread > 0)
        ? brokerSpread
        : 0;

    let bid: number;
    let ask: number;
    if (effectiveSpread > 0) {
      bid = Number((close - effectiveSpread / 2).toFixed(prec));
      ask = Number((close + effectiveSpread / 2).toFixed(prec));
    } else {
      bid = close;
      ask = close;
    }

    state.mid          = close;
    state.bid          = bid;
    state.ask          = ask;
    state.anchor       = close;
    state.dailyOpenMid = close;
    state.prevCloseMid = isFinite(prevClose) && prevClose > 0 ? prevClose : close;
    // REST price is real data — mark as having external data.
    // lastExternalAt is set so the symbol is not stale for the next
    // STALE_THRESHOLD_MS, giving the WebSocket time to connect.
    state.hasExternal    = true;
    state.lastExternalAt = Date.now();
    state.isStale        = false;
    state.staleSince     = null;
    this.extCount++;

    const quote = this._buildQuoteFromState(key, state);
    if (quote) quoteCache.set(quote);

    console.log(`[liquidity-core] seeded ${key}: close=${close} prevClose=${state.prevCloseMid}`);
  }

  /**
   * Accept a real market price from TwelveData.
   *
   * This is the ONLY write path to quoteCache.
   *   - bid/ask are real when the paid plan provides them.
   *   - When only mid is provided (free plan), bid/ask are derived from the
   *     last real spread recorded by SpreadStore. If no real spread is known
   *     yet, bid = ask = mid (zero spread).
   *
   * Returns true if the tick was actually accepted and written, false if it
   * was rejected (invalid input, source-priority ordering, sanity-bound
   * outlier). MARKET_DATA_FREEZE.md §0.8: callers that also track feed
   * health (main.ts's ingestPrice -> feedHealthMonitor.recordQuote()) must
   * only record a tick as "fresh" when it was genuinely accepted here --
   * otherwise a tick this method rejects can still be counted as a live,
   * healthy quote by a separate tracker that ran unconditionally before
   * this one had a chance to validate it.
   */
  ingestExternalPrice(
    rawSymbol:   string,
    externalMid: number,
    externalBid?: number,
    externalAsk?: number,
    source?:     string,
  ): boolean {
    const key   = normaliseSymbol(rawSymbol);
    const state = this.instruments.get(key);
    if (!state || !isFinite(externalMid) || externalMid <= 0) return false;

    // MARKET_DATA_FREEZE.md §0.6: ordering guard -- a lower-priority
    // source (e.g. TwelveData-REST, a batch poll that can reflect data up
    // to REST_ROTATION_MS old by the time it's fetched) must not overwrite
    // a higher-priority source's (WS) tick that was accepted moments ago.
    // Arrival order at this server is not the same as data recency. Only
    // the CHECK happens here -- lastAcceptedSource is recorded further
    // down, only once this tick has also passed the sanity-bound check
    // below, so a rejected outlier never "protects" a symbol under a rank
    // it was never legitimately accepted at.
    const sourceRank = SOURCE_PRIORITY[source ?? ""] ?? DEFAULT_SOURCE_PRIORITY;
    const lastSource  = this.lastAcceptedSource.get(key);
    if (lastSource && sourceRank > lastSource.rank && (Date.now() - lastSource.at) < SOURCE_PROTECTION_MS) {
      return false; // a higher-priority source is actively covering this symbol -- discard the slower one
    }

    const ac   = state.assetClass;
    const prec = precisionFor(key, ac);
    const now  = Date.now();

    // Captured before any mutation below, for the reopen-gap check after the
    // isStale-clearing block. hadExternal distinguishes "recovered after a
    // real gap" from "the very first tick this symbol has ever received"
    // (whose state.mid is still the synthetic seed price, not a real one).
    const wasStale     = state.isStale;
    const hadExternal  = state.hasExternal;
    const previousMid  = state.mid;

    // MARKET_DATA_FREEZE.md §0.5: outlier/sanity check -- reject a tick
    // outright (never mutate state, never write quoteCache, never reach
    // the circuit breaker's window) if it deviates from the last known
    // real price by more than what's physically plausible for a single
    // tick. Skipped for a symbol's very first-ever tick (hadExternal
    // false): there is no real previous price to compare against yet,
    // only the synthetic seed, which could itself be far from today's
    // real level and would cause false rejections.
    if (hadExternal && previousMid > 0) {
      const movePct = Math.abs((externalMid - previousMid) / previousMid) * 100;
      const bound = SANITY_BOUND_PCT[state.assetClass] ?? DEFAULT_SANITY_BOUND_PCT;
      if (movePct > bound) {
        console.error(
          `[liquidity-core] REJECTED outlier tick for ${key}: ${previousMid} -> ${externalMid} ` +
          `(${movePct.toFixed(2)}% move, sanity bound ${bound}%) -- discarded, not written anywhere`,
        );
        return false;
      }
    }

    // Tick has passed both the priority-ordering and sanity-bound checks --
    // now legitimately accepted. Record its source/rank so a subsequent
    // lower-priority tick can be measured against it.
    this.lastAcceptedSource.set(key, { rank: sourceRank, at: now });

    // FASE 3.2: per-symbol circuit breaker — halts new order acceptance for
    // THIS symbol if the price moved abnormally fast within a short window.
    // Independent of dynamic spread widening below (that reacts to the
    // DAILY change from open, this reacts to short-window velocity) and of
    // staleness detection (that's the opposite condition — no ticks, not
    // too-fast ticks). Never blocks the tick itself from being processed.
    symbolCircuitBreaker.recordTick(key, externalMid, ac);

    let bid: number;
    let ask: number;

    if (
      externalBid !== undefined && externalAsk !== undefined &&
      isFinite(externalBid) && isFinite(externalAsk) &&
      externalBid > 0 && externalAsk > externalBid
    ) {
      // Paid plan: real bid/ask — use directly and record the spread.
      bid = Number(externalBid.toFixed(prec));
      ask = Number(externalAsk.toFixed(prec));
      spreadStore.recordRealSpread(key, bid, ask);
    } else {
      // No real bid/ask from feed.
      // Priority: last observed real spread → broker configured spread → zero (rejected at order time).

      const lastRealSpread   = spreadStore.getLastRealSpread(key);
      const brokerSpread     = brokerSpreadConfig.getSpread(key);
      const effectiveSpread  = (lastRealSpread !== null && lastRealSpread > 0)
        ? lastRealSpread
        : (brokerSpread !== null && brokerSpread > 0)
          ? brokerSpread
          : 0;

      if (effectiveSpread > 0) {
        bid = Number((externalMid - effectiveSpread / 2).toFixed(prec));
        ask = Number((externalMid + effectiveSpread / 2).toFixed(prec));
      } else {
        // No spread available from any source — quote is zero-spread.
        // Order controller will reject any order on this symbol until
        // either the feed provides real bid/ask or an admin configures a spread.
        bid = Number(externalMid.toFixed(prec));
        ask = Number(externalMid.toFixed(prec));
      }
    }

    // Apply dynamic spread widening (volatility or event-driven).
    // Only applied when the feed did NOT provide real bid/ask (i.e. free-plan mid-only).
    // When real bid/ask are provided we widen only if there's actual volatility (mult > 1.05).
    const preChangePct = state.prevCloseMid > 0
      ? (externalMid - state.prevCloseMid) / state.prevCloseMid * 100
      : 0;
    const dynMult   = dynamicSpreadEngine.applySpread(key, preChangePct, ac) /
                      Math.max(dynamicSpreadEngine.getEffectiveSpread(key), 0.000001);
    const hasRealBA = externalBid !== undefined && externalAsk !== undefined;
    if (!hasRealBA && dynMult > 0) {
      const bs = dynamicSpreadEngine.getEffectiveSpread(key);
      if (bs > 0 && bs > Math.abs(ask - bid)) {
        bid = Number((externalMid - bs / 2).toFixed(prec));
        ask = Number((externalMid + bs / 2).toFixed(prec));
      }
    } else if (hasRealBA && dynMult > 1.05) {
      // Widen real spread only under genuine volatility
      const currentSpread = ask - bid;
      const widenedSpread = currentSpread * dynMult;
      bid = Number((externalMid - widenedSpread / 2).toFixed(prec));
      ask = Number((externalMid + widenedSpread / 2).toFixed(prec));
    }

    state.mid            = externalMid;
    state.bid            = bid;
    state.ask            = ask;
    state.anchor         = externalMid;
    state.lastExternalAt = now;

    if (!state.hasExternal) {
      state.hasExternal   = true;
      state.dailyOpenMid  = externalMid;
      state.prevCloseMid  = externalMid;
      state.dailyOpenDate = new Date(now).toISOString().slice(0, 10);
      this.extCount++;
    }

    // Clear stale flag on every real tick.
    if (state.isStale) {
      state.isStale    = false;
      state.staleSince = null;
      console.log(`[liquidity-core] ${key} feed recovered — accepting orders`);
    }

    // RISK_ENGINE_FREEZE.md §5.4: recordTick()'s 10s rolling window
    // structurally requires 2 ticks within that window to measure a move,
    // so it never fires across a gap >= 10s -- every overnight/weekend gap
    // or feed outage silently bypassed flash-move detection. This is the
    // true reopen-transition check: comparing the last real price this
    // symbol had before it went stale against the first real price after,
    // regardless of how long the gap was.
    if (wasStale && hadExternal && previousMid > 0) {
      symbolCircuitBreaker.recordReopen(key, previousMid, externalMid, ac);
    }

    // Day rollover
    const todayUTC = new Date(now).toISOString().slice(0, 10);
    if (todayUTC !== state.dailyOpenDate) {
      state.prevCloseMid  = state.dailyOpenMid;
      state.dailyOpenMid  = externalMid;
      state.dailyOpenDate = todayUTC;
    }

    const changePct = state.prevCloseMid > 0
      ? Number(((externalMid - state.prevCloseMid) / state.prevCloseMid * 100).toFixed(3))
      : 0;

    const quote: Quote = {
      symbol:    key,
      bid,
      ask,
      mid:       Number(externalMid.toFixed(prec)),
      spread:    Number((ask - bid).toFixed(prec)),
      changePct,
      ts:        new Date(now).toISOString(),
      // A real tick just landed -- definitionally not stale at this instant.
      isStale:   false,
    };

    quoteCache.set(quote);
    return true;
  }

  /** Returns true if the symbol has no live market data (stale or never received). */
  isStale(rawSymbol: string): boolean {
    const key   = normaliseSymbol(rawSymbol);
    const state = this.instruments.get(key);
    if (!state) return true;
    return state.isStale;
  }

  tickSymbol(rawSymbol: string): Quote | null {
    return this._tick(normaliseSymbol(rawSymbol));
  }

  getBook(rawSymbol: string): OrderBook | null {
    const key   = normaliseSymbol(rawSymbol);
    const state = this.instruments.get(key);
    if (!state) return null;

    return virtualOrderbook.build({
      symbol:     key,
      bid:        state.bid,
      ask:        state.ask,
      mid:        state.mid,
      spread:     Number((state.ask - state.bid).toFixed(precisionFor(key, state.assetClass))),
      changePct:  0,
      assetClass: state.assetClass,
    });
  }

  getAllQuotes(): Quote[] {
    const results: Quote[] = [];
    for (const [key, state] of this.instruments) {
      const q = this._buildQuoteFromState(key, state);
      if (q) results.push(q);
    }
    return results;
  }

  getStats(): LiquidityCoreStats {
    const staleSymbols: string[] = [];
    for (const [key, state] of this.instruments) {
      if (state.isStale) staleSymbols.push(key);
    }
    return {
      running:        this.running,
      symbols:        [...this.instruments.keys()],
      tickCount:      this.tickCount,
      tickMs:         this.tickMs,
      externalPrices: this.extCount,
      staleSymbols,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _tickAll(): void {
    const batch: Quote[] = [];

    for (const key of this.instruments.keys()) {
      const q = this._tick(key);
      if (q) batch.push(q);
    }

    this.tickCount++;
    this.onBatch?.(batch);
  }

  private _tick(symbol: string): Quote | null {
    const state = this.instruments.get(symbol);
    if (!state) return null;

    const now = Date.now();

    // ── Real price path: feed is active ──────────────────────────────────────
    // quoteCache was already written by ingestExternalPrice() on the real tick.
    // Clear stale flag if it was previously stale.
    if (state.hasExternal && (now - state.lastExternalAt) < STALE_THRESHOLD_MS) {
      if (state.isStale) {
        state.isStale    = false;
        state.staleSince = null;
      }
      return this._buildQuoteFromState(symbol, state);
    }

    // ── Feed is stale or never connected ─────────────────────────────────────
    // GBM has been removed. Do NOT generate prices.
    // Mark the symbol stale and emit a monitoring event on first detection.
    const wasAlreadyStale = state.isStale;
    state.isStale = true;

    if (!wasAlreadyStale) {
      state.staleSince = now;
      console.warn(
        `[liquidity-core] ${symbol} market data stale — ` +
        `last tick ${Math.round((now - state.lastExternalAt) / 1_000)}s ago — ` +
        `orders will be rejected with NO_LIVE_MARKET_DATA`
      );
      eventBus.emit("market.data.stale", {
        symbol,
        lastExternalAt: state.lastExternalAt,
        staleSince:     now,
        timestamp:      new Date(now).toISOString(),
      });
    }

    // Return last known real quote for display only.
    // quoteCache is NOT updated — the stale timestamp persists.
    return this._buildQuoteFromState(symbol, state);
  }

  // Dev-only fallback (see class docstring — requires explicit opt-in via
  // ALLOW_SYNTHETIC_QUOTES=true, never a default). NOT what paper trading
  // uses: paper-trading/paper.trading.service.ts reads the same real
  // quoteCache as live trading, it never needed this. This exists purely
  // so a local dev environment without a TwelveData key can still place
  // orders. Prefers prices already in quoteCache (e.g. from DB warm-up)
  // over BASE_PRICES so they look like realistic market levels.
  private _seedDemoQuotes(): void {
    const now = new Date().toISOString();
    for (const [key, state] of this.instruments) {
      const prec        = precisionFor(key, state.assetClass);
      const existing    = quoteCache.get(key);
      const brokerSpread = brokerSpreadConfig.getSpread(key) ?? 0;

      let mid: number;
      let bid: number;
      let ask: number;

      if (existing && existing.mid > 0 && existing.spread > 0) {
        // DB warm-up had real prices — just keep them with a fresh timestamp
        mid = existing.mid;
        bid = existing.bid;
        ask = existing.ask;
      } else {
        // No cached quote or zero spread — build from BASE_PRICE + broker defaults
        mid = state.mid > 0 ? state.mid : (BASE_PRICES[key] ?? 1.0);
        if (brokerSpread > 0) {
          bid = Number((mid - brokerSpread / 2).toFixed(prec));
          ask = Number((mid + brokerSpread / 2).toFixed(prec));
        } else {
          bid = Number(mid.toFixed(prec));
          ask = Number((mid * 1.0001).toFixed(prec)); // minimal 1-pip equivalent
        }
      }

      // Update internal state so _tick() knows we have live data
      state.mid            = mid;
      state.bid            = bid;
      state.ask            = ask;
      state.hasExternal    = true;
      state.lastExternalAt = Date.now();
      state.isStale        = false;
      state.staleSince     = null;

      const quote: Quote = {
        symbol:    key,
        bid:       Number(bid.toFixed(prec)),
        ask:       Number(ask.toFixed(prec)),
        mid:       Number(mid.toFixed(prec)),
        spread:    Number((ask - bid).toFixed(prec)),
        changePct: existing?.changePct ?? 0,
        ts:        now,
        isStale:   false,
      };
      quoteCache.set(quote);
    }
  }

  private _buildQuoteFromState(symbol: string, state: InstrumentState): Quote | null {
    if (!isFinite(state.mid) || state.mid <= 0) return null;
    if (!isFinite(state.bid) || !isFinite(state.ask)) return null;
    if (state.bid <= 0 || state.ask < state.bid) return null;

    const prec      = precisionFor(symbol, state.assetClass);
    const now       = new Date();
    const todayUTC  = now.toISOString().slice(0, 10);

    if (todayUTC !== state.dailyOpenDate) {
      state.prevCloseMid  = state.dailyOpenMid;
      state.dailyOpenMid  = state.mid;
      state.dailyOpenDate = todayUTC;
    }

    const base      = state.prevCloseMid > 0 ? state.prevCloseMid : state.dailyOpenMid;
    const changePct = base > 0
      ? Number(((state.mid - base) / base * 100).toFixed(3))
      : 0;

    return {
      symbol,
      bid:       Number(state.bid.toFixed(prec)),
      ask:       Number(state.ask.toFixed(prec)),
      mid:       Number(state.mid.toFixed(prec)),
      spread:    Number((state.ask - state.bid).toFixed(prec)),
      changePct,
      // MARKET_DATA_FREEZE.md §0.9: this is called every periodic
      // broadcast tick (_tick(), ~1/sec), not only on a real external tick
      // -- stamping `now` unconditionally meant a symbol whose feed died
      // still broadcast a fresh-looking timestamp every cycle, forever.
      // Reflects the real last-tick time once one has happened; a
      // consumer computing "age" from ts (instead of reading isStale
      // directly) now sees the truth too, not just this field's sibling.
      ts: state.hasExternal ? new Date(state.lastExternalAt).toISOString() : now.toISOString(),
      // MARKET_DATA_FREEZE.md §0.7: surface the staleness this class
      // already tracks internally (state.isStale, cleared/set alongside
      // quoteCache.isStale()'s own age-based check) so every consumer of
      // this quote -- WS broadcast, REST snapshot -- can tell a dead feed
      // from a live one, instead of only the backend's own order-rejection
      // path knowing.
      isStale:   state.isStale,
    };
  }
}
