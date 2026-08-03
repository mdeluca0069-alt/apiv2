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
import { immutableAudit }        from "../security/immutable.audit.js";
import { quoteCache }          from "../market-data/quote.cache.js";
import { swapCalculator }      from "../trading-service/swap.calculator.js";
import { assetClassOf }        from "../liquidity-engine/liquidity.provider.js";
import { eventBus }            from "../events-bus/event.bus.js";
import { metrics }             from "../gateway/metrics.js";
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
 * PHASE H (fresh due-diligence audit): the only asset class that genuinely
 * trades through the weekend -- every other class (FX, commodities,
 * indices, equities) is closed Saturday, exactly as
 * market-data/synthetic.seeder.ts already assumes ("FX trades 24h/5d, so
 * skip weekends in generation") and as trading-service/swap.calculator.ts's
 * own _countNights() already assumes (`if (dow !== 6)` -- "Skip Saturday
 * rollover (markets closed)"). This function previously did NOT skip
 * Saturday for anything, unconditionally charging 1 night of swap on every
 * open non-crypto position every Saturday -- quoteCache never expires
 * (see market-data/quote.cache.ts), so accruePosition()'s only guard
 * (`midPrice <= 0`) never caught this: Friday's stale-but-positive closing
 * price passed the check every time, so the charge was real, silent, and
 * recurred every week for every open position, permanently.
 */
const TWENTY_FOUR_SEVEN_CLASSES = new Set(["CRYPTO"]);

/**
 * Returns the number of nights to charge for the given accrual date's
 * rollover. Wednesday = 3 for FX/commodities (covers Saturday + Sunday
 * settlement). Saturday = 0 for every class except the 24/7 ones (crypto).
 * All other days = 1.
 *
 * PHASE H: takes `accrualDate` (the logical day being charged) instead of
 * reading wall-clock `now` -- the reference/note text a few lines below
 * this call site already derives from accrualDate specifically so a
 * future catch-up run for a missed day charges the right day's rate; this
 * function silently didn't honor that at all, always reading `new
 * Date().getUTCDay()` regardless of which day was actually being charged.
 */
function nightsForAccrualDate(symbol: string, accrualDate: Date): number {
  const utcDow = accrualDate.getUTCDay();            // 0=Sun, 3=Wed, 6=Sat
  const ac     = assetClassOf(symbol.toUpperCase());
  if (utcDow === 6 && !TWENTY_FOUR_SEVEN_CLASSES.has(ac)) return 0; // markets closed
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
          metrics.inc("swap_accrual_errors_total");
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

    // Apply Wednesday 3× rule for FX/commodities; Saturday = 0 for
    // everything but 24/7 asset classes (see nightsForAccrualDate's
    // docstring) -- skip entirely rather than writing a $0 SwapAccrual/
    // LedgerEntry row that would only add noise and needlessly consume
    // this position's idempotency slot for the day.
    const nights = nightsForAccrualDate(pos.symbol, accrualDate);
    if (nights === 0) return 0;
    const chargeAmount = Number((perNightRate * nights).toFixed(8));

    const rateAnnual = swapCalculator.compute({
      symbol:  pos.symbol,
      side,
      quantity: qty,
      midPrice,
      openedAt: pos.openedAt,
    }).rateAnnual;

    // Derived from accrualDate (the logical day being charged), not a fresh
    // today() call — a catch-up run for a missed day passes an earlier
    // accrualDate than the wall-clock date it actually runs on, and the
    // reference must reflect the day being charged, not the day it ran.
    const reference = `SWAP:${pos.id}:${accrualDate.toISOString().slice(0, 10)}`;
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

      // LEDGER_FREEZE.md §0.9: this recurring nightly charge had no Audit
      // trail and no Metrics at all -- not even a registered counter existed
      // for a successful accrual (swap_accrual_errors_total was registered
      // but, like this one, never actually incremented anywhere).
      await immutableAudit.write({
        actor:   "SYSTEM_SWAP_ACCRUAL",
        action:  "swap.accrued",
        entity:  pos.id,
        payload: { userId: pos.userId, symbol: pos.symbol, amount: chargeAmount, nights, rateAnnual, reference } as object,
      }, tx);

      return chargeAmount;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: 15000 });

    if (result !== 0) {
      metrics.inc("swap_accrual_total");
      // Event Bus: this emit is already durably captured by the event
      // archive (realtime-infra/event.archive.ts's ARCHIVED_EVENTS includes
      // "swap.accrued") -- not merely in-memory, contrary to what this
      // fix's own audit finding assumed without checking that file.
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
