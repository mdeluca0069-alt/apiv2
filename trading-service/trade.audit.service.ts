import { prisma } from "../shared/db.js";
import { type TradeAudit } from "../shared/contracts.js";
import { Decimal } from "@prisma/client/runtime/library";

export class TradeAuditService {
  // Registra una nuova operazione
  async recordTrade(data: {
    userId: string;
    orderId?: string;
    positionId?: string;
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    entryPrice?: number;
    stopLoss?: number;
    takeProfit?: number;
    marginUsed?: number;
    leverage?: number;
    fees?: number;
    slippage?: number;
  }) {
    return await prisma.tradeAudit.create({
      data: {
        userId: data.userId,
        orderId: data.orderId,
        positionId: data.positionId,
        symbol: data.symbol,
        side: data.side,
        quantity: new Decimal(data.quantity),
        entryPrice: data.entryPrice ? new Decimal(data.entryPrice) : null,
        stopLoss: data.stopLoss ? new Decimal(data.stopLoss) : null,
        takeProfit: data.takeProfit ? new Decimal(data.takeProfit) : null,
        marginUsed: data.marginUsed ? new Decimal(data.marginUsed) : null,
        leverage: data.leverage,
        fees: new Decimal(data.fees || 0),
        slippage: new Decimal(data.slippage || 0),
        tradeStatus: "OPEN",
        lifecycle: JSON.stringify([
          {
            status: "OPEN",
            timestamp: new Date().toISOString(),
            detail: "Trade opened",
          },
        ]),
        riskMetrics: JSON.stringify({
          riskScore: 0,
          marginLevel: 0,
        }),
      },
    });
  }

  // Chiude una posizione e aggiorna il PnL
  async closeTrade(tradeId: string, exitData: {
    exitPrice: number;
    pnlRealized: number;
    fees?: number;
  }) {
    const trade = await prisma.tradeAudit.findUnique({
      where: { id: tradeId },
    });

    if (!trade) throw new Error("Trade not found");

    const duration = Math.floor(
      (new Date().getTime() - trade.createdAt.getTime()) / (1000 * 60)
    );
    const pnlPercent = trade.entryPrice
      ? ((exitData.exitPrice - trade.entryPrice.toNumber()) / trade.entryPrice.toNumber()) * 100
      : 0;

    return await prisma.tradeAudit.update({
      where: { id: tradeId },
      data: {
        exitPrice: new Decimal(exitData.exitPrice),
        pnlRealized: new Decimal(exitData.pnlRealized),
        pnlPercent: new Decimal(pnlPercent),
        tradeStatus: "CLOSED",
        closedAt: new Date(),
        duration,
        fees: new Decimal(exitData.fees || trade.fees.toNumber()),
      },
    });
  }

  // Ottiene storico completo delle operazioni di un utente
  async getTradeHistory(userId: string, filters?: {
    symbol?: string;
    status?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }) {
    const where: any = { userId };

    if (filters?.symbol) where.symbol = filters.symbol;
    if (filters?.status) where.tradeStatus = filters.status;
    if (filters?.startDate || filters?.endDate) {
      where.createdAt = {};
      if (filters.startDate) where.createdAt.gte = filters.startDate;
      if (filters.endDate) where.createdAt.lte = filters.endDate;
    }

    const [trades, total] = await Promise.all([
      prisma.tradeAudit.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: filters?.limit || 50,
        skip: filters?.offset || 0,
      }),
      prisma.tradeAudit.count({ where }),
    ]);

    return {
      trades: trades.map((t: any) => this.formatTradeAudit(t)),
      total,
      limit: filters?.limit || 50,
      offset: filters?.offset || 0,
    };
  }

  // Calcola statistiche dell'utente
  async getUserTradeStats(userId: string) {
    const trades = await prisma.tradeAudit.findMany({
      where: { userId },
    });

    const totalTrades = trades.length;
    const openTrades = trades.filter((t: any) => t.tradeStatus === "OPEN").length;
    const closedTrades = trades.filter((t: any) => t.tradeStatus === "CLOSED").length;

    const totalPnL = trades.reduce(
      (sum: number, t: any) => sum + (t.pnlRealized?.toNumber() || 0),
      0
    );
    const totalFees = trades.reduce((sum: number, t: any) => sum + t.fees.toNumber(), 0);

    const winningTrades = trades.filter(
      (t: any) => t.pnlRealized && t.pnlRealized.toNumber() > 0
    ).length;
    const losingTrades = closedTrades - winningTrades;
    const winRate = closedTrades > 0 ? (winningTrades / closedTrades) * 100 : 0;

    const avgDuration =
      closedTrades > 0
        ? trades
            .filter((t: any) => t.duration)
            .reduce((sum: number, t: any) => sum + (t.duration || 0), 0) / closedTrades
        : 0;

    return {
      totalTrades,
      openTrades,
      closedTrades,
      totalPnL: parseFloat(totalPnL.toFixed(2)),
      totalFees: parseFloat(totalFees.toFixed(2)),
      netPnL: parseFloat((totalPnL - totalFees).toFixed(2)),
      winningTrades,
      losingTrades,
      winRate: parseFloat(winRate.toFixed(2)),
      avgDuration: Math.round(avgDuration),
    };
  }

  private formatTradeAudit(trade: any): TradeAudit {
    return {
      id: trade.id,
      userId: trade.userId,
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity.toNumber(),
      entryPrice: trade.entryPrice?.toNumber(),
      exitPrice: trade.exitPrice?.toNumber(),
      stopLoss: trade.stopLoss?.toNumber(),
      takeProfit: trade.takeProfit?.toNumber(),
      pnlRealized: trade.pnlRealized?.toNumber(),
      pnlUnrealized: trade.pnlUnrealized?.toNumber(),
      pnlPercent: trade.pnlPercent?.toNumber(),
      marginUsed: trade.marginUsed?.toNumber(),
      leverage: trade.leverage,
      fees: trade.fees.toNumber(),
      slippage: trade.slippage.toNumber(),
      duration: trade.duration,
      tradeStatus: trade.tradeStatus,
      lifecycle: JSON.parse(trade.lifecycle),
      riskMetrics: JSON.parse(trade.riskMetrics),
      createdAt: trade.createdAt.toISOString(),
      closedAt: trade.closedAt?.toISOString(),
    };
  }
}

export const tradeAuditService = new TradeAuditService();
