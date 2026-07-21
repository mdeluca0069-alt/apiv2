/**
 * position.valuation.ts — live notional valuation for a position.
 *
 * MARKET_DATA_FREEZE.md §0.3: five modules (exposure.analytics.ts,
 * client.exposure.limits.ts, concentration.guard.ts, var.engine.ts,
 * portfolio.intelligence.ts) each independently computed a position's
 * current notional as `quantity * (Position.markPrice ?? Position.entryPrice)`
 * -- a DB column refreshed only every 5s by PositionPriceMonitor, and (before
 * the position.price.monitor.ts §0.3 fix) capable of freezing at its
 * creation-time value forever on a transient DB error. margin.controller.ts
 * and risk.snapshot.service.ts already computed the equivalent live figure
 * from quoteCache directly -- within a single risk.engine.ts preTradeCheck()
 * call, margin used the live tick while these five used a DB column that
 * could be stale by anywhere from 5 seconds to (pre-fix) indefinitely.
 *
 * liveNotional() is the one shared implementation every consumer above now
 * calls, so "current notional value of a position" has exactly one
 * definition in the codebase instead of five copies that could drift.
 *
 * Falls back to entryPrice (never to 0) when quoteCache has no live quote
 * for the symbol -- deliberately different from margin.controller.ts's
 * PnL fallback (which contributes 0 for a symbol with no live quote,
 * conservative for a "how much additional money do you have" question).
 * For notional/exposure/concentration, 0 would UNDERSTATE real exposure and
 * could let a cap be silently bypassed by a position with a momentarily
 * missing quote -- entryPrice is always a real, known lower bound on that
 * position's capital commitment.
 */
import { quoteCache } from "./quote.cache.js";

export type ValuablePosition = {
  symbol:     string;
  quantity:   number;
  entryPrice: number;
};

export function liveNotional(position: ValuablePosition): number {
  const quote = quoteCache.get(position.symbol);
  const price = quote?.mid ?? position.entryPrice;
  return position.quantity * price;
}

/** Live mark price for a symbol, falling back to entryPrice when no live quote exists. */
export function liveMarkPrice(symbol: string, entryPrice: number): number {
  return quoteCache.get(symbol)?.mid ?? entryPrice;
}
