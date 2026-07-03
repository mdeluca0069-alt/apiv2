import type { PrismaClient } from "@prisma/client";

export type BalanceSnapshot = {
  userId: string;
  currency: string;
  balance: number;
  equity: number;
  locked: number;
  freeMargin: number;
  unrealizedPnL: number;
  marginLevel: number;
};

export type QuoteLike = {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
};

export class BalanceCalculator {
  constructor(private readonly db: PrismaClient) {}

  async compute(userId: string, quotes: QuoteLike[]): Promise<BalanceSnapshot> {
    const [account, positions] = await Promise.all([
      this.db.walletAccount.findUnique({ where: { userId } }),
      this.db.position.findMany({ where: { userId, closedAt: null } }),
    ]);

    const balance  = account ? Number(account.balance) : 0;
    const locked   = account ? Number(account.locked)  : 0;
    const currency = account?.currency ?? "USD";

    const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));

    let unrealizedPnL = 0;
    for (const pos of positions) {
      const quote = quoteMap.get(pos.symbol);
      if (!quote) continue;
      const exitPrice = pos.side === "BUY" ? quote.bid : quote.ask;
      const direction = pos.side === "BUY" ? 1 : -1;
      unrealizedPnL += (exitPrice - Number(pos.entryPrice)) * Number(pos.quantity) * direction;
    }

    const equity     = balance + unrealizedPnL;
    const freeMargin = Math.max(0, equity - locked);
    const marginLevel = locked > 0 ? (equity / locked) * 100 : Infinity;

    return {
      userId,
      currency,
      balance,
      equity,
      locked,
      freeMargin,
      unrealizedPnL,
      marginLevel: isFinite(marginLevel) ? marginLevel : 9999,
    };
  }

  async getBalanceOnly(userId: string): Promise<{ balance: number; locked: number; freeMargin: number }> {
    const account = await this.db.walletAccount.findUnique({
      where: { userId },
      select: { balance: true, locked: true },
    });

    const balance = account ? Number(account.balance) : 0;
    const locked  = account ? Number(account.locked)  : 0;
    return { balance, locked, freeMargin: Math.max(0, balance - locked) };
  }
}
