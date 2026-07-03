/**
 * DailySnapshotService — end-of-day account state persistence.
 *
 * Persists one AccountDailySnapshot row per user per calendar day.
 * The snapshot captures the account state at the time of the call
 * (intended to run at 22:00 UTC, before the rollover).
 *
 * Schedule: run via setInterval or an external cron (00:00 UTC next day,
 * covering the 22:00 UTC rollover window).
 *
 * Idempotent: if a snapshot for today already exists it is UPSERTED
 * (last-write wins) so the service can safely be called multiple times.
 */

import { Decimal }              from "@prisma/client/runtime/library";
import { prisma }               from "../shared/db.js";
import { quoteCache }           from "../market-data/quote.cache.js";
import { DistributedJobLock }   from "../shared/distributed.job.lock.js";

export type SnapshotSummary = {
  date:         string;
  usersSnapped: number;
  errors:       number;
};

export class DailySnapshotService {
  /**
   * Snapshot all users who have a wallet account.
   * Designed to be called once per day at EOD rollover.
   * Uses Redis leader election so only one worker per cluster runs this.
   */
  async snapshotAll(): Promise<SnapshotSummary> {
    if (!prisma?.walletAccount) return { date: today(), usersSnapped: 0, errors: 0 };

    // Leader election: TTL = 15 min, renewal every 4 min.
    // If Redis is unavailable, all workers run — snapshotUser is idempotent via upsert.
    const lock = new DistributedJobLock("daily-snapshot-eod", 900);
    if (!(await lock.tryAcquire())) {
      return { date: today(), usersSnapped: 0, errors: 0 };
    }
    const renewal = lock.startRenewal(240);

    try {
      const wallets = await (prisma as NonNullable<typeof prisma>).walletAccount.findMany({
        select: { userId: true },
      });

      let snapped = 0;
      let errors  = 0;
      const date  = today();

      for (const { userId } of wallets) {
        try {
          await this.snapshotUser(userId, date);
          snapped++;
        } catch (err) {
          errors++;
          console.error(`[daily-snapshot] failed for userId=${userId}:`, (err as Error).message);
        }
      }

      console.log(`[daily-snapshot] ${date} — snapped=${snapped} errors=${errors}`);
      return { date, usersSnapped: snapped, errors };
    } finally {
      clearInterval(renewal);
      await lock.release();
    }
  }

  /**
   * Snapshot a single user.
   * @param date ISO date string "YYYY-MM-DD" (defaults to today UTC).
   */
  async snapshotUser(userId: string, date = today()): Promise<void> {
    if (!prisma?.walletAccount) return;

    const db = prisma as NonNullable<typeof prisma>;

    const [wallet, openPositions, closedToday] = await Promise.all([
      db.walletAccount.findUnique({
        where:  { userId },
        select: { balance: true, locked: true },
      }),
      db.position.findMany({
        where:  { userId, status: "OPEN" },
        select: { marginUsed: true, pnl: true, entryPrice: true, quantity: true, side: true, symbol: true },
      }),
      db.position.count({
        where: {
          userId,
          status:   "CLOSED",
          closedAt: { gte: startOfDay(date), lt: endOfDay(date) },
        },
      }),
    ]);

    if (!wallet) return; // user has no wallet yet

    const balance  = wallet.balance.toNumber();
    const locked   = wallet.locked.toNumber();

    // Mark-to-market unrealized P&L using current quoteCache
    let unrealizedPnl = 0;
    for (const pos of openPositions) {
      const quote = quoteCache.get(pos.symbol);
      if (!quote) {
        // Fall back to stored pnl field if no live quote
        unrealizedPnl += pos.pnl.toNumber();
        continue;
      }
      const markPrice = pos.side === "BUY" ? quote.bid : quote.ask;
      const direction = pos.side === "BUY" ? 1 : -1;
      unrealizedPnl  += (markPrice - pos.entryPrice.toNumber()) * pos.quantity.toNumber() * direction;
    }

    const equity     = balance + unrealizedPnl;
    const freeMargin = Math.max(0, equity - locked);

    // Sum of P&L settlements completed today
    const pnlToday = await db.ledgerEntry.aggregate({
      where: {
        userId,
        type:      "PNL_SETTLEMENT",
        status:    "COMPLETED",
        createdAt: { gte: startOfDay(date), lt: endOfDay(date) },
      },
      _sum: { amount: true },
    });

    const feesToday = await db.ledgerEntry.aggregate({
      where: {
        userId,
        type:      { in: ["COMMISSION", "FEE"] },
        status:    "COMPLETED",
        createdAt: { gte: startOfDay(date), lt: endOfDay(date) },
      },
      _sum: { amount: true },
    });

    const swapsToday = await db.ledgerEntry.aggregate({
      where: {
        userId,
        type:      "SWAP",
        status:    "COMPLETED",
        createdAt: { gte: startOfDay(date), lt: endOfDay(date) },
      },
      _sum: { amount: true },
    });

    const snapshotDate = new Date(date + "T00:00:00Z");

    await db.accountDailySnapshot.upsert({
      where:  { userId_snapshotDate: { userId, snapshotDate } },
      create: {
        userId,
        snapshotDate,
        balance:        new Decimal(balance),
        equity:         new Decimal(equity),
        marginUsed:     new Decimal(locked),
        freeMargin:     new Decimal(freeMargin),
        unrealizedPnl:  new Decimal(unrealizedPnl),
        realizedPnlDay: new Decimal(pnlToday._sum.amount?.toNumber() ?? 0),
        totalFeesDay:   new Decimal(Math.abs(feesToday._sum.amount?.toNumber() ?? 0)),
        totalSwapsDay:  new Decimal(swapsToday._sum.amount?.toNumber() ?? 0),
        openPositions:  openPositions.length,
        closedToday,
      },
      update: {
        balance:        new Decimal(balance),
        equity:         new Decimal(equity),
        marginUsed:     new Decimal(locked),
        freeMargin:     new Decimal(freeMargin),
        unrealizedPnl:  new Decimal(unrealizedPnl),
        realizedPnlDay: new Decimal(pnlToday._sum.amount?.toNumber() ?? 0),
        totalFeesDay:   new Decimal(Math.abs(feesToday._sum.amount?.toNumber() ?? 0)),
        totalSwapsDay:  new Decimal(swapsToday._sum.amount?.toNumber() ?? 0),
        openPositions:  openPositions.length,
        closedToday,
      },
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function startOfDay(date: string): Date {
  return new Date(date + "T00:00:00Z");
}

function endOfDay(date: string): Date {
  return new Date(date + "T23:59:59.999Z");
}

export const dailySnapshotService = new DailySnapshotService();
