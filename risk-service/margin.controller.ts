import { randomUUID } from "node:crypto";
import { Decimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";
import { prisma } from "../shared/db.js";
import type { MarginState } from "../shared/contracts.js";

/** See order.lifecycle.ts — same composability contract. */
type Db = Prisma.TransactionClient | typeof prisma;

export class MarginController {
  async getMarginState(userId: string): Promise<MarginState> {
    const [wallet, openPositions] = await Promise.all([
      prisma.walletAccount.findUnique({ where: { userId } }),
      prisma.position.findMany({
        where:  { userId, status: "OPEN" },
        select: { marginUsed: true, pnl: true },
      }),
    ]);

    if (!wallet) throw new Error(`WALLET_NOT_FOUND:${userId}`);

    const balance       = wallet.balance.toNumber();
    const marginUsed    = openPositions.reduce((s: number, p) => s + p.marginUsed.toNumber(), 0);
    const unrealizedPnl = openPositions.reduce((s: number, p) => s + p.pnl.toNumber(), 0);
    const equity        = balance + unrealizedPnl;
    const freeMargin    = equity - marginUsed;
    const marginLevelPct =
      marginUsed > 0 ? (equity / marginUsed) * 100 : Number.POSITIVE_INFINITY;

    return { userId, balance, equity, marginUsed, freeMargin, marginLevelPct, unrealizedPnl };
  }

  canAcceptOrder(state: MarginState, additionalMargin: number): boolean {
    return state.freeMargin >= additionalMargin && state.equity > 0;
  }

  /**
   * Atomically checks margin availability then locks it.
   *
   * Concurrency is provided by SELECT ... FOR UPDATE on the wallet row, which
   * serializes concurrent margin-lock attempts per user under plain
   * ReadCommitted isolation — no Serializable/SSI retry loop needed, and no
   * risk of the position range-scan false positives SSI can produce.
   *
   * Returns { ok: true } on success or { ok: false, reason } if the
   * margin is no longer available (race was won by another order).
   *
   * FASE 2.2: pass `db` (an already-open Prisma.TransactionClient) to compose
   * this check-and-lock into a larger caller-owned transaction (see
   * execution.engine.ts, where it now runs in the same transaction as position
   * creation and the FILLED transition — a failure anywhere in that unit rolls
   * back the margin lock too, instead of leaving orphaned locked margin behind).
   * Omit `db` for the original standalone behavior (own transaction, unchanged
   * for any other caller).
   */
  async checkAndLockMargin(
    userId:   string,
    orderId:  string,
    required: number,
    db?: Db,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const run = async (tx: Db): Promise<{ ok: true } | { ok: false; reason: string }> => {
      // FASE 2.2/2.3 perf: the conditional wallet UPDATE and the MARGIN_LOCK
      // ledger INSERT are one round trip via a data-modifying CTE, instead of
      // two separate statements. The INSERT's SELECT ... FROM locked draws
      // its row from the UPDATE's own RETURNING — if the WHERE clause matched
      // 0 rows (insufficient margin), `locked` is empty and the INSERT
      // naturally inserts nothing too, so this stays all-or-nothing with one
      // round trip either way. This matters more than usual now: this runs
      // inside execution.engine.ts's unified transaction (FASE 2.2) while
      // holding the FASE 2.3 per-symbol advisory lock, so every round trip
      // shaved off here directly shortens how long that lock — and therefore
      // every other order queued behind it for the same symbol — is held.
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        WITH locked AS (
          UPDATE "WalletAccount"
          SET locked = locked + ${new Decimal(required)}
          WHERE "userId" = ${userId}
            AND balance > 0
            AND (balance - locked) >= ${new Decimal(required)}
          RETURNING "userId"
        )
        INSERT INTO "LedgerEntry"
          (id, "userId", currency, amount, type, reference, status, note, "debitAccount", "creditAccount")
        SELECT
          ${randomUUID()}, locked."userId", 'USD', ${new Decimal(-required)}, 'MARGIN_LOCK', ${orderId},
          'COMPLETED', ${`Margin locked for order ${orderId}`},
          ${`CLIENT_FREE:${userId}`}, ${`CLIENT_MARGIN:${userId}`}
        FROM locked
        RETURNING id
      `;

      if (inserted.length === 0) {
        // Off the hot path — only reached on rejection, to produce a precise
        // reason. A plain read is fine here (no FOR UPDATE needed): worst
        // case a concurrent change makes the message slightly stale, but the
        // conditional UPDATE above is what actually decided the outcome.
        const rows = await tx.$queryRaw<Array<{ balance: string; locked: string }>>`
          SELECT balance, locked FROM "WalletAccount" WHERE "userId" = ${userId}
        `;
        if (rows.length === 0) return { ok: false as const, reason: `WALLET_NOT_FOUND:${userId}` };
        const available = parseFloat(rows[0].balance) - parseFloat(rows[0].locked);
        return {
          ok:     false as const,
          reason: `INSUFFICIENT_MARGIN: need ${required.toFixed(2)}, available=${available.toFixed(2)}`,
        };
      }

      return { ok: true as const };
    };

    try {
      if (db) return await run(db);
      return await prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 3000, timeout: 8000 });
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  /**
   * Locks margin for a newly created order.
   * @deprecated Use checkAndLockMargin for atomic check+lock.
   */
  async lockMargin(userId: string, orderId: string, amount: number): Promise<void> {
    const result = await this.checkAndLockMargin(userId, orderId, amount);
    if (!result.ok) throw new Error(result.reason);
  }

  /**
   * Releases margin back to free balance when a position closes.
   *
   * Uses FOR UPDATE on the wallet row to:
   *   1. Prevent concurrent releases from racing each other to a negative locked value.
   *   2. Clamp the release to the actual current locked amount (safe against orphan-release).
   */
  async releaseMargin(userId: string, positionId: string, amount: number): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT locked FROM "WalletAccount" WHERE "userId" = ${userId} FOR UPDATE
      `;
      const currentLocked = rows[0] ? parseFloat(rows[0].locked) : 0;
      const safeRelease   = Math.max(0, Math.min(currentLocked, amount));

      if (safeRelease === 0) return; // already released or wallet missing

      await tx.walletAccount.update({
        where: { userId },
        data:  { locked: { decrement: new Decimal(safeRelease) } },
      });

      await tx.ledgerEntry.create({
        data: {
          id:            randomUUID(),
          userId,
          currency:      "USD",
          amount:        safeRelease,
          type:          "MARGIN_RELEASE",
          reference:     positionId,
          status:        "COMPLETED",
          note:          `Margin released for closed position ${positionId}`,
          debitAccount:  `CLIENT_MARGIN:${userId}`,
          creditAccount: `CLIENT_FREE:${userId}`,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 3000, timeout: 8000 });
  }

  async updatePositionPnl(
    positionId: string,
    markPrice:  number,
    pnl:        number,
    pnlPercent: number,
  ): Promise<void> {
    await prisma.position.update({
      where: { id: positionId },
      data:  {
        markPrice:  new Decimal(markPrice),
        pnl:        new Decimal(pnl),
        pnlPercent: new Decimal(pnlPercent),
      },
    });
  }

  async snapshotMargin(userId: string, triggerReason: string): Promise<void> {
    const state = await this.getMarginState(userId);
    const safeLevel = Number.isFinite(state.marginLevelPct)
      ? state.marginLevelPct
      : 9999;

    await prisma.marginSnapshot.create({
      data: {
        userId,
        equity:         new Decimal(state.equity),
        balance:        new Decimal(state.balance),
        marginUsed:     new Decimal(state.marginUsed),
        freeMargin:     new Decimal(state.freeMargin),
        marginLevelPct: new Decimal(safeLevel),
        unrealizedPnl:  new Decimal(state.unrealizedPnl),
        triggerReason,
      },
    });
  }
}

export const marginController = new MarginController();
