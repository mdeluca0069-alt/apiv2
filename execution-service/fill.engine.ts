/**
 * FillEngine — translates execution requests into fill results.
 *
 * Accepts an ILiquidityProvider via constructor injection so the underlying
 * venue can be swapped without touching this class or ExecutionEngine.
 *
 * Default provider: InternalBBookProvider (IGFX_INTERNAL).
 * Future providers: OneZero, PrimeXM, B2Broker, Leverate, cTrader, MatchTrader.
 *
 * Fees are calculated here (broker policy), NOT in the LP adapter.
 * The LP is responsible for: price, slippage, partialFill, filledQuantity.
 *
 * Liquidation path (fillFromBook): always uses the internal LP directly —
 * emergency closes must be B-booked regardless of configured execution venue.
 */

import type { ILiquidityProvider } from "../liquidity-engine/i.liquidity.provider.js";
import {
  LiquidityProvider,
  feeBpsFor,
  type LiquidityBook,
} from "../liquidity-engine/liquidity.provider.js";
import type { ExecutionRequest, FillResult } from "../shared/contracts.js";

export class FillEngine {
  constructor(
    private readonly liquidityProvider: ILiquidityProvider = LiquidityProvider,
  ) {}

  /**
   * Calculate fill for a market order via the configured LP.
   * The LP decides price and whether a partial fill occurs.
   * FillEngine adds broker-level fees on top.
   */
  fill(
    req:   ExecutionRequest,
    quote: {
      bid:       number;
      ask:       number;
      mid:       number;
      symbol:    string;
      spread:    number;
      changePct: number;
      ts?:       string;
    },
  ): FillResult {
    const result = this.liquidityProvider.executeMarketOrder(
      req.symbol,
      req.side,
      req.quantity,
      quote,
    );

    const feeBps = feeBpsFor(req.symbol);
    const fees   = Number(
      ((result.filledQuantity * result.averagePrice * feeBps) / 10_000).toFixed(2)
    );

    return {
      averagePrice:      result.averagePrice,
      filledQuantity:    result.filledQuantity,
      remainingQuantity: result.remainingQuantity,
      slippage:          result.slippage,
      fees,
      liquidityConsumed: result.liquidityConsumed,
      partialFill:       result.partialFill,
    };
  }

  /**
   * Calculate fill for a limit order (triggered STOP_LIMIT second leg).
   * Fills at limitPrice exactly using the LP's executeLimitOrder contract.
   */
  fillLimit(
    symbol:     string,
    side:       "BUY" | "SELL",
    quantity:   number,
    limitPrice: number,
    quote: {
      symbol: string;
      bid:    number;
      ask:    number;
      mid:    number;
    },
  ): FillResult {
    const result = this.liquidityProvider.executeLimitOrder(
      symbol,
      side,
      quantity,
      limitPrice,
      quote,
    );

    const feeBps = feeBpsFor(symbol);
    const fees   = Number(
      ((result.filledQuantity * result.averagePrice * feeBps) / 10_000).toFixed(2)
    );

    return {
      averagePrice:      result.averagePrice,
      filledQuantity:    result.filledQuantity,
      remainingQuantity: result.remainingQuantity,
      slippage:          result.slippage,
      fees,
      liquidityConsumed: result.liquidityConsumed,
      partialFill:       result.partialFill,
    };
  }

  /**
   * Liquidation-path fill from a pre-built book snapshot.
   *
   * Always uses the internal B-book provider regardless of the configured
   * execution venue — emergency liquidations must be internalized.
   * The book is pre-built by LiquidationEngine to avoid a second quoteCache
   * lookup between margin calculation and the fill.
   */
  fillFromBook(book: LiquidityBook, side: "BUY" | "SELL", quantity: number): FillResult {
    const result  = LiquidityProvider.calculateFillFromBook(book, side, quantity);
    const feeBps  = feeBpsFor(book.symbol);
    const fees    = Number(
      ((result.filledQuantity * result.averagePrice * feeBps) / 10_000).toFixed(2)
    );

    return {
      averagePrice:      result.averagePrice,
      filledQuantity:    result.filledQuantity,
      remainingQuantity: result.remainingQuantity,
      slippage:          result.slippage,
      fees,
      liquidityConsumed: result.liquidityConsumed,
      partialFill:       result.partialFill,
    };
  }

  /** The currently configured LP provider identifier. Used for audit logs. */
  get providerId(): string {
    return this.liquidityProvider.providerId;
  }

  /** Whether the configured LP supports partial fills. */
  get supportsPartialFills(): boolean {
    return this.liquidityProvider.supportsPartialFills;
  }
}

export const fillEngine = new FillEngine();
