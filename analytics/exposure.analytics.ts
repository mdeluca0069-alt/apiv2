/**
 * ExposureAnalyticsService — real portfolio exposure computation from Position table.
 *
 * Metrics:
 *   totalNotional         — gross notional value of all open positions
 *   totalMarginUsed       — sum of locked margin
 *   netExposure           — long notional minus short notional
 *   grossExposure         — long + short notional (no netting)
 *   byAssetClass          — exposure % and USD by asset class
 *   bySymbol              — top-20 symbol exposures
 *   concentrationRisk     — HHI (Herfindahl–Hirschman Index), 0-1
 *   largestPosition       — symbol + notional + % of portfolio
 *   longShortRatio        — long notional / short notional
 *   openPositionCount     — number of open positions
 *   assetClassDiversification — 1 - HHI (higher = more diversified)
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { liveNotional } from "../market-data/position.valuation.js";

export type AssetClassExposure = {
  class:     string;
  notional:  number;
  pct:       number;
  long:      number;
  short:     number;
  netLong:   number;
};

export type SymbolExposure = {
  symbol:   string;
  side:     string;
  notional: number;
  pct:      number;
  pnl:      number;
};

export type ExposureAnalytics = {
  totalNotional:             number;
  totalMarginUsed:           number;
  netExposure:               number;
  grossExposure:             number;
  longNotional:              number;
  shortNotional:             number;
  longShortRatio:            number;
  concentrationRisk:         number;
  assetClassDiversification: number;
  openPositionCount:         number;
  byAssetClass:              AssetClassExposure[];
  bySymbol:                  SymbolExposure[];
  largestPosition:           SymbolExposure | null;
  generatedAt:               string;
};

function emptyExposure(): ExposureAnalytics {
  return {
    totalNotional: 0, totalMarginUsed: 0, netExposure: 0, grossExposure: 0,
    longNotional: 0, shortNotional: 0, longShortRatio: 0,
    concentrationRisk: 0, assetClassDiversification: 1,
    openPositionCount: 0, byAssetClass: [], bySymbol: [],
    largestPosition: null, generatedAt: new Date().toISOString(),
  };
}

/** Classify symbol into institutional asset class. */
function classifySymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  if (/^(BTC|ETH|LTC|XRP|SOL|ADA|DOT|DOGE|LINK|AVAX|MATIC)/.test(s)) return "Crypto";
  if (/^(XAU|XAG|XPT|XPD)/.test(s))                                   return "Metals";
  if (/^(USOIL|UKOIL|NG|WTI|BRENT|OIL)/.test(s))                      return "Energy";
  if (/^(US[0-9]|SP[0-9]|NAS|DAX|CAC|FTSE|DE[0-9]|UK[0-9]|JP[0-9])/.test(s)) return "Indices";
  if (/^(AAPL|TSLA|MSFT|GOOG|AMZN|NVDA|META|NFLX)/.test(s))           return "Equities";
  // FX pairs: 6-char alphanumeric only
  if (/^[A-Z]{6}$/.test(s)) return "FX";
  return "Other";
}

export class ExposureAnalyticsService {

  async getExposure(userId?: string): Promise<ExposureAnalytics> {
    if (!IS_PERSISTENT) return emptyExposure();

    const where = { ...(userId ? { userId } : {}), status: "OPEN" };

    const positions = await prisma.position.findMany({
      where,
      select: {
        symbol:    true,
        side:      true,
        quantity:  true,
        entryPrice: true,
        marginUsed: true,
        pnl:        true,
      },
    });

    if (positions.length === 0) return emptyExposure();

    let longNotional  = 0;
    let shortNotional = 0;
    let totalMargin   = 0;
    let totalPnl      = 0;

    // Per-symbol aggregation
    const symbolMap = new Map<string, { long: number; short: number; pnl: number; margin: number; side: string }>();

    for (const pos of positions) {
      // MARKET_DATA_FREEZE.md §0.3: live quoteCache valuation, not the
      // Position.markPrice DB column -- see market-data/position.valuation.ts.
      const notional = liveNotional({ symbol: pos.symbol, quantity: pos.quantity.toNumber(), entryPrice: pos.entryPrice.toNumber() });
      const side     = pos.side;
      const pnl      = pos.pnl.toNumber();
      const margin   = pos.marginUsed.toNumber();

      if (side === "BUY") longNotional  += notional;
      else                shortNotional += notional;

      totalMargin += margin;
      totalPnl    += pnl;

      const existing = symbolMap.get(pos.symbol);
      if (existing) {
        if (side === "BUY") existing.long  += notional;
        else                existing.short += notional;
        existing.pnl    += pnl;
        existing.margin += margin;
      } else {
        symbolMap.set(pos.symbol, {
          long:  side === "BUY" ? notional : 0,
          short: side === "SELL" ? notional : 0,
          pnl, margin, side,
        });
      }
    }

    const grossExposure = longNotional + shortNotional;
    const netExposure   = longNotional - shortNotional;
    const longShortRatio = shortNotional > 0 ? Math.round((longNotional / shortNotional) * 100) / 100 : longNotional > 0 ? 999 : 1;

    // By symbol (sorted by total notional)
    const bySymbol: SymbolExposure[] = Array.from(symbolMap.entries())
      .map(([symbol, v]) => ({
        symbol,
        side:     v.long >= v.short ? "LONG" : "SHORT",
        notional: v.long + v.short,
        pct:      grossExposure > 0 ? Math.round(((v.long + v.short) / grossExposure) * 1000) / 10 : 0,
        pnl:      Math.round(v.pnl * 100) / 100,
      }))
      .sort((a, b) => b.notional - a.notional)
      .slice(0, 20);

    // By asset class
    const classMap = new Map<string, { long: number; short: number }>();
    for (const pos of positions) {
      const cls      = classifySymbol(pos.symbol);
      const notional = liveNotional({ symbol: pos.symbol, quantity: pos.quantity.toNumber(), entryPrice: pos.entryPrice.toNumber() });
      const existing = classMap.get(cls) ?? { long: 0, short: 0 };
      if (pos.side === "BUY") existing.long  += notional;
      else                    existing.short += notional;
      classMap.set(cls, existing);
    }

    const byAssetClass: AssetClassExposure[] = Array.from(classMap.entries())
      .map(([cls, v]) => ({
        class:   cls,
        notional: v.long + v.short,
        pct:     grossExposure > 0 ? Math.round(((v.long + v.short) / grossExposure) * 1000) / 10 : 0,
        long:    Math.round(v.long  * 100) / 100,
        short:   Math.round(v.short * 100) / 100,
        netLong: Math.round((v.long - v.short) * 100) / 100,
      }))
      .sort((a, b) => b.notional - a.notional);

    // HHI concentration: sum of (weight_i)^2
    const weights = bySymbol.map((s) => (grossExposure > 0 ? s.notional / grossExposure : 0));
    const hhi = weights.reduce((sum, w) => sum + w * w, 0);

    const largestPosition = bySymbol[0] ?? null;

    return {
      totalNotional:             Math.round(grossExposure * 100) / 100,
      totalMarginUsed:           Math.round(totalMargin * 100) / 100,
      netExposure:               Math.round(netExposure * 100) / 100,
      grossExposure:             Math.round(grossExposure * 100) / 100,
      longNotional:              Math.round(longNotional * 100) / 100,
      shortNotional:             Math.round(shortNotional * 100) / 100,
      longShortRatio,
      concentrationRisk:         Math.round(hhi * 10000) / 100,
      assetClassDiversification: Math.round((1 - hhi) * 10000) / 100,
      openPositionCount:         positions.length,
      byAssetClass,
      bySymbol,
      largestPosition,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const exposureAnalyticsService = new ExposureAnalyticsService();
