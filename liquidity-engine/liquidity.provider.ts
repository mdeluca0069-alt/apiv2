/**
 * InternalBBookProvider — IGFXPRO internal B-book execution venue.
 *
 * Architecture: internal B-book, implements ILiquidityProvider.
 *   - All orders are matched internally against the broker book.
 *   - No external LP, prime broker, ECN, or FIX connectivity.
 *   - Fill prices are derived exclusively from real TwelveData market data.
 *   - No synthetic depth levels, no GBM, no Math.random().
 *
 * Fill price model (B-book standard):
 *   BUY  → executes at ask  (broker sells at ask)
 *   SELL → executes at bid  (broker buys at bid)
 *   Slippage is deterministic, tiered by notional — zero random component.
 *
 * ILiquidityProvider notes:
 *   - supportsPartialFills = false: B-book fills 100% of any size.
 *   - getQuote(): returns the current TwelveData-sourced bid/ask as a LiquidityQuote.
 *   - cancelOrder(): always resolves true (B-book has no pending resting orders at venue).
 */

import type { Quote }           from "../shared/contracts.js";
import type {
  ILiquidityProvider,
  LiquidityQuote,
  ProviderFillResult,
}                               from "./i.liquidity.provider.js";
import { quoteCache }           from "../market-data/quote.cache.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LiquidityBook = {
  symbol:      string;
  provider:    "IGFX_INTERNAL";
  mode:        "internal";
  bid:         number;
  ask:         number;
  spread:      number;
  spreadBps:   number;
  generatedAt: string;
};

export type FillResult = {
  averagePrice:      number;
  filledQuantity:    number;
  remainingQuantity: number;
  slippage:          number;
  liquidityConsumed: number;
  partialFill:       boolean;
};

// ─── Asset-class detection ────────────────────────────────────────────────────

const FX_MAJOR  = new Set(["EURUSD","GBPUSD","USDJPY","AUDUSD","USDCHF","USDCAD","NZDUSD"]);
const COMMODITY = new Set(["XAUUSD","XAGUSD","WTI","BRENT","NGAS"]);
const INDEX     = new Set(["US500","US100","DE40","UK100","JP225","EU50","AU200"]);
const CRYPTO    = new Set(["BTCUSD","ETHUSD","LTCUSD","XRPUSD","SOLUSD"]);

export function assetClassOf(symbol: string): string {
  const s = symbol.toUpperCase();
  if (FX_MAJOR.has(s))  return "FX_MAJOR";
  if (COMMODITY.has(s)) return "COMMODITY";
  if (INDEX.has(s))     return "INDEX";
  if (CRYPTO.has(s))    return "CRYPTO";
  if (s.length === 6 && /^[A-Z]{6}$/.test(s)) return "FX_MINOR";
  return "EQUITY";
}

// ─── Per-asset fee schedule (basis points) ───────────────────────────────────

const FEE_BPS: Record<string, number> = {
  FX_MAJOR:  0.5,
  FX_MINOR:  0.8,
  INDEX:     1.0,
  COMMODITY: 1.2,
  EQUITY:    2.0,
  CRYPTO:    2.5,
};

export function feeBpsFor(symbol: string): number {
  return FEE_BPS[assetClassOf(symbol)] ?? 1.0;
}

// ─── Price precision ──────────────────────────────────────────────────────────

function precisionFor(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s === "EURUSD" || s === "GBPUSD" || s === "AUDUSD" || s === "NZDUSD") return 5;
  if (s.includes("JPY")) return 3;
  if (COMMODITY.has(s) || INDEX.has(s) || CRYPTO.has(s)) return 2;
  return 5;
}

function roundPrice(symbol: string, value: number): number {
  return Number(value.toFixed(precisionFor(symbol)));
}

// ─── InternalBBookProvider ───────────────────────────────────────────────────

export class InternalLiquidityProvider implements ILiquidityProvider {

  // ── ILiquidityProvider identity ──────────────────────────────────────────
  readonly providerId            = "IGFX_INTERNAL";
  readonly supportsPartialFills  = false;
  readonly maxSingleFillNotional = undefined; // B-book fills any size

  // ── ILiquidityProvider: getQuote ─────────────────────────────────────────
  getQuote(symbol: string): LiquidityQuote | null {
    const q = quoteCache.get(symbol.toUpperCase());
    if (!q) return null;
    return {
      symbol:    q.symbol,
      bid:       q.bid,
      ask:       q.ask,
      spread:    q.spread,
      provider:  this.providerId,
      timestamp: q.ts ?? new Date().toISOString(),
    };
  }

  // ── ILiquidityProvider: executeMarketOrder ───────────────────────────────
  executeMarketOrder(
    symbol:   string,
    side:     "BUY" | "SELL",
    quantity: number,
    quote:    Pick<Quote, "symbol" | "bid" | "ask" | "mid">,
  ): ProviderFillResult {
    const fill = this.calculateFill({ symbol, bid: quote.bid, ask: quote.ask }, side, quantity);
    return {
      averagePrice:      fill.averagePrice,
      filledQuantity:    fill.filledQuantity,
      remainingQuantity: fill.remainingQuantity,
      slippage:          fill.slippage,
      liquidityConsumed: fill.liquidityConsumed,
      partialFill:       fill.partialFill,
      provider:          this.providerId,
    };
  }

  // ── ILiquidityProvider: executeLimitOrder ────────────────────────────────
  executeLimitOrder(
    symbol:     string,
    side:       "BUY" | "SELL",
    quantity:   number,
    limitPrice: number,
    quote:      Pick<Quote, "symbol" | "bid" | "ask" | "mid">,
  ): ProviderFillResult {
    // B-book fills at limitPrice exactly (no price improvement, no worse fill).
    const syntheticQuote = {
      symbol,
      bid: side === "SELL" ? limitPrice : quote.bid,
      ask: side === "BUY"  ? limitPrice : quote.ask,
    };
    const fill = this.calculateFill(syntheticQuote, side, quantity);
    return {
      averagePrice:      fill.averagePrice,
      filledQuantity:    fill.filledQuantity,
      remainingQuantity: fill.remainingQuantity,
      slippage:          fill.slippage,
      liquidityConsumed: fill.liquidityConsumed,
      partialFill:       fill.partialFill,
      provider:          this.providerId,
    };
  }

  // ── ILiquidityProvider: cancelOrder ─────────────────────────────────────
  // B-book: resting orders live in pendingOrderBook (in-process), not at a
  // venue.  Cancellation is handled by pendingOrderBook.cancel(); here we
  // always return true as the venue-level cancel is a no-op.
  async cancelOrder(_orderId: string): Promise<boolean> {
    return true;
  }

  /**
   * Build a LiquidityBook from a real market quote.
   * The book reflects the current best bid/ask — no synthetic depth levels.
   */
  buildBook(quote: Pick<Quote, "symbol" | "bid" | "ask" | "mid" | "spread" | "changePct">): LiquidityBook {
    const spread    = Number((quote.ask - quote.bid).toFixed(precisionFor(quote.symbol)));
    const spreadBps = Number(((spread / quote.mid) * 10_000).toFixed(2));

    return {
      symbol:      quote.symbol,
      provider:    "IGFX_INTERNAL",
      mode:        "internal",
      bid:         quote.bid,
      ask:         quote.ask,
      spread,
      spreadBps,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Calculate the fill price for an internal B-book market order.
   *
   * Price source: real bid/ask from TwelveData (via quoteCache).
   * Model: BUY fills at ask, SELL fills at bid.
   * Slippage: deterministic, tiered by notional — no random component.
   * B-book always fills 100%: remainingQuantity is always 0.
   */
  calculateFill(
    quote:    Pick<Quote, "symbol" | "bid" | "ask">,
    side:     "BUY" | "SELL",
    quantity: number,
  ): FillResult {
    const topPrice = side === "BUY" ? quote.ask : quote.bid;
    const notional = quantity * topPrice;
    const slippage = this._deterministicSlippage(quote.symbol, notional);

    const averagePrice = side === "BUY"
      ? topPrice + slippage
      : topPrice - slippage;

    return {
      averagePrice:      roundPrice(quote.symbol, Math.max(averagePrice, 0)),
      filledQuantity:    quantity,
      remainingQuantity: 0,
      slippage,
      liquidityConsumed: quantity,
      partialFill:       false,
    };
  }

  /**
   * Calculate fill directly from a pre-built book.
   * Used by LiquidationEngine to avoid rebuilding the book from the quote.
   */
  calculateFillFromBook(book: LiquidityBook, side: "BUY" | "SELL", quantity: number): FillResult {
    return this.calculateFill(
      { symbol: book.symbol, bid: book.bid, ask: book.ask },
      side,
      quantity,
    );
  }

  /**
   * Deterministic slippage tiers by asset class and notional size.
   * Same inputs always produce the same slippage — no random component.
   * Reflects realistic B-book internal execution quality for retail order sizes.
   */
  private _deterministicSlippage(symbol: string, notional: number): number {
    const ac   = assetClassOf(symbol);
    const prec = precisionFor(symbol);

    let slip = 0;
    switch (ac) {
      case "FX_MAJOR":
        if      (notional < 100_000)    slip = 0;
        else if (notional < 500_000)    slip = 0.00001;
        else if (notional < 2_000_000)  slip = 0.00002;
        else                            slip = 0.00005;
        break;
      case "FX_MINOR":
        if      (notional < 50_000)     slip = 0;
        else if (notional < 200_000)    slip = 0.00002;
        else                            slip = 0.00005;
        break;
      case "INDEX":
        if      (notional < 100_000)    slip = 0;
        else if (notional < 500_000)    slip = 0.5;
        else                            slip = 2.0;
        break;
      case "COMMODITY":
        if      (notional < 50_000)     slip = 0;
        else if (notional < 500_000)    slip = 0.05;
        else                            slip = 0.20;
        break;
      case "CRYPTO":
        if      (notional < 10_000)     slip = 0;
        else if (notional < 100_000)    slip = 1.0;
        else                            slip = 5.0;
        break;
      default:
        if      (notional < 100_000)    slip = 0;
        else                            slip = 0.01;
    }

    return Number(slip.toFixed(prec));
  }
}

export const LiquidityProvider = new InternalLiquidityProvider();
export default LiquidityProvider;
