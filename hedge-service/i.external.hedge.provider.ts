/**
 * IExternalHedgeProvider — contract for a real external LP/prime-broker
 * counterparty the house could trade against to offset its own book risk.
 *
 * FASE 3.8 (Group D): this interface has exactly one implementation today —
 * NullExternalHedgeProvider (null.hedge.provider.ts), which always rejects.
 * There is no external LP relationship, credit line, or FIX/REST connectivity
 * configured anywhere in this system; building one is a business/infra
 * decision (credentials, capital, a real counterparty), not a coding task.
 * This interface exists so the hedge-decision policy and audit trail
 * (hedge.policy.ts, hedge.queue.ts, the HedgeOrder table) are real and
 * end-to-end wired now, ready to accept a genuine adapter later without
 * touching any of the calling code.
 *
 * Deliberately NOT the same shape as ILiquidityProvider
 * (liquidity-engine/i.liquidity.provider.ts): that interface's
 * executeMarketOrder/executeLimitOrder return a fill SYNCHRONOUSLY, correct
 * for the in-process internal B-book but wrong for a real external venue,
 * which fills over a network round trip (FIX/REST) and may not fill at all.
 * placeHedgeOrder() below is async and can genuinely reject.
 */

export type HedgeOrderRequest = {
  symbol:   string;
  side:     "BUY" | "SELL"; // the side the HOUSE would trade externally to flatten its book
  notional: number;
  quantity?: number;        // best-effort, derived from the live quote at decision time
};

export type HedgeFillResult =
  | { status: "SUBMITTED"; externalRef: string }
  | { status: "REJECTED";  reason: string };

export interface IExternalHedgeProvider {
  /** Provider identifier used in audit logs and the HedgeOrder table. */
  readonly providerId: string;

  /** False for every provider until a real external LP is actually configured. */
  readonly isConfigured: boolean;

  /**
   * Attempt to place a hedge order with this provider.
   * MUST always resolve (never reject/throw) — a failed hedge is a REJECTED
   * result, not an exception, since the caller (hedge.queue.ts) needs to
   * persist the outcome either way.
   */
  placeHedgeOrder(req: HedgeOrderRequest): Promise<HedgeFillResult>;
}
