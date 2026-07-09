import { randomUUID } from "node:crypto";
import { Decimal }    from "@prisma/client/runtime/library";
import type { PrismaClient } from "@prisma/client";
import { WalletRepository } from "./wallet.repository.js";

export type DepositInput = {
  userId: string;
  amount: number;
  method: string;
  reference?: string;
};

export type WithdrawalInput = {
  userId: string;
  amount: number;
  destination: string;
  method: string;
};

export type PnLSettlementInput = {
  userId: string;
  pnl: number;
  marginToRelease: number;  // actual margin locked for this position — must be > 0
  positionId: string;
  symbol: string;
  side: "BUY" | "SELL";
};

export class LedgerEngine {
  private readonly repo: WalletRepository;

  constructor(private readonly db: PrismaClient) {
    this.repo = new WalletRepository(db);
  }

  async requestDeposit(input: DepositInput): Promise<{ status: "PENDING_ADMIN"; entryId: string; reference: string }> {
    await this.repo.getOrCreate(input.userId);

    const id        = randomUUID();
    const reference = input.reference ?? `DEP-${Date.now()}`;
    await this.db.ledgerEntry.create({
      data: {
        id,
        userId:    input.userId,
        currency:  "USD",
        amount:    input.amount,
        type:      "DEPOSIT_REQUEST",
        reference,
        status:    "PENDING_ADMIN",
        note:      `Deposit request via ${input.method}. Pending admin/KYC/AML review.`,
      },
    });

    return { status: "PENDING_ADMIN", entryId: id, reference };
  }

  async approveDeposit(userId: string, amount: number, depositReference: string): Promise<void> {
    await this.repo.getOrCreate(userId);

    // Both the credit and the status update must succeed or fail together.
    // A crash between them would leave the deposit as PENDING_ADMIN, allowing
    // a second approval (double-credit). This transaction prevents that.
    await this.db.$transaction(async (tx) => {
      // Idempotency guard: if already approved, bail out without double-crediting.
      const existing = await tx.ledgerEntry.findFirst({
        where: { userId, reference: `APPROVED:${depositReference}`, type: "ADMIN_CAPITAL_ALLOCATION" },
      });
      if (existing) return; // already approved

      const account = await tx.walletAccount.findUnique({
        where: { userId },
        select: { balance: true },
      });
      if (!account) throw new Error(`WALLET_NOT_FOUND:${userId}`);

      const newBalance = account.balance.plus(amount);
      await tx.walletAccount.update({ where: { userId }, data: { balance: newBalance } });

      await tx.ledgerEntry.create({
        data: {
          id: randomUUID(),
          userId, currency: "USD",
          amount,
          type: "ADMIN_CAPITAL_ALLOCATION",
          reference: `APPROVED:${depositReference}`,
          status: "COMPLETED",
          note: `Capital credited from approved deposit ${depositReference}`,
          runningBalance: newBalance,
          debitAccount: "BROKER_FLOAT",
          creditAccount: `CLIENT:${userId}`,
        },
      });

      await tx.ledgerEntry.updateMany({
        where: { userId, reference: depositReference, type: "DEPOSIT_REQUEST" },
        data:  { status: "APPROVED" },
      });
    }, { isolationLevel: "Serializable", maxWait: 10000, timeout: 15000 });
  }

  async requestWithdrawal(input: WithdrawalInput): Promise<{ status: string; message: string }> {
    const account = await this.repo.get(input.userId);
    if (!account) {
      return { status: "REJECTED", message: "No wallet found for user." };
    }

    const freeMargin = Number(account.balance) - Number(account.locked);
    if (input.amount > freeMargin) {
      await this.db.ledgerEntry.create({
        data: {
          id: randomUUID(), userId: input.userId, currency: "USD",
          amount: -input.amount, type: "WITHDRAW_REQUEST",
          reference: input.destination, status: "REJECTED",
          note: "Withdrawal rejected: insufficient free margin.",
        },
      });
      return { status: "REJECTED", message: "Insufficient free margin." };
    }

    await this.db.ledgerEntry.create({
      data: {
        id: randomUUID(), userId: input.userId, currency: "USD",
        amount: -input.amount, type: "WITHDRAW_REQUEST",
        reference: input.destination, status: "PENDING_ADMIN",
        note: `Withdrawal request via ${input.method} to ${input.destination}. Pending KYC/AML/admin review.`,
      },
    });

    return { status: "PENDING_ADMIN", message: "Withdrawal request submitted for review." };
  }

  async approveWithdrawal(userId: string, amount: number, withdrawalReference: string): Promise<void> {
    // Both the debit and the status update must succeed or fail together.
    // Idempotency guard: if already approved, bail out without double-debiting.
    await this.db.$transaction(async (tx) => {
      const existing = await tx.ledgerEntry.findFirst({
        where: { userId, reference: `APPROVED:${withdrawalReference}`, type: "WITHDRAW_REQUEST", status: "COMPLETED" },
      });
      if (existing) return;

      const account = await tx.walletAccount.findUnique({
        where:  { userId },
        select: { balance: true },
      });
      if (!account) throw new Error(`WALLET_NOT_FOUND:${userId}`);
      if (account.balance.lt(amount)) throw new Error("INSUFFICIENT_BALANCE");

      const newBalance = account.balance.minus(amount);
      await tx.walletAccount.update({
        where: { userId },
        data:  { balance: newBalance },
      });

      await tx.ledgerEntry.create({
        data: {
          id:             randomUUID(),
          userId,
          currency:       "USD",
          amount:         new Decimal(-amount),
          type:           "WITHDRAW_REQUEST",
          reference:      `APPROVED:${withdrawalReference}`,
          status:         "COMPLETED",
          note:           `Capital debited from approved withdrawal ${withdrawalReference}`,
          runningBalance: newBalance,
          debitAccount:   `CLIENT:${userId}`,
          creditAccount:  "BROKER_FLOAT",
        },
      });

      await tx.ledgerEntry.updateMany({
        where: { userId, reference: withdrawalReference, type: "WITHDRAW_REQUEST", status: "PENDING_ADMIN" },
        data:  { status: "APPROVED" },
      });
    }, { isolationLevel: "Serializable", maxWait: 10000, timeout: 15000 });
  }

  async rejectDeposit(userId: string, entryId: string, adminId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      // Fix #11: id alone is no longer a valid unique-where (composite PK
      // is (id, createdAt)) — findFirst/updateMany behave identically to
      // the old findUnique/update here since id is uuid-generated.
      const entry = await tx.ledgerEntry.findFirst({ where: { id: entryId } });
      if (!entry || entry.userId !== userId || entry.type !== "DEPOSIT_REQUEST" || entry.status !== "PENDING_ADMIN") {
        throw new Error("ENTRY_NOT_FOUND_OR_INVALID_STATE");
      }
      await tx.ledgerEntry.updateMany({ where: { id: entryId }, data: { status: "REJECTED" } });
      await tx.auditLog.create({
        data: {
          id:      randomUUID(),
          actor:   adminId,
          action:  "deposit.rejected",
          entity:  entryId,
          payload: { userId, reference: entry.reference, amount: Number(entry.amount) } as object,
        },
      });
    }, { maxWait: 10000, timeout: 15000 });
  }

  async rejectWithdrawal(userId: string, entryId: string, adminId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      // Fix #11: see rejectDeposit() above for why findFirst/updateMany.
      const entry = await tx.ledgerEntry.findFirst({ where: { id: entryId } });
      if (!entry || entry.userId !== userId || entry.type !== "WITHDRAW_REQUEST" || entry.status !== "PENDING_ADMIN") {
        throw new Error("ENTRY_NOT_FOUND_OR_INVALID_STATE");
      }
      await tx.ledgerEntry.updateMany({ where: { id: entryId }, data: { status: "REJECTED" } });
      await tx.auditLog.create({
        data: {
          id:      randomUUID(),
          actor:   adminId,
          action:  "withdrawal.rejected",
          entity:  entryId,
          payload: { userId, reference: entry.reference, amount: Number(entry.amount) } as object,
        },
      });
    }, { maxWait: 10000, timeout: 15000 });
  }

  async settlePnL(input: PnLSettlementInput): Promise<void> {
    await this.repo.getOrCreate(input.userId);

    if (input.pnl > 0) {
      await this.repo.credit(
        input.userId,
        input.pnl,
        "PNL_CREDIT",
        `PNL:${input.positionId}`,
        `P&L credit from ${input.side} ${input.symbol} position ${input.positionId}`
      );
    } else if (input.pnl < 0) {
      // Run debit inside its own serializable transaction — the transaction
      // will re-read the balance internally, avoiding the TOCTOU window.
      // Negative balance protection: cap loss at available balance.
      const loss = Math.abs(input.pnl);
      try {
        await this.repo.debit(
          input.userId,
          loss,
          "PNL_DEBIT",
          `PNL:${input.positionId}`,
          `P&L debit from ${input.side} ${input.symbol} position ${input.positionId}`
        );
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_FUNDS") {
          // Negative balance protection: debit whatever is available
          const account = await this.repo.get(input.userId);
          const available = account ? Number(account.balance) : 0;
          if (available > 0) {
            await this.repo.debit(
              input.userId,
              available,
              "PNL_DEBIT",
              `PNL:${input.positionId}`,
              `P&L debit (negative balance protection, capped at ${available}) — position ${input.positionId}`
            );
          }
        } else {
          throw err;
        }
      }
    }

    // Always release margin — pass the actual margin amount, not zero.
    if (input.marginToRelease > 0) {
      await this.repo.releaseMargin(
        input.userId,
        input.marginToRelease,
        input.positionId
      );
    }
  }
}
