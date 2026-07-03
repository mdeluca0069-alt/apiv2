/**
 * ILiquidityProvider — contract for all liquidity execution backends.
 *
 * The interface decouples the execution engine from a specific venue.
 * The current production implementation is InternalBBookProvider (B-book).
 * Future implementations: OneZero adapter, PrimeXM adapter, B2Broker adapter.
 *
 * Contract rules:
 *   - executeMarketOrder MUST be deterministic for the same inputs (no random fills).
 *   - executeLimitOrder returns a fill at limitPrice or better, or throws if no fill possible.
 *   - cancelOrder is idempotent (cancelling an already-cancelled order is a no-op, returns true).
 *   - All methods MUST resolve; never reject silently (throw with a descriptive message).
 */

import type { Quote } from "../shared/contracts.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

export type ProviderFillResult = {
  /** Weighted-average execution price across all fill legs. */
  averagePrice:      number;
  /** Quantity actually filled in this call (≤ requested quantity). */
  filledQuantity:    number;
  /** Quantity remaining unfilled (0 for full fills). */
  remainingQuantity: number;
  /** Absolute slippage vs. the reference price at request time (always ≥ 0). */
  slippage:          number;
  /** Notional consumed from the provider's book. */
  liquidityConsumed: number;
  /** True when filledQuantity < requested quantity. */
  partialFill:       boolean;
  /** Provider identifier for audit and routing logs. */
  provider:          string;
};

export type LiquidityQuote = {
  symbol:    string;
  bid:       number;
  ask:       number;
  spread:    number;
  provider:  string;
  timestamp: string;
};

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ILiquidityProvider {
  /** Provider identifier used in audit logs and routing decisions. */
  readonly providerId: string;

  /**
   * Retrieve the current best bid/ask from this provider.
   * Returns null if the provider has no quote for the symbol.
   */
  getQuote(symbol: string): LiquidityQuote | null;

  /**
   * Execute a market order immediately at the best available price.
   * The provider MAY return a partial fill if its book cannot absorb the full quantity.
   */
  executeMarketOrder(
    symbol:   string,
    side:     "BUY" | "SELL",
    quantity: number,
    quote:    Pick<Quote, "symbol" | "bid" | "ask" | "mid">,
  ): ProviderFillResult;

  /**
   * Execute a limit order at limitPrice or better.
   * Returns a fill if the current market price crosses the limit; throws otherwise.
   * Used by STOP_LIMIT second-leg execution and triggered limit fills.
   */
  executeLimitOrder(
    symbol:     string,
    side:       "BUY" | "SELL",
    quantity:   number,
    limitPrice: number,
    quote:      Pick<Quote, "symbol" | "bid" | "ask" | "mid">,
  ): ProviderFillResult;

  /**
   * Cancel a pending order at the provider level.
   * Idempotent — returns true even if the order was already cancelled.
   */
  cancelOrder(orderId: string): Promise<boolean>;

  /**
   * Whether this provider supports partial fills.
   * When false, the execution engine must not send orders larger than provider capacity.
   */
  readonly supportsPartialFills: boolean;

  /**
   * Maximum notional (in USD) this provider will fill in a single execution.
   * Undefined means no limit (fill any size). The execution engine uses this
   * to split oversized orders into legs when supportsPartialFills is false.
   */
  readonly maxSingleFillNotional?: number;
}
