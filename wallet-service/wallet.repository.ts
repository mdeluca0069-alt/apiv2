import { randomUUID } from "node:crypto";
import type { PrismaClient, LedgerEntry, WalletAccount } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

/** Retry a serializable transaction on serialization failure (SQLSTATE 40001). */
async function withSerializableRetry<T>(fn: () => Promise<T>, maxRetries = 10): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isSerializationFailure =
        err instanceof Error &&
        (err.message.includes("could not serialize") ||
         err.message.includes("40001") ||
         err.message.includes("deadlock detected") ||
         err.message.includes("write conflict") ||
         err.message.includes("Please retry") ||
         (err as { code?: string }).code === "P2034");
      if (!isSerializationFailure || attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 20 * 2 ** (attempt - 1)));
    }
  }
}

export type LedgerType =
  // ── Deposit / Withdrawal ──────────────────────────────────────────────────
  | "DEPOSIT_REQUEST"           // pending admin review
  | "WITHDRAW_REQUEST"          // pending admin review
  | "ADMIN_CAPITAL_ALLOCATION"  // approved deposit credited to balance
  // ── Margin ────────────────────────────────────────────────────────────────
  | "MARGIN_RESERVED"           // WalletRepository.lockMargin() — affects locked only
  | "MARGIN_RELEASED"           // WalletRepository.releaseMargin() — affects locked only
  | "MARGIN_LOCK"               // MarginController.lockMargin() — synonym, affects locked only
  | "MARGIN_RELEASE"            // MarginController.releaseMargin() — synonym
  // ── Settlement ────────────────────────────────────────────────────────────
  | "PNL_CREDIT"                // positive P&L settlement
  | "PNL_DEBIT"                 // negative P&L settlement
  | "PNL_SETTLEMENT"            // net P&L entry (may be positive or negative)
  | "COMMISSION"                // brokerage commission debit
  | "SWAP"                      // overnight financing charge
  | "ADJUSTMENT"                // manual admin correction
  | "NBP_WRITEOFF"              // ESMA negative-balance protection write-off credit (settlement.engine.ts)
  | "DEPOSIT_CREDIT"            // live PSP deposit credited to balance (payment-service webhook)
  // ── Other ─────────────────────────────────────────────────────────────────
  | "FEE"                       // generic fee (deprecated — use COMMISSION)
  | "DOCUMENT_EVENT";           // KYC/compliance document milestone

export type CreditResult = { entry: LedgerEntry; newBalance: Decimal };
export type DebitResult  = { entry: LedgerEntry; newBalance: Decimal };

export class WalletRepository {
  constructor(private readonly db: PrismaClient) {}

  async getOrCreate(userId: string, currency = "USD"): Promise<WalletAccount> {
    return this.db.walletAccount.upsert({
      where:  { userId },
      create: { userId, currency },
      update: {},
    });
  }

  async get(userId: string): Promise<WalletAccount | null> {
    return this.db.walletAccount.findUnique({ where: { userId } });
  }

  async credit(
    userId: string,
    amount: number | Decimal,
    type: LedgerType,
    reference: string,
    note = ""
  ): Promise<CreditResult> {
    const creditAmount = new Decimal(amount);
    if (creditAmount.lte(0)) throw new Error("CREDIT_AMOUNT_MUST_BE_POSITIVE");

    return withSerializableRetry(() => this.db.$transaction(
      async (tx) => {
        const account = await tx.walletAccount.findUnique({
          where: { userId },
          select: { balance: true },
        });
        if (!account) throw new Error(`WALLET_NOT_FOUND:${userId}`);

        const newBalance = account.balance.plus(creditAmount);

        // Only update balance — equity is derived (balance + unrealizedPnL)
        // and must be computed by BalanceCalculator, not set here.
        await tx.walletAccount.update({
          where: { userId },
          data: { balance: newBalance },
        });

        const entry = await tx.ledgerEntry.create({
          data: {
            id:             randomUUID(),
            userId,
            currency:       "USD",
            amount:         creditAmount,
            type,
            reference,
            status:         "COMPLETED",
            note,
            runningBalance: newBalance,
            debitAccount:   "BROKER_FLOAT",
            creditAccount:  `CLIENT:${userId}`,
          },
        });

        return { entry, newBalance };
      },
      { isolationLevel: "Serializable", maxWait: 10000, timeout: 15000 }
    ));
  }

  async debit(
    userId: string,
    amount: number | Decimal,
    type: LedgerType,
    reference: string,
    note = ""
  ): Promise<DebitResult> {
    const debitAmount = new Decimal(amount);
    if (debitAmount.lte(0)) throw new Error("DEBIT_AMOUNT_MUST_BE_POSITIVE");

    return withSerializableRetry(() => this.db.$transaction(
      async (tx) => {
        const account = await tx.walletAccount.findUnique({
          where: { userId },
          select: { balance: true },
        });
        if (!account) throw new Error(`WALLET_NOT_FOUND:${userId}`);
        if (account.balance.lt(debitAmount)) throw new Error("INSUFFICIENT_FUNDS");

        const newBalance = account.balance.minus(debitAmount);

        await tx.walletAccount.update({
          where: { userId },
          data: { balance: newBalance },
        });

        const entry = await tx.ledgerEntry.create({
          data: {
            id:             randomUUID(),
            userId,
            currency:       "USD",
            amount:         debitAmount.negated(),
            type,
            reference,
            status:         "COMPLETED",
            note,
            runningBalance: newBalance,
            debitAccount:   `CLIENT:${userId}`,
            creditAccount:  "BROKER_FLOAT",
          },
        });

        return { entry, newBalance };
      },
      { isolationLevel: "Serializable", maxWait: 10000, timeout: 15000 }
    ));
  }

  async lockMargin(userId: string, amount: number | Decimal, reference: string): Promise<void> {
    const lockAmount = new Decimal(amount);
    await withSerializableRetry(() => this.db.$transaction(
      async (tx) => {
        const account = await tx.walletAccount.findUnique({
          where: { userId },
          select: { balance: true, locked: true },
        });
        if (!account) throw new Error(`WALLET_NOT_FOUND:${userId}`);
        if (account.balance.minus(account.locked).lt(lockAmount)) {
          throw new Error("INSUFFICIENT_FREE_MARGIN");
        }
        await tx.walletAccount.update({
          where: { userId },
          data: { locked: { increment: lockAmount } },
        });
        await tx.ledgerEntry.create({
          data: {
            id: randomUUID(),
            userId, currency: "USD",
            amount: lockAmount.negated(),
            type: "MARGIN_RESERVED",
            reference, status: "COMPLETED",
            note: `Margin locked for position ${reference}`,
          },
        });
      },
      { isolationLevel: "Serializable", maxWait: 10000, timeout: 15000 }
    ));
  }

  async releaseMargin(userId: string, amount: number | Decimal, reference: string): Promise<void> {
    const releaseAmount = new Decimal(amount);
    if (releaseAmount.lte(0)) return;
    await withSerializableRetry(() => this.db.$transaction(async (tx) => {
      // Read current locked inside the Serializable tx for floor-safe clamp.
      const account = await tx.walletAccount.findUnique({
        where:  { userId },
        select: { locked: true },
      });
      if (!account) throw new Error(`WALLET_NOT_FOUND:${userId}`);

      const safeRelease   = account.locked.lt(releaseAmount) ? account.locked : releaseAmount;
      const discrepancy   = releaseAmount.minus(safeRelease);

      if (safeRelease.lte(0)) {
        console.warn(
          `[wallet-repo] releaseMargin no-op: userId=${userId} ` +
          `requested=${releaseAmount.toFixed(2)} currentLocked=${account.locked.toFixed(2)}`
        );
        return;
      }

      await tx.walletAccount.update({
        where: { userId },
        data:  { locked: { decrement: safeRelease } },
      });

      await tx.ledgerEntry.create({
        data: {
          id: randomUUID(),
          userId, currency: "USD",
          amount: safeRelease,
          type: "MARGIN_RELEASED",
          reference, status: "COMPLETED",
          note: discrepancy.gt(0.001)
            ? `Margin released for position ${reference} [PARTIAL: requested=${releaseAmount.toFixed(2)} released=${safeRelease.toFixed(2)}]`
            : `Margin released for position ${reference}`,
        },
      });
    }, { isolationLevel: "Serializable", maxWait: 10000, timeout: 15000 }));
  }

  async getLedger(userId: string, limit = 100): Promise<LedgerEntry[]> {
    return this.db.ledgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}
