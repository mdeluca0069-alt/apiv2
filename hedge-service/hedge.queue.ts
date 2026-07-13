/**
 * HedgeQueue — evaluates house exposure and records a HedgeOrder row per
 * FASE 3.8's scaffold. With the only IExternalHedgeProvider implementation
 * being NullExternalHedgeProvider, every row this creates today resolves to
 * status=REJECTED, providerId=NULL_PROVIDER, immediately (no real network
 * round trip exists to wait on) — this is expected, not a bug. The value
 * today is the decision log itself: a queryable, timestamped record of what
 * WOULD have been hedged and why, useful for evaluating whether a real LP
 * integration is worth building later.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { exposureRegistry }      from "../risk-service/exposure.limits.js";
import { quoteCache }            from "../market-data/quote.cache.js";
import { evaluateHedgeNeed }     from "./hedge.policy.js";
import { externalHedgeProvider } from "./null.hedge.provider.js";
import type { IExternalHedgeProvider } from "./i.external.hedge.provider.js";

export type HedgeSweepResult = {
  evaluated: number;
  queued:    number;
};

export class HedgeQueue {
  constructor(private readonly provider: IExternalHedgeProvider = externalHedgeProvider) {}

  /**
   * Evaluate every tracked instrument's current exposure and record a
   * HedgeOrder for any that cross the policy threshold — skipping a symbol
   * that already has an unresolved (SUBMITTED) row, so a sweep never queues
   * duplicates for the same still-open recommendation. Never throws: a
   * per-symbol failure is logged and the sweep continues.
   */
  async runSweep(): Promise<HedgeSweepResult> {
    if (!IS_PERSISTENT) return { evaluated: 0, queued: 0 };

    const snapshots = exposureRegistry.getAll();
    let queued = 0;

    for (const snapshot of snapshots) {
      const rec = evaluateHedgeNeed(snapshot);
      if (!rec) continue;

      try {
        const didQueue = await this._enqueueIfNeeded(rec);
        if (didQueue) queued += 1;
      } catch (err) {
        console.error(`[hedge-queue] failed to evaluate ${snapshot.symbol}:`, (err as Error).message);
      }
    }

    return { evaluated: snapshots.length, queued };
  }

  /** Returns false without writing anything if an unresolved hedge already
   *  exists for this symbol (SUBMITTED — there is nothing new to record). */
  private async _enqueueIfNeeded(rec: NonNullable<ReturnType<typeof evaluateHedgeNeed>>): Promise<boolean> {
    const db = prisma as NonNullable<typeof prisma>;

    const existing = await db.hedgeOrder.findFirst({
      where: { symbol: rec.symbol, status: "SUBMITTED" },
    });
    if (existing) return false;

    const quote    = quoteCache.get(rec.symbol);
    const quantity = quote?.mid ? rec.notional / quote.mid : undefined;

    const result = await this.provider.placeHedgeOrder({
      symbol:   rec.symbol,
      side:     rec.side,
      notional: rec.notional,
      quantity,
    });

    await db.hedgeOrder.create({
      data: {
        symbol:      rec.symbol,
        side:        rec.side,
        notional:    rec.notional,
        quantity:    quantity ?? null,
        status:      result.status,
        providerId:  this.provider.providerId,
        reason:      result.status === "REJECTED" ? `${rec.reason} — ${result.reason}` : rec.reason,
        externalRef: result.status === "SUBMITTED" ? result.externalRef : null,
        resolvedAt:  new Date(),
      },
    });

    return true;
  }
}

export const hedgeQueue = new HedgeQueue();
export default hedgeQueue;
