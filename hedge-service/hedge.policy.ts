/**
 * hedge.policy.ts — pure decision function for FASE 3.8's hedge scaffold.
 *
 * Reuses risk-service/exposure.limits.ts's existing per-symbol netUsd limit
 * (the hard cap that already rejects new orders once breached) instead of
 * inventing a second, independently-tuned threshold table — this is
 * deliberately a "should the house proactively flatten" signal set BELOW
 * that hard cap, not a new limit of its own.
 */
import type { ExposureSnapshot } from "../risk-service/exposure.limits.js";

/** Recommend hedging once net exposure crosses this % of the instrument's
 *  netUsd limit — well before the hard cap (100%) that halts new orders. */
export const HEDGE_THRESHOLD_PCT = 60;

export type HedgeRecommendation = {
  symbol:   string;
  side:     "BUY" | "SELL"; // side the HOUSE would need to trade externally to flatten
  notional: number;         // the unhedged (net) notional to offset
  reason:   string;
} | null;

/**
 * netNotional is signed: positive means clients are net long (client BUY
 * exposure > SELL), which makes the house's own book net SHORT that
 * instrument (the house is the counterparty who sold to them) — a rising
 * price costs the house money. To flatten, the house needs to BUY
 * externally. The signs invert for netNotional < 0.
 */
export function evaluateHedgeNeed(snapshot: ExposureSnapshot): HedgeRecommendation {
  if (snapshot.netPct < HEDGE_THRESHOLD_PCT) return null;
  if (snapshot.netNotional === 0) return null;

  const side = snapshot.netNotional > 0 ? "BUY" : "SELL";

  return {
    symbol:   snapshot.symbol,
    side,
    notional: Math.abs(snapshot.netNotional),
    reason:   `net exposure ${snapshot.netPct.toFixed(1)}% of limit ` +
              `(threshold ${HEDGE_THRESHOLD_PCT}%) — house is net ${side === "BUY" ? "short" : "long"} this instrument`,
  };
}
