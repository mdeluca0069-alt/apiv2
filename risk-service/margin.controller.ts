import { randomUUID } from "node:crypto";
import { Decimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";
import { prisma } from "../shared/db.js";
import type { MarginState } from "../shared/contracts.js";

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
   * Runs under Serializable isolation so concurrent pre-trade reads cannot
   * both see sufficient free margin and then over-commit.
   *
   * Returns { ok: true } on success or { ok: false, reason } if the
   * margin is no longer available (race was won by another order).
   */
  async checkAndLockMargin(
    userId:   string,
    orderId:  string,
    required: number,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const result = await prisma.$transaction(async (tx) => {
        // SELECT FOR UPDATE acquires an exclusive row lock on the wallet.
        // This serializes concurrent margin-lock attempts per user without SSI,
        // eliminating the position range-scan that causes SSI false positives.
        const rows = await tx.$queryRaw<Array<{ balance: string; locked: string }>>`
          SELECT balance, locked
          FROM "WalletAccount"
          WHERE "userId" = ${userId}
          FOR UPDATE
        `;

        if (rows.length === 0) return { ok: false as const, reason: `WALLET_NOT_FOUND:${userId}` };

        const balance   = parseFloat(rows[0].balance);
        const locked    = parseFloat(rows[0].locked);
        const available = balance - locked;

        if (available < required || balance <= 0) {
          return {
            ok:     false as const,
            reason: `INSUFFICIENT_MARGIN: need ${required.toFixed(2)}, available=${available.toFixed(2)}`,
          };
        }

        await tx.walletAccount.update({
          where: { userId },
          data:  { locked: { increment: new Decimal(required) } },
        });

        await tx.ledgerEntry.create({
          data: {
            id:            randomUUID(),
            userId,
            currency:      "USD",
            amount:        -required,
            type:          "MARGIN_LOCK",
            reference:     orderId,
            status:        "COMPLETED",
            note:          `Margin locked for order ${orderId}`,
            debitAccount:  `CLIENT_FREE:${userId}`,
            creditAccount: `CLIENT_MARGIN:${userId}`,
          },
        });

        return { ok: true as const };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 3000, timeout: 8000 });

      return result;
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
