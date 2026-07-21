/**
 * broker-state.quote.single.source.spec.ts
 *
 * MARKET_DATA_FREEZE.md §0.1 — BrokerState.quotes was a THIRD, permanently
 * disconnected price store: populated once at construction (before
 * quoteCache even existed), never refreshed (updateQuotes() is dead code),
 * and read directly by getQuote()/getLiquidityBook() while getQuotes() only
 * partially merged in quoteCache. GET /api/liquidity/book/:symbol and
 * GET /api/trading/quotes (and everything built on top of them --
 * watchlists, slippage preview, platform stats) could show a materially
 * different price than quoteCache/execution/risk for the same symbol at the
 * same instant, indefinitely.
 *
 * Proves getQuote()/getQuotes()/getLiquidityBook() now all resolve through
 * quoteCache live, on every call -- not a frozen snapshot -- for any symbol
 * quoteCache has real data for, and that a live quoteCache update is
 * reflected on the very next read with no explicit refresh step.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BrokerState } from "../shared/state.js";
import { quoteCache } from "../market-data/quote.cache.js";
import type { Quote } from "../shared/contracts.js";

function liveQuote(symbol: string, mid: number): Quote {
  return {
    symbol,
    bid: mid - 0.0001,
    ask: mid + 0.0001,
    mid,
    spread: 0.0002,
    changePct: 0,
    ts: new Date().toISOString(),
  };
}

describe("BrokerState — single source of truth for quotes (MARKET_DATA_FREEZE.md §0.1)", () => {
  const SYMBOL = "EURUSD";

  afterEach(() => {
    // quoteCache is a module-level singleton -- restore it to "no live data"
    // so other test files (which construct BrokerState expecting the
    // synthetic-fallback path) aren't affected by this file's writes.
    quoteCache.set({ ...liveQuote(SYMBOL, 0), mid: 0, bid: 0, ask: 0, ts: "" } as Quote);
  });

  it("getQuote() reflects a live quoteCache price the instant it's set, with no explicit refresh call", () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });

    quoteCache.set(liveQuote(SYMBOL, 1.2345));
    const quote = state.getQuote(SYMBOL);

    expect(quote).not.toBeNull();
    expect(quote!.mid).toBe(1.2345);
  });

  it("getQuote() picks up a SECOND, different live update without any updateQuotes()/refresh call", () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });

    quoteCache.set(liveQuote(SYMBOL, 1.1000));
    expect(state.getQuote(SYMBOL)!.mid).toBe(1.1000);

    quoteCache.set(liveQuote(SYMBOL, 1.1500));
    expect(state.getQuote(SYMBOL)!.mid).toBe(1.1500);
  });

  it("getQuotes() reports the same live price as getQuote() for the same symbol at the same instant", () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });

    quoteCache.set(liveQuote(SYMBOL, 1.3000));

    const single = state.getQuote(SYMBOL)!;
    const fromList = state.getQuotes().find((q) => q.symbol === SYMBOL)!;

    expect(fromList).toBeDefined();
    expect(fromList.mid).toBe(single.mid);
    expect(fromList.mid).toBe(1.3000);
  });

  it("getLiquidityBook() derives its book from the same live price, not a frozen snapshot", () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });

    quoteCache.set(liveQuote(SYMBOL, 1.2000));
    const book1 = state.getLiquidityBook(SYMBOL);
    expect(book1).not.toBeNull();
    expect(book1!.bid).toBeLessThan(1.2000);
    expect(book1!.ask).toBeGreaterThan(1.2000);

    quoteCache.set(liveQuote(SYMBOL, 1.4000));
    const book2 = state.getLiquidityBook(SYMBOL);
    expect(book2!.bid).toBeCloseTo(1.4000 - 0.0001, 6);
    expect(book2!.ask).toBeCloseTo(1.4000 + 0.0001, 6);
    // Proves this is a live read, not a value cached at BrokerState
    // construction time or at the first getLiquidityBook() call.
    expect(book2!.bid).not.toBe(book1!.bid);
  });

  it("returns null for an unknown symbol instead of fabricating a quote", () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });
    expect(state.getQuote("NOT_A_REAL_SYMBOL")).toBeNull();
    expect(state.getLiquidityBook("NOT_A_REAL_SYMBOL")).toBeNull();
  });
});
