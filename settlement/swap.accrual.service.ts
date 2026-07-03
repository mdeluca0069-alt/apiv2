/**
 * SwapAccrualService — nightly overnight financing charge processing.
 *
 * Runs at 22:00 UTC via main.ts scheduler.
 *
 * For each OPEN position:
 *   1. Calculate per-night swap (with Wednesday 3× multiplier for FX/commodities)
 *   2. Write SwapAccrual row + LedgerEntry + wallet.balance update in ONE ATOMIC
 *      transaction so a mid-process crash cannot create a ledger/wallet split.
 *   3. Emit event for WebSocket notification.
 *
 * Idempotency:
 *   The unique constraint on (positionId, accrualDate) prevents double-charging
 *   if the scheduler fires twice within the same UTC day.  Idempotency is checked
 *   INSIDE the transaction so the check-and-insert is itself atomic.
 *
 * Wednesday 3× rule:
 *   FX and commodity markets settle T+2.  A position rolled over Wednesday
 *   22:00 UTC incurs 3 nights of swap (covers Saturday + Sunday settlement).
 *   Indices, equities, and crypto are charged 1× on all nights.
 */

import { randomUUID }          from "node:crypto";
import { Decimal }             from "@prisma/client/runtime/library";
import { Prisma }              from "@prisma/client";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { quoteCache }          from "../market-data/quote.cache.js";
import { swapCalculator }      from "../trading-service/swap.calculator.js";
import { assetClassOf }        from "../liquidity-engine/liquidity.provider.js";
import { eventBus }            from "../events-bus/event.bus.js";
import { DistributedJobLock }  from "../shared/distributed.job.lock.js";

export type AccrualSummary = {
  date:               string;
  positionsProcessed: number;
  totalSwapUsd:       number;
  errors:             number;
};

/** Asset classes that use the Wednesday 3× rollover rule (T+2 settlement). */
const TRIPLE_SWAP_CLASSES = new Set(["FX_MAJOR", "FX_MINOR", "COMMODITY"]);

/**
 * Returns the number of nights to charge for TODAY's rollover.
 * Wednesday = 3 for FX/commodities (covers Saturday + Sunday settlement).
 * All other days = 1.
 */
function nightsForToday(symbol: string): number {
  const utcDow   = new Date().getUTCDay();          // 0=Sun, 3=Wed, 6=Sat
  const ac       = assetClassOf(symbol.toUpperCase());
  const isTriple = utcDow === 3 && TRIPLE_SWAP_CLASSES.has(ac);
  return isTriple ? 3 : 1;
}

export class SwapAccrualService {

  /**
   * Process nightly swap for all open positions.
   * Called once per day at rollover (22:00 UTC).
   * Uses Redis leader election so only one worker per cluster runs this.
   */
  async accrueAll(): Promise<AccrualSummary> {
    if (!IS_PERSISTENT || !prisma?.position) {
      return { date: today(), positionsProcessed: 0, totalSwapUsd: 0, errors: 0 };
    }

    // Leader election: only one worker across the cluster runs the nightly sweep.
    // TTL = 10 min; renewal every 3 min for resilience on large position sets.
    // If Redis is unavailable, all workers run — idempotency (unique constraint
    // on positionId+accrualDate) prevents double-charging.
    const lock = new DistributedJobLock("swap-accrual-nightly", 600);
    if (!(await lock.tryAcquire())) {
      return { date: today(), positionsProcessed: 0, totalSwapUsd: 0, errors: 0 };
    }
    const _renewal = lock.startRenewal(180);

    const db          = prisma as NonNullable<typeof prisma>;
    const accrualDate = new Date(today() + "T00:00:00Z");

    try {
      const positions = await db.position.findMany({
        where:  { status: "OPEN" },
        select: {
          id:       true,
          userId:   true,
          symbol:   true,
          side:     true,
          quantity: true,
          openedAt: true,
        },
      });

      let processed = 0;
      let totalSwap = 0;
      let errors    = 0;

      for (const pos of positions) {
        try {
          const charged = await this.accruePosition(pos, accrualDate);
          totalSwap += charged;
          if (charged !== 0) processed++;
        } catch (err) {
          errors++;
          console.error(`[swap-accrual] position ${pos.id}:`, (err as Error).message);
        }
      }

      console.log(
        `[swap-accrual] ${today()} — processed=${processed} ` +
        `totalSwap=${totalSwap.toFixed(2)} errors=${errors}`,
      );
      return { date: today(), positionsProcessed: processed, totalSwapUsd: totalSwap, errors };
    } finally {
      clearInterval(_renewal);
      await lock.release();
    }
  }

  /**
   * Accrue swap for a single position in ONE atomic Serializable transaction.
   *
   * The idempotency check, SwapAccrual row, LedgerEntry, and wallet.balance
   * update all happen inside the same transaction.  A crash at any point
   * either leaves all records or none — no partial state is possible.
   *
   * @returns the swap amount charged (negative = debit, positive = credit, 0 = skip)
   */
  async accruePosition(
    pos: {
      id:       string;
      userId:   string;
      symbol:   string;
      side:     string;
      quantity: { toNumber(): number };
      openedAt: Date;
    },
    accrualDate: Date = new Date(today() + "T00:00:00Z"),
  ): Promise<number> {
    if (!IS_PERSISTENT || !prisma?.swapAccrual) return 0;
    const db = prisma as NonNullable<typeof prisma>;

    const quote    = quoteCache.get(pos.symbol);
    const midPrice = quote?.mid ?? 0;
    if (midPrice <= 0) return 0; // no live price — skip, retry next cycle

    const qty  = pos.quantity.toNumber();
    const side = pos.side as "BUY" | "SELL";

    // Per-night rate (1 day's financing, without Wednesday multiplier).
    const perNightRate = swapCalculator.preview(pos.symbol, side, qty, midPrice);
    if (perNightRate === 0) return 0;

    // Apply Wednesday 3× rule for FX/commodities.
    const nights      = nightsForToday(pos.symbol);
    const chargeAmount = Number((perNightRate * nights).toFixed(8));

    const rateAnnual = swapCalculator.compute({
      symbol:  pos.symbol,
      side,
      quantity: qty,
      midPrice,
      openedAt: pos.openedAt,
    }).rateAnnual;

    const reference = `SWAP:${pos.id}:${today()}`;
    const isDebit   = chargeAmount < 0;

    // Single Serializable transaction: idempotency check + all writes.
    // If the process crashes mid-write, PostgreSQL rolls everything back —
    // no partial ledger/wallet state is possible.
    const result = await db.$transaction(async (tx) => {
      // ── Idempotency: check inside the transaction ───────────────────────
      const alreadyDone = await tx.swapAccrual.findFirst({
        where:  { positionId: pos.id, accrualDate },
        select: { id: true },
      });
      if (alreadyDone) return 0;

      // ── 1. SwapAccrual record ───────────────────────────────────────────
      await tx.swapAccrual.create({
        data: {
          positionId:     pos.id,
          userId:         pos.userId,
          symbol:         pos.symbol,
          side:           pos.side,
          swapAmount:     new Decimal(chargeAmount),
          swapRateAnnual: new Decimal(rateAnnual),
          nights,
          accrualDate,
        },
      });

      // ── 2. LedgerEntry ──────────────────────────────────────────────────
      await tx.ledgerEntry.create({
        data: {
          id:            randomUUID(),
          userId:        pos.userId,
          currency:      "USD",
          amount:        new Decimal(chargeAmount),
          type:          "SWAP",
          reference,
          status:        "COMPLETED",
          note: `Overnight ${isDebit ? "financing charge" : "credit"} for ` +
                `${pos.symbol} ${side}${nights > 1 ? ` (${nights}× Wednesday roll)` : ""} ` +
                `(${rateAnnual.toFixed(2)}% p.a.)`,
          debitAccount:  isDebit ? `CLIENT:${pos.userId}` : "BROKER_SWAP",
          creditAccount: isDebit ? "BROKER_SWAP"          : `CLIENT:${pos.userId}`,
        },
      });

      // ── 3. Wallet balance update ────────────────────────────────────────
      // This is in the SAME transaction as the ledger entry, so they are
      // always consistent: either both exist or neither exists.
      await tx.walletAccount.update({
        where: { userId: pos.userId },
        data:  { balance: { increment: new Decimal(chargeAmount) } },
      });

      return chargeAmount;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: 15000 });

    if (result !== 0) {
      eventBus.emit("swap.accrued", {
        userId:      pos.userId,
        positionId:  pos.id,
        symbol:      pos.symbol,
        swap:        result,
        accrualDate: accrualDate.toISOString(),
      });
    }

    return result;
  }
}

export const swapAccrualService = new SwapAccrualService();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
