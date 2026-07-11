/**
 * RequotePolicy — protects a MARKET order from filling against a price
 * meaningfully different from the one it was actually based on.
 *
 * FASE 3.3 (Internal Liquidity Engine). The gap this closes: order.controller.ts
 * captures a quote ONCE, at placeOrder() (before the pre-trade risk check),
 * and that same captured quote is threaded through the per-user execution
 * queue (execution.queue.ts, up to ~15-27s of contention under load) all
 * the way into fillEngine.fill() / InternalLiquidityProvider.calculateFill()
 * — which uses it AS-IS, with no re-fetch, no freshness check, nothing.
 * A client could be filled at a price computed from a quote that's several
 * seconds stale by the time the fill actually happens, without ever being
 * told the market moved.
 *
 * This is a genuinely different problem from:
 *   - `risk-service/symbol.circuit.breaker.ts` (FASE 3.2) — halts an entire
 *     symbol on an abnormal 10s-window move, a market-wide event.
 *   - the pre-existing quoteCache.isStale() check — that's about a feed
 *     gone SILENT (no ticks for 6 minutes), not about normal ticks simply
 *     having moved the price since this one order's quote was captured.
 *
 * Policy: right before the fill price is computed (execution.engine.ts,
 * before fillEngine.fill()), compare the ORIGINAL captured quote against a
 * FRESH read of quoteCache for the same symbol. If the side-relevant price
 * (ask for BUY, bid for SELL — the side that actually determines what the
 * client pays/receives) moved more than the asset class's tolerance, reject
 * with REQUOTE instead of silently filling at the drifted price. The client
 * resubmits and gets a fresh quote — this system executes synchronously
 * with no hold-and-confirm step, so "requote" here means "reject and let
 * the client ask again with current data," not a two-step offer/accept
 * flow (that would need a new pending-quote state machine, a materially
 * bigger change than this phase's scope).
 */

import { assetClassOf } from "../liquidity-engine/liquidity.provider.js";

// Deliberately tighter than symbol.circuit.breaker.ts's halt thresholds
// (roughly half) — a requote should fire on ordinary queueing drift well
// before a move is extreme enough to justify halting the whole symbol.
const REQUOTE_TOLERANCE_PCT: Record<string, number> = {
  FX_MAJOR:  0.25,
  FX_MINOR:  0.35,
  INDEX:     0.50,
  COMMODITY: 0.65,
  CRYPTO:    1.50,
  EQUITY:    1.00,
};
const DEFAULT_REQUOTE_TOLERANCE_PCT = 0.75;

export type RequoteCheck = {
  requoted:  boolean;
  movePct:   number;
  threshold: number;
};

/**
 * @param symbol         instrument symbol (for asset-class-aware tolerance)
 * @param side           BUY uses ask, SELL uses bid — the side that
 *                        actually determines what the client pays/receives
 * @param originalQuote  the quote captured at order.controller.ts's
 *                        placeOrder(), before queueing
 * @param freshQuote     a fresh quoteCache read taken right before the fill
 *                        price is computed
 */
export function checkRequote(
  symbol:        string,
  side:          "BUY" | "SELL",
  originalQuote: { bid: number; ask: number },
  freshQuote:    { bid: number; ask: number },
): RequoteCheck {
  const originalPrice = side === "BUY" ? originalQuote.ask : originalQuote.bid;
  const freshPrice     = side === "BUY" ? freshQuote.ask    : freshQuote.bid;
  const movePct   = originalPrice > 0 ? Math.abs((freshPrice - originalPrice) / originalPrice) * 100 : 0;
  const threshold = REQUOTE_TOLERANCE_PCT[assetClassOf(symbol)] ?? DEFAULT_REQUOTE_TOLERANCE_PCT;

  return { requoted: movePct > threshold, movePct, threshold };
}
