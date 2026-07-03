import { randomUUID }   from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Decimal }          from "@prisma/client/runtime/library";

// ─── Status constants ────────────────────────────────────────────────────────

export type DepositStatus =
  | "REQUESTED"  // row created, no PSP call yet
  | "PENDING"    // PSP session created, user redirected
  | "CONFIRMED"  // PSP webhook received — payment collected
  | "CREDITED"   // ledger credit applied — terminal, immutable
  | "FAILED"     // PSP declined — terminal
  | "EXPIRED";   // no PSP confirmation within TTL — terminal

// ─── State machine ───────────────────────────────────────────────────────────

export class DepositStateMachine {
  constructor(private readonly db: PrismaClient) {}

  async createRequested(params: {
    userId:    string;
    psp:       string;
    amount:    number;
    currency:  string;
    returnUrl: string;
  }): Promise<string> {
    const dep = await this.db.depositTransaction.create({
      data: {
        userId:    params.userId,
        psp:       params.psp,
        amount:    new Decimal(params.amount),
        currency:  params.currency,
        status:    "REQUESTED",
        returnUrl: params.returnUrl,
      },
    });
    return dep.id;
  }

  async transitionToPending(depositId: string, params: {
    sessionId:   string;
    redirectUrl: string;
    pspRef?:     string;
  }): Promise<void> {
    await this.db.depositTransaction.update({
      where: { id: depositId },
      data:  {
        status:     "PENDING",
        sessionId:  params.sessionId,
        redirectUrl: params.redirectUrl,
        pspRef:     params.pspRef,
        pendingAt:  new Date(),
      },
    });
  }

  // The critical credit path. Serializable transaction prevents double-credit.
  //
  // Double-credit protection layers:
  //   1. pspRef unique constraint — two webhook calls for the same PSP transaction
  //      reference the same DepositTransaction row (no duplicate row possible).
  //   2. This transaction reads status under Serializable isolation. If status
  //      is already CREDITED, it returns without crediting. Concurrent calls
  //      both read CONFIRMED, but only one UPDATE will commit; the other will
  //      conflict and be retried, at which point it reads CREDITED and exits.
  //   3. LedgerEntry reference is `PSP:{pspRef}` — auditable, globally unique.
  async transitionToCredit(depositId: string, params: {
    pspRef:     string;
    amount:     number;
    currency:   string;
    webhookData?: unknown;
  }): Promise<{ alreadyCredited: boolean }> {
    let alreadyCredited = false;

    await this.db.$transaction(async (tx) => {
      const dep = await tx.depositTransaction.findUniqueOrThrow({
        where:  { id: depositId },
        select: { userId: true, status: true, amount: true, currency: true, psp: true },
      });

      if (dep.status === "CREDITED") {
        alreadyCredited = true;
        return;
      }

      if (dep.status !== "CONFIRMED") {
        throw new Error(`DEPOSIT_INVALID_TRANSITION:${dep.status}->CREDITED`);
      }

      const creditAmount = new Decimal(params.amount).gt(0)
        ? new Decimal(params.amount)
        : dep.amount;

      // Credit wallet
      const wallet = await tx.walletAccount.findUniqueOrThrow({
        where: { userId: dep.userId },
      });
      const newBalance = wallet.balance.plus(creditAmount);
      await tx.walletAccount.update({
        where: { userId: dep.userId },
        data:  {
          balance:   newBalance,
          updatedAt: new Date(),
        },
      });

      // Create ledger entry — reference is globally unique via pspRef
      await tx.ledgerEntry.create({
        data: {
          id:             randomUUID(),
          userId:         dep.userId,
          currency:       params.currency || dep.currency,
          amount:         creditAmount,
          type:           "DEPOSIT_CREDIT",
          reference:      `PSP:${params.pspRef}`,
          status:         "COMPLETED",
          note:           `Deposit credited via ${dep.psp} — ref ${params.pspRef}`,
          runningBalance: newBalance,
          debitAccount:   "PSP_FLOAT",
          creditAccount:  `CLIENT:${dep.userId}`,
        },
      });

      // Audit event
      await tx.auditLog.create({
        data: {
          id:      randomUUID(),
          actor:   "PAYMENT_SERVICE",
          action:  "deposit.credited",
          entity:  depositId,
          payload: {
            depositId,
            pspRef:  params.pspRef,
            amount:  creditAmount.toFixed(8),
            userId:  dep.userId,
            psp:     dep.psp,
          } as object,
        },
      });

      // Advance deposit status — terminal
      await tx.depositTransaction.update({
        where: { id: depositId },
        data:  {
          status:      "CREDITED",
          pspRef:      params.pspRef,
          webhookData: (params.webhookData as object) ?? undefined,
          creditedAt:  new Date(),
        },
      });
    }, {
      isolationLevel: "Serializable",
      maxWait:         10_000,
      timeout:         20_000,
    });

    return { alreadyCredited };
  }

  async transitionToConfirmed(depositId: string, params: {
    pspRef:      string;
    webhookData: unknown;
  }): Promise<void> {
    await this.db.depositTransaction.update({
      where: { id: depositId },
      data:  {
        status:      "CONFIRMED",
        pspRef:      params.pspRef,
        webhookData: (params.webhookData as object) ?? undefined,
        confirmedAt: new Date(),
      },
    });
  }

  async transitionToFailed(depositId: string, reason: string, webhookData?: unknown): Promise<void> {
    await this.db.depositTransaction.update({
      where: { id: depositId },
      data:  {
        status:      "FAILED",
        failReason:  reason,
        webhookData: (webhookData as object) ?? undefined,
      },
    });
    await this.db.auditLog.create({
      data: {
        id:      randomUUID(),
        actor:   "PAYMENT_SERVICE",
        action:  "deposit.failed",
        entity:  depositId,
        payload: { depositId, reason } as object,
      },
    });
  }

  async expireStale(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.db.depositTransaction.updateMany({
      where: {
        status:     { in: ["REQUESTED", "PENDING"] },
        requestedAt: { lt: cutoff },
      },
      data: { status: "EXPIRED" },
    });
    return result.count;
  }
}
