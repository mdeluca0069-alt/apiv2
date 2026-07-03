import { prisma, IS_PERSISTENT } from "../shared/db.js";
import type { LedgerType } from "./wallet.repository.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LedgerQueryParams = {
  userId:    string;
  limit?:    number;
  offset?:   number;
  type?:     LedgerType | LedgerType[];
  status?:   string;
  from?:     Date;
  to?:       Date;
  orderBy?:  "asc" | "desc";
};

export type LedgerEntry = {
  id:             string;
  userId:         string;
  type:           string;
  amount:         number;
  currency:       string;
  reference:      string;
  status:         string;
  note:           string;
  runningBalance: number | null;
  debitAccount:   string | null;
  creditAccount:  string | null;
  createdAt:      string;
};

export type LedgerPage = {
  entries:      LedgerEntry[];
  totalCount:   number;
  totalCredits: number;
  totalDebits:  number;
  pageSize:     number;
  offset:       number;
};

export type StatementPeriod = "daily" | "weekly" | "monthly" | "custom";

export type AccountStatement = {
  userId:           string;
  period:           StatementPeriod;
  from:             string;
  to:               string;
  openingBalance:   number;
  closingBalance:   number;
  realizedPnl:      number;
  commissions:      number;
  swaps:            number;
  deposits:         number;
  withdrawals:      number;
  adjustments:      number;
  netChange:        number;
  entryCount:       number;
  generatedAt:      string;
};

// ─── Sandbox fallback data ────────────────────────────────────────────────────

function sandboxPage(_userId: string, params: LedgerQueryParams): LedgerPage {
  return {
    entries: [],
    totalCount: 0,
    totalCredits: 0,
    totalDebits: 0,
    pageSize: params.limit ?? 50,
    offset: params.offset ?? 0,
  };
}

// ─── Ledger Service ───────────────────────────────────────────────────────────

export class LedgerService {

  async getLedger(params: LedgerQueryParams): Promise<LedgerPage> {
    if (!IS_PERSISTENT) return sandboxPage(params.userId, params);

    const { userId, limit = 50, offset = 0, type, status, from, to, orderBy = "desc" } = params;

    // Build where clause
    const typeFilter = type
      ? Array.isArray(type) ? { in: type } : type
      : undefined;

    const where = {
      userId,
      ...(typeFilter ? { type: typeFilter } : {}),
      ...(status     ? { status }            : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to   ? { lte: to }   : {}),
            },
          }
        : {}),
    };

    // Run count + aggregate + paginated rows in parallel
    const [totalCount, rows] = await Promise.all([
      prisma.ledgerEntry.count({ where }),
      prisma.ledgerEntry.findMany({
        where,
        orderBy: { createdAt: orderBy },
        take:    Math.min(limit, 500),
        skip:    offset,
        select: {
          id:             true,
          userId:         true,
          type:           true,
          amount:         true,
          currency:       true,
          reference:      true,
          status:         true,
          note:           true,
          runningBalance: true,
          debitAccount:   true,
          creditAccount:  true,
          createdAt:      true,
        },
      }),
    ]);

    // Separate credits (positive) and debits (negative) by scanning rows
    let totalCredits = 0;
    let totalDebits  = 0;
    for (const row of rows) {
      const amt = Number(row.amount);
      if (amt >= 0) totalCredits += amt;
      else          totalDebits  += Math.abs(amt);
    }

    const entries: LedgerEntry[] = rows.map((r) => ({
      id:             r.id,
      userId:         r.userId,
      type:           r.type,
      amount:         Number(r.amount),
      currency:       r.currency,
      reference:      r.reference,
      status:         r.status,
      note:           r.note,
      runningBalance: r.runningBalance ? Number(r.runningBalance) : null,
      debitAccount:   r.debitAccount,
      creditAccount:  r.creditAccount,
      createdAt:      r.createdAt.toISOString(),
    }));

    return { entries, totalCount, totalCredits, totalDebits, pageSize: limit, offset };
  }

  async getStatement(userId: string, period: StatementPeriod, from?: Date, to?: Date): Promise<AccountStatement> {
    const now = new Date();
    let periodFrom: Date;
    let periodTo: Date = to ?? now;

    switch (period) {
      case "daily":
        periodFrom = from ?? new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case "weekly":
        periodFrom = from ?? new Date(now.getTime() - 7 * 86400_000);
        break;
      case "monthly":
        periodFrom = from ?? new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case "custom":
      default:
        periodFrom = from ?? new Date(now.getTime() - 30 * 86400_000);
    }

    const generatedAt = now.toISOString();

    if (!IS_PERSISTENT) {
      return {
        userId, period,
        from: periodFrom.toISOString(),
        to:   periodTo.toISOString(),
        openingBalance: 0, closingBalance: 0, realizedPnl: 0,
        commissions: 0, swaps: 0, deposits: 0, withdrawals: 0, adjustments: 0,
        netChange: 0, entryCount: 0, generatedAt,
      };
    }

    const entries = await prisma.ledgerEntry.findMany({
      where: {
        userId,
        status: "COMPLETED",
        createdAt: { gte: periodFrom, lte: periodTo },
      },
      orderBy: { createdAt: "asc" },
      select:  { type: true, amount: true, createdAt: true },
    });

    // Opening balance = first runningBalance in period or query wallet
    const openingEntry = await prisma.ledgerEntry.findFirst({
      where: { userId, status: "COMPLETED", createdAt: { lt: periodFrom } },
      orderBy: { createdAt: "desc" },
      select: { runningBalance: true },
    });

    const wallet = await prisma.walletAccount.findUnique({
      where: { userId },
      select: { balance: true },
    });

    const openingBalance = openingEntry?.runningBalance
      ? Number(openingEntry.runningBalance)
      : 0;

    const closingBalance = wallet ? Number(wallet.balance) : 0;

    let realizedPnl  = 0;
    let commissions  = 0;
    let swaps        = 0;
    let deposits     = 0;
    let withdrawals  = 0;
    let adjustments  = 0;

    for (const e of entries) {
      const amt = Number(e.amount);
      switch (e.type) {
        case "PNL_CREDIT":
        case "PNL_DEBIT":
        case "PNL_SETTLEMENT":
          realizedPnl += amt;
          break;
        case "COMMISSION":
        case "FEE":
          commissions += Math.abs(amt);
          break;
        case "SWAP":
          swaps += amt;
          break;
        case "ADMIN_CAPITAL_ALLOCATION":
        case "DEPOSIT_REQUEST":
          if (amt > 0) deposits += amt;
          break;
        case "WITHDRAW_REQUEST":
          if (amt < 0) withdrawals += Math.abs(amt);
          break;
        case "ADJUSTMENT":
          adjustments += amt;
          break;
      }
    }

    const netChange = realizedPnl + deposits - withdrawals - commissions + swaps + adjustments;

    return {
      userId,
      period,
      from:           periodFrom.toISOString(),
      to:             periodTo.toISOString(),
      openingBalance,
      closingBalance,
      realizedPnl,
      commissions,
      swaps,
      deposits,
      withdrawals,
      adjustments,
      netChange,
      entryCount: entries.length,
      generatedAt,
    };
  }

  async getStatements(userId: string, periods: StatementPeriod[]): Promise<AccountStatement[]> {
    return Promise.all(periods.map((p) => this.getStatement(userId, p)));
  }
}

export const ledgerService = new LedgerService();
