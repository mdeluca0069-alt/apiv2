/**
 * MT5BridgeInterface — contract for the future MT5 integration layer.
 *
 * The MT5 bridge MUST consume prices exclusively from the InternalLiquidityCore
 * (via quoteCache / market.quote events).  It is FORBIDDEN to maintain its own
 * quote source — doing so would break the single-source-of-truth guarantee.
 *
 * Implementation notes for the future MT5 gateway service:
 *   1. Subscribe to eventBus.on("market.quote") — each tick is forwarded here.
 *   2. Use quoteCache.get(symbol) for on-demand price reads.
 *   3. Forward order requests back to OrderController (not directly to MT5 LP).
 *   4. Map MT5 volume conventions (lots) → IGFX quantity (instrument units).
 *   5. Translate MT5 order types (BuyLimit, SellStop…) → IGFX order types.
 */

import { eventBus }  from "../../events-bus/event.bus.js";
import { quoteCache } from "../../market-data/quote.cache.js";
import type { Quote } from "../../shared/contracts.js";

export type MT5SymbolMap = Record<string, string>; // MT5 symbol → IGFX symbol

export type MT5QuoteFrame = {
  symbol:    string; // MT5 format (e.g. "EURUSDpro")
  bid:       number;
  ask:       number;
  time:      number; // Unix timestamp (seconds)
};

export type MT5OrderRequest = {
  magic:     number;     // MT5 expert magic number
  symbol:    string;     // MT5 symbol
  type:      "BUY" | "SELL" | "BUY_LIMIT" | "SELL_LIMIT" | "BUY_STOP" | "SELL_STOP";
  volume:    number;     // lots
  price?:    number;     // for limit/stop orders
  sl?:       number;     // stop-loss
  tp?:       number;     // take-profit
  comment?:  string;
};

export type MT5OrderResult = {
  ticket:     number;    // MT5 order ticket
  igfxOrderId: string;
  status:     "FILLED" | "REJECTED" | "PENDING";
  fillPrice?: number;
  message?:   string;
};

/**
 * BaseMT5Bridge — provides the wire plumbing for a concrete MT5 gateway.
 *
 * Subclass this and implement:
 *   - sendQuoteToMT5(frame)  — push a quote frame to the MT5 server
 *   - handleOrderFromMT5(req) — receive an order from MT5, route to OrderController
 */
export abstract class BaseMT5Bridge {
  private _running = false;
  protected symbolMap: MT5SymbolMap;

  constructor(symbolMap: MT5SymbolMap) {
    this.symbolMap = symbolMap;
  }

  start(): void {
    if (this._running) return;
    this._running = true;

    // Forward every IGFX tick to MT5
    eventBus.on("market.quote", (evt) => {
      const mt5Symbol = this._igfxToMT5(evt.symbol);
      if (!mt5Symbol) return;

      const frame: MT5QuoteFrame = {
        symbol: mt5Symbol,
        bid:    evt.bid,
        ask:    evt.ask,
        time:   Math.floor(Date.now() / 1_000),
      };
      this.sendQuoteToMT5(frame);
    });

    console.log("[mt5-bridge] started — waiting for market.quote events");
  }

  stop(): void {
    this._running = false;
    // Note: eventBus.off() requires the original listener reference.
    // Production implementation should store the listener and call off() here.
  }

  /** Read the current quote for an MT5 symbol from quoteCache. */
  getQuote(mt5Symbol: string): Quote | null {
    const igfx = this._mt5ToIgfx(mt5Symbol);
    return igfx ? (quoteCache.get(igfx) ?? null) : null;
  }

  // ── Abstract methods — implement in the concrete gateway service ───────────

  /** Send a bid/ask frame to the MT5 server socket. */
  protected abstract sendQuoteToMT5(frame: MT5QuoteFrame): void;

  /** Receive an order from MT5 and route it to IGFX OrderController. */
  abstract handleOrderFromMT5(req: MT5OrderRequest): Promise<MT5OrderResult>;

  // ── Helpers ────────────────────────────────────────────────────────────────

  protected _igfxToMT5(igfxSymbol: string): string | null {
    for (const [mt5, igfx] of Object.entries(this.symbolMap)) {
      if (igfx === igfxSymbol) return mt5;
    }
    return null;
  }

  protected _mt5ToIgfx(mt5Symbol: string): string | null {
    return this.symbolMap[mt5Symbol] ?? null;
  }
}
