/**
 * AccountStatementService — generate account statements from ledger records.
 *
 * An account statement is a chronological list of all balance-affecting
 * ledger entries for a date range, with running balance and summary totals.
 *
 * Used by:
 *   - Client portal (GET /api/v1/account/statement?from=…&to=…)
 *   - Compliance reporting (MiFID II / CONSOB annual statements)
 *   - Admin export
 */

import { prisma }  from "../shared/db.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type StatementLine = {
  date:           string;
  type:           string;
  reference:      string;
  description:    string;
  debit:          number | null;
  credit:         number | null;
  runningBalance: number;
};

export type AccountStatement = {
  userId:         string;
  currency:       string;
  periodFrom:     string;
  periodTo:       string;
  openingBalance: number;
  closingBalance: number;
  totalCredits:   number;
  totalDebits:    number;
  totalFees:      number;
  totalSwaps:     number;
  netPnL:         number;
  lines:          StatementLine[];
  generatedAt:    string;
};

// Types that affect the running cash balance
const BALANCE_TYPES = [
  "ADMIN_CAPITAL_ALLOCATION",
  "PNL_CREDIT",
  "PNL_DEBIT",
  "PNL_SETTLEMENT",
  "COMMISSION",
  "SWAP",
  "ADJUSTMENT",
  "FEE",
  "WITHDRAW_REQUEST",  // approved withdrawals
];

export class AccountStatementService {
  /**
   * Generate a statement for the given date range (inclusive).
   *
   * @param userId    Client user ID.
   * @param fromDate  Start date "YYYY-MM-DD".
   * @param toDate    End date "YYYY-MM-DD".
   */
  async generate(
    userId:   string,
    fromDate: string,
    toDate:   string,
  ): Promise<AccountStatement | null> {
    if (!prisma?.ledgerEntry) return null;

    const db = prisma as NonNullable<typeof prisma>;

    const from = new Date(fromDate + "T00:00:00Z");
    const to   = new Date(toDate   + "T23:59:59.999Z");

    // Opening balance: sum of all completed balance entries BEFORE the period
    const preEntries = await db.ledgerEntry.aggregate({
      where: {
        userId,
        status:    "COMPLETED",
        type:      { in: BALANCE_TYPES },
        createdAt: { lt: from },
      },
      _sum: { amount: true },
    });
    const openingBalance = preEntries._sum.amount?.toNumber() ?? 0;

    // Entries within the period
    const entries = await db.ledgerEntry.findMany({
      where: {
        userId,
        status:    "COMPLETED",
        type:      { in: BALANCE_TYPES },
        createdAt: { gte: from, lte: to },
      },
      orderBy: { createdAt: "asc" },
    });

    let runningBalance = openingBalance;
    let totalCredits   = 0;
    let totalDebits    = 0;
    let totalFees      = 0;
    let totalSwaps     = 0;
    let netPnL         = 0;

    const lines: StatementLine[] = [];

    for (const e of entries) {
      const amount = e.amount.toNumber();
      runningBalance += amount;

      const isCredit  = amount > 0;
      const isDebit   = amount < 0;

      if (isCredit) totalCredits  += amount;
      if (isDebit)  totalDebits   += Math.abs(amount);

      if (e.type === "COMMISSION" || e.type === "FEE") totalFees  += Math.abs(amount);
      if (e.type === "SWAP")                           totalSwaps  += amount; // signed
      if (e.type === "PNL_SETTLEMENT" || e.type === "PNL_CREDIT" || e.type === "PNL_DEBIT") {
        netPnL += amount;
      }

      lines.push({
        date:           e.createdAt.toISOString(),
        type:           e.type,
        reference:      e.reference,
        description:    e.note || e.type,
        debit:          isDebit  ? Number(Math.abs(amount).toFixed(2)) : null,
        credit:         isCredit ? Number(amount.toFixed(2))           : null,
        runningBalance: Number(runningBalance.toFixed(2)),
      });
    }

    const wallet = await db.walletAccount.findUnique({
      where:  { userId },
      select: { currency: true },
    });

    return {
      userId,
      currency:       wallet?.currency ?? "USD",
      periodFrom:     fromDate,
      periodTo:       toDate,
      openingBalance: Number(openingBalance.toFixed(2)),
      closingBalance: Number(runningBalance.toFixed(2)),
      totalCredits:   Number(totalCredits.toFixed(2)),
      totalDebits:    Number(totalDebits.toFixed(2)),
      totalFees:      Number(totalFees.toFixed(2)),
      totalSwaps:     Number(totalSwaps.toFixed(2)),
      netPnL:         Number(netPnL.toFixed(2)),
      lines,
      generatedAt:    new Date().toISOString(),
    };
  }

  /**
   * Retrieve daily snapshots for a user (for equity curve / chart).
   */
  async getDailySnapshots(
    userId:   string,
    fromDate: string,
    toDate:   string,
  ) {
    if (!prisma?.accountDailySnapshot) return [];

    return (prisma as NonNullable<typeof prisma>).accountDailySnapshot.findMany({
      where: {
        userId,
        snapshotDate: {
          gte: new Date(fromDate + "T00:00:00Z"),
          lte: new Date(toDate   + "T23:59:59.999Z"),
        },
      },
      orderBy: { snapshotDate: "asc" },
    });
  }
}

export const accountStatementService = new AccountStatementService();
