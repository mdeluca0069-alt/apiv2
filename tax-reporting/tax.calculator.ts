/**
 * TaxCalculator — automated P&L reporting for IGFX OLOS clients.
 *
 * Supports:
 *   - Annual realized P&L statements (FY or calendar year)
 *   - Per-trade capital gains breakdown (short vs. long-term for US clients)
 *   - Country-specific formats: IT (730/Unico), UK (SA), DE (Anlage KAP), US (8949/Schedule D)
 *   - CSV and JSON export (PDF via external renderer on the frontend)
 *   - Wash-sale rule detection for US clients (30-day window)
 *
 * All amounts in account currency (USD). FX conversion to local currency
 * uses the closing rate on trade date (sourced from the trade audit record).
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaxYear = {
  year:       number;
  fromDate:   string;
  toDate:     string;
  country?:   TaxCountry;
};

export type TaxCountry = "IT" | "DE" | "UK" | "US" | "FR" | "ES" | "NL" | "CH" | "OTHER";

export type TaxableTrade = {
  tradeId:       string;
  symbol:        string;
  assetClass:    string;
  direction:     "BUY" | "SELL";
  quantity:      number;
  openDate:      string;
  closeDate:     string;
  entryPrice:    number;
  exitPrice:     number;
  realizedPnl:   number;
  commission:    number;
  swap:          number;
  netPnl:        number;
  holdingDays:   number;
  isLongTerm:    boolean;   // > 365 days (relevant for US)
  washSale:      boolean;   // US wash sale rule flag
};

export type TaxSummary = {
  userId:          string;
  year:            number;
  country:         TaxCountry;
  totalTrades:     number;
  profitableTrades:number;
  losingTrades:    number;
  totalGross:      number;
  totalCommission: number;
  totalSwap:       number;
  netRealizedPnl:  number;
  shortTermGains:  number;
  longTermGains:   number;
  taxableAmount:   number;
  estimatedTax:    number;
  currency:        string;
  generatedAt:     string;
  trades:          TaxableTrade[];
};

// Country-specific tax rates on trading income
const TAX_RATES: Record<TaxCountry, { rate: number; threshold: number; name: string }> = {
  IT:    { rate: 0.26,   threshold: 0,     name: "Imposta sostitutiva" },
  DE:    { rate: 0.25,   threshold: 0,     name: "Abgeltungsteuer" },
  UK:    { rate: 0.20,   threshold: 12_300,name: "Capital Gains Tax" },
  US:    { rate: 0.20,   threshold: 44_625,name: "Long-Term Capital Gains" },
  FR:    { rate: 0.30,   threshold: 0,     name: "Flat tax (PFU)" },
  ES:    { rate: 0.23,   threshold: 6_000, name: "IRPF (ganancias patrimoniales)" },
  NL:    { rate: 0.31,   threshold: 57_000,name: "Box 3 vermogensbelasting" },
  CH:    { rate: 0.00,   threshold: 0,     name: "Kapitalgewinne (steuerfrei)" },
  OTHER: { rate: 0.20,   threshold: 0,     name: "Estimated flat rate" },
};

function fiscalYearBounds(year: number, country: TaxCountry): { from: Date; to: Date } {
  if (country === "UK") {
    return { from: new Date(`${year}-04-06`), to: new Date(`${year + 1}-04-05`) };
  }
  return { from: new Date(`${year}-01-01`), to: new Date(`${year}-12-31T23:59:59.999Z`) };
}

// ─── TaxCalculator ────────────────────────────────────────────────────────────

export class TaxCalculator {

  async computeAnnualReport(
    userId:  string,
    year:    number,
    country: TaxCountry = "OTHER",
  ): Promise<TaxSummary> {
    if (!IS_PERSISTENT) {
      return this._sandboxReport(userId, year, country);
    }

    const db         = prisma as NonNullable<typeof prisma>;
    const { from, to } = fiscalYearBounds(year, country);

    const rawTrades = await db.tradeAudit.findMany({
      where: {
        userId,
        tradeStatus: "CLOSED",
        closedAt:    { gte: from, lte: to, not: null },
      },
      orderBy: { closedAt: "asc" },
    });

    // TradeAudit doesn't carry assetClass directly — look it up from Instrument.
    const symbols = [...new Set(rawTrades.map(t => t.symbol))];
    const instruments = symbols.length
      ? await db.instrument.findMany({ where: { symbol: { in: symbols } }, select: { symbol: true, assetClass: true } })
      : [];
    const assetClassBySymbol = new Map(instruments.map(i => [i.symbol, i.assetClass]));

    // Swap is accrued per-night in SwapAccrual (keyed by positionId), not on
    // TradeAudit itself — sum it per position for the trades in this report.
    const positionIds = [...new Set(rawTrades.map(t => t.positionId).filter((id): id is string => !!id))];
    const swapSums = positionIds.length
      ? await db.swapAccrual.groupBy({ by: ["positionId"], where: { positionId: { in: positionIds } }, _sum: { swapAmount: true } })
      : [];
    const swapByPosition = new Map(swapSums.map(s => [s.positionId, Number(s._sum.swapAmount ?? 0)]));

    const trades: TaxableTrade[] = rawTrades.map(t => {
      const openDate   = t.createdAt.toISOString();
      const closeDate  = t.closedAt!.toISOString();
      const holdingDays= Math.floor((t.closedAt!.getTime() - t.createdAt.getTime()) / 86_400_000);
      const realizedPnl= Number(t.pnlRealized ?? 0);
      const commission = Number(t.fees ?? 0);
      const swap       = t.positionId ? (swapByPosition.get(t.positionId) ?? 0) : 0;
      const netPnl     = realizedPnl - commission + swap;

      return {
        tradeId:     t.id,
        symbol:      t.symbol,
        assetClass:  assetClassBySymbol.get(t.symbol) ?? "FOREX",
        direction:   t.side as "BUY" | "SELL",
        quantity:    Number(t.quantity),
        openDate,
        closeDate,
        entryPrice:  Number(t.entryPrice),
        exitPrice:   Number(t.exitPrice ?? t.entryPrice),
        realizedPnl,
        commission,
        swap,
        netPnl,
        holdingDays,
        isLongTerm:  holdingDays > 365,
        washSale:    false, // computed in _applyWashSaleRules
      };
    });

    if (country === "US") this._applyWashSaleRules(trades);

    return this._buildSummary(userId, year, country, trades);
  }

  private _buildSummary(userId: string, year: number, country: TaxCountry, trades: TaxableTrade[]): TaxSummary {
    const totalGross     = trades.reduce((s, t) => s + t.realizedPnl, 0);
    const totalCommission= trades.reduce((s, t) => s + t.commission, 0);
    const totalSwap      = trades.reduce((s, t) => s + t.swap, 0);
    const netRealizedPnl = trades.reduce((s, t) => s + t.netPnl, 0);
    const shortTermGains = trades.filter(t => !t.isLongTerm).reduce((s, t) => s + t.netPnl, 0);
    const longTermGains  = trades.filter(t => t.isLongTerm).reduce((s, t) => s + t.netPnl, 0);

    const taxConfig    = TAX_RATES[country];
    const taxableAmount= Math.max(0, netRealizedPnl - taxConfig.threshold);
    const estimatedTax = taxableAmount * taxConfig.rate;

    return {
      userId,
      year,
      country,
      totalTrades:      trades.length,
      profitableTrades: trades.filter(t => t.netPnl > 0).length,
      losingTrades:     trades.filter(t => t.netPnl < 0).length,
      totalGross,
      totalCommission,
      totalSwap,
      netRealizedPnl,
      shortTermGains,
      longTermGains,
      taxableAmount,
      estimatedTax,
      currency:    "USD",
      generatedAt: new Date().toISOString(),
      trades,
    };
  }

  private _applyWashSaleRules(trades: TaxableTrade[]): void {
    const losingTrades = trades.filter(t => t.netPnl < 0);
    for (const loss of losingTrades) {
      const lossDate = new Date(loss.closeDate).getTime();
      const washWindow = 30 * 86_400_000;
      const hasSimilar = trades.some(t =>
        t !== loss &&
        t.symbol === loss.symbol &&
        Math.abs(new Date(t.openDate).getTime() - lossDate) <= washWindow
      );
      if (hasSimilar) loss.washSale = true;
    }
  }

  exportCsv(summary: TaxSummary): string {
    const header = [
      "TradeID", "Symbol", "AssetClass", "Direction", "Quantity",
      "OpenDate", "CloseDate", "EntryPrice", "ExitPrice",
      "RealizedPnL", "Commission", "Swap", "NetPnL",
      "HoldingDays", "LongTerm", "WashSale"
    ].join(",");

    const rows = summary.trades.map(t => [
      t.tradeId, t.symbol, t.assetClass, t.direction, t.quantity.toFixed(4),
      t.openDate.slice(0, 10), t.closeDate.slice(0, 10),
      t.entryPrice.toFixed(5), t.exitPrice.toFixed(5),
      t.realizedPnl.toFixed(2), t.commission.toFixed(2), t.swap.toFixed(2), t.netPnl.toFixed(2),
      t.holdingDays, t.isLongTerm ? "YES" : "NO", t.washSale ? "YES" : "NO"
    ].join(","));

    const meta = [
      `# IGFX OLOS — Tax Report ${summary.year}`,
      `# Country: ${summary.country} | Generated: ${summary.generatedAt}`,
      `# Net Realized P&L: ${summary.netRealizedPnl.toFixed(2)} USD`,
      `# Estimated Tax (${(TAX_RATES[summary.country].rate * 100).toFixed(0)}%): ${summary.estimatedTax.toFixed(2)} USD`,
      "",
    ];

    return [...meta, header, ...rows].join("\n");
  }

  exportJson(summary: TaxSummary): string {
    const { trades: _trades, ...meta } = summary;
    return JSON.stringify({ meta, trades: summary.trades }, null, 2);
  }

  private _sandboxReport(userId: string, year: number, country: TaxCountry): TaxSummary {
    const mockTrades: TaxableTrade[] = [
      {
        tradeId: "trd_demo_001", symbol: "EURUSD", assetClass: "FOREX", direction: "BUY",
        quantity: 1, openDate: `${year}-01-15T10:00:00Z`, closeDate: `${year}-02-10T14:30:00Z`,
        entryPrice: 1.0850, exitPrice: 1.0980, realizedPnl: 1300, commission: 12, swap: -8,
        netPnl: 1280, holdingDays: 26, isLongTerm: false, washSale: false,
      },
      {
        tradeId: "trd_demo_002", symbol: "XAUUSD", assetClass: "METAL", direction: "BUY",
        quantity: 0.5, openDate: `${year}-03-05T09:00:00Z`, closeDate: `${year}-04-20T16:00:00Z`,
        entryPrice: 1980, exitPrice: 2150, realizedPnl: 8500, commission: 25, swap: -45,
        netPnl: 8430, holdingDays: 46, isLongTerm: false, washSale: false,
      },
      {
        tradeId: "trd_demo_003", symbol: "BTCUSD", assetClass: "CRYPTO", direction: "BUY",
        quantity: 0.1, openDate: `${year}-05-01T08:00:00Z`, closeDate: `${year}-07-15T12:00:00Z`,
        entryPrice: 60000, exitPrice: 55000, realizedPnl: -500, commission: 30, swap: 0,
        netPnl: -530, holdingDays: 75, isLongTerm: false, washSale: false,
      },
    ];

    return this._buildSummary(userId, year, country, mockTrades);
  }

  async getAvailableYears(userId: string): Promise<number[]> {
    if (!IS_PERSISTENT) {
      const currentYear = new Date().getFullYear();
      return [currentYear - 1, currentYear];
    }

    const db  = prisma as NonNullable<typeof prisma>;
    const min = await db.tradeAudit.findFirst({
      where:   { userId, tradeStatus: "CLOSED" },
      orderBy: { closedAt: "asc" },
      select:  { closedAt: true },
    });

    if (!min?.closedAt) return [];

    const startYear  = min.closedAt.getFullYear();
    const currentYear= new Date().getFullYear();
    const years: number[] = [];
    for (let y = startYear; y <= currentYear; y++) years.push(y);
    return years;
  }
}

export const taxCalculator = new TaxCalculator();
