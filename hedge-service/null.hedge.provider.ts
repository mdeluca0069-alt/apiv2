/**
 * NullExternalHedgeProvider — the only IExternalHedgeProvider implementation
 * that exists today. Always rejects, honestly: there is no external LP,
 * prime broker, or FIX/REST outbound connectivity configured anywhere in
 * this system (confirmed: zero A-book/STP path to any external counterparty
 * in the repo). This is the correct default, not a placeholder bug — a
 * hedge order must never appear to succeed against a venue that doesn't
 * exist. See i.external.hedge.provider.ts for why this scaffold exists.
 */
import type { IExternalHedgeProvider, HedgeOrderRequest, HedgeFillResult } from "./i.external.hedge.provider.js";

export class NullExternalHedgeProvider implements IExternalHedgeProvider {
  readonly providerId = "NULL_PROVIDER";
  readonly isConfigured = false;

  async placeHedgeOrder(req: HedgeOrderRequest): Promise<HedgeFillResult> {
    return {
      status: "REJECTED",
      reason: `NO_EXTERNAL_LP_CONFIGURED: no external hedge provider is configured — ` +
              `${req.side} ${req.notional.toFixed(2)} ${req.symbol} was evaluated but not sent anywhere`,
    };
  }
}

export const externalHedgeProvider: IExternalHedgeProvider = new NullExternalHedgeProvider();
export default externalHedgeProvider;
