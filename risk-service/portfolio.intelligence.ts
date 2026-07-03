/**
 * PortfolioIntelligence — pre-trade-context aggregator (Task 13, Phase 5).
 *
 * Assembles three already-real, already-tested engines (VarEngine, the
 * portfolio CorrelationMatrixEngine, ExposureAnalyticsService) plus 5 new
 * metrics built from the simplest standard formula, never an invented one.
 *
 * `PortfolioDecisionContext` is built and exposed here but deliberately NOT
 * wired into risk-service/risk.engine.ts's preTradeCheck()/PreTradeRiskResult —
 * that wiring is Decision Engine territory (Module 8), explicitly deferred to
 * its own separately-approved plan because it touches live trade approval.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { varEngine, type VarReport } from "./var.engine.js";
import { correlationMatrix } from "./correlation.matrix.js";
import { exposureAnalyticsService, type ExposureAnalytics, type AssetClassExposure } from "../analytics/exposure.analytics.js";
import { portfolioAnalyticsService } from "../analytics/portfolio.analytics.js";
import { currenciesForSymbol } from "../economic-calendar/economic.event.service.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PortfolioHeat = {
  riskAtStakeUsd: number;
  pctOfEquity: number;
  /** Open positions with no stopLoss set — excluded from riskAtStakeUsd (unbounded risk, not assumed). */
  unprotectedPositions: number;
};

export type CurrencyExposureLeg = {
  currency: string;
  /** Net long(+)/short(-) USD-notional exposure to this currency across all open positions' base/quote legs. */
  netExposureUsd: number;
};

export type KellyAllocationResult = {
  winProbability: number; // p — from PortfolioAnalytics.winRate / 100 (day-level win rate, not trade-level)
  payoffRatio: number;    // b — avgWin / avgLoss
  /** f* = p - (1-p)/b (Kelly 1956). Not clamped to 0 — a negative value is the formula honestly reporting a negative edge, not an error. */
  fullKelly: number;
  /** Half of fullKelly — the standard "half-Kelly" practitioner convention for a less aggressive sizing recommendation. */
  halfKelly: number;
};

export type ExpectedDrawdownPoint = {
  daysAhead: number;
  /** Re-expression of VarEngine's existing VaR95 forward path (historicalVar95.varUsd * daysAhead) as % of equity — not a new model. */
  drawdownPct: number;
};

export type PortfolioDecisionContext = {
  userId: string;
  generatedAt: string;

  var: VarReport;
  diversity: number; // CorrelationMatrixEngine.compute().diversity, reused as-is
  exposure: ExposureAnalytics;

  portfolioHeat: PortfolioHeat;
  /** Asset-class breakdown reused as a labeled SECTOR PROXY — no real sector/GICS data exists on this platform. */
  sectorProxy: AssetClassExposure[];
  currencyExposure: CurrencyExposureLeg[];
  /** null when there isn't enough closed-trade history to compute a meaningful payoff ratio (mirrors CalibrationService's insufficient_data convention). */
  kellyAllocation: KellyAllocationResult | null;
  expectedDrawdown: ExpectedDrawdownPoint[];
};

type PositionRiskRow = { symbol: string; side: string; quantity: number; entryPrice: number; markPrice: number; stopLoss: number | null };

async function openPositionRiskRows(userId: string): Promise<PositionRiskRow[]> {
  if (!IS_PERSISTENT) return [];
  const rows = await prisma.position.findMany({
    where:  { userId, status: "OPEN" },
    select: { symbol: true, side: true, quantity: true, entryPrice: true, markPrice: true, stopLoss: true },
  });
  return rows.map((p) => ({
    symbol:     p.symbol,
    side:       p.side,
    quantity:   p.quantity.toNumber(),
    entryPrice: p.entryPrice.toNumber(),
    markPrice:  p.markPrice?.toNumber() ?? p.entryPrice.toNumber(),
    stopLoss:   p.stopLoss?.toNumber() ?? null,
  }));
}

function computePortfolioHeat(rows: PositionRiskRow[], equity: number): PortfolioHeat {
  let riskAtStakeUsd = 0;
  let unprotectedPositions = 0;
  for (const row of rows) {
    if (row.stopLoss === null) { unprotectedPositions++; continue; }
    riskAtStakeUsd += row.quantity * Math.abs(row.entryPrice - row.stopLoss);
  }
  return {
    riskAtStakeUsd: Math.round(riskAtStakeUsd * 100) / 100,
    pctOfEquity: equity > 0 ? Math.round((riskAtStakeUsd / equity) * 10000) / 100 : 0,
    unprotectedPositions,
  };
}

/**
 * Standard FX convention: going long a pair is long its base currency and
 * short its quote currency (and the mirror for short positions), in equal
 * USD-notional amounts. currenciesForSymbol() returns [base, quote] — reused
 * as-is, not reparsed. For non-FX symbols (indices/crypto/commodities) this
 * is an honest best-effort extension of the same existing mapping, not a new
 * currency model.
 */
function computeCurrencyExposure(rows: PositionRiskRow[]): CurrencyExposureLeg[] {
  const byCurrency = new Map<string, number>();
  for (const row of rows) {
    const [base, quote] = currenciesForSymbol(row.symbol);
    if (!base || !quote) continue;
    const notional = row.quantity * row.markPrice;
    const sign = row.side === "BUY" ? 1 : -1;
    byCurrency.set(base, (byCurrency.get(base) ?? 0) + sign * notional);
    byCurrency.set(quote, (byCurrency.get(quote) ?? 0) - sign * notional);
  }
  return Array.from(byCurrency.entries())
    .map(([currency, netExposureUsd]) => ({ currency, netExposureUsd: Math.round(netExposureUsd * 100) / 100 }))
    .sort((a, b) => Math.abs(b.netExposureUsd) - Math.abs(a.netExposureUsd));
}

function computeExpectedDrawdown(report: VarReport): ExpectedDrawdownPoint[] {
  const var95 = report.historicalVar95.varUsd;
  return report.marginForecast.map((point) => ({
    daysAhead: point.daysAhead,
    drawdownPct: report.equity > 0 ? Math.round(((var95 * point.daysAhead) / report.equity) * 10000) / 100 : 0,
  }));
}

async function computeKellyAllocation(userId: string): Promise<KellyAllocationResult | null> {
  const analytics = await portfolioAnalyticsService.getAnalytics(userId);
  if (analytics.dataPoints === 0 || analytics.avgLoss === 0) return null;

  const p = analytics.winRate / 100;
  const b = analytics.avgWin / analytics.avgLoss;
  const fullKelly = Number((p - (1 - p) / b).toFixed(4));
  return { winProbability: p, payoffRatio: Number(b.toFixed(4)), fullKelly, halfKelly: Number((fullKelly / 2).toFixed(4)) };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class PortfolioIntelligenceService {
  async assemble(userId: string): Promise<PortfolioDecisionContext> {
    const [varReport, matrix, exposure, rows, kellyAllocation] = await Promise.all([
      varEngine.computeVaR(userId, 1),
      correlationMatrix.compute(userId),
      exposureAnalyticsService.getExposure(userId),
      openPositionRiskRows(userId),
      computeKellyAllocation(userId),
    ]);

    return {
      userId,
      generatedAt: new Date().toISOString(),
      var: varReport,
      diversity: matrix.diversity,
      exposure,
      portfolioHeat: computePortfolioHeat(rows, varReport.equity),
      sectorProxy: exposure.byAssetClass,
      currencyExposure: computeCurrencyExposure(rows),
      kellyAllocation,
      expectedDrawdown: computeExpectedDrawdown(varReport),
    };
  }
}

export const portfolioIntelligence = new PortfolioIntelligenceService();
export default PortfolioIntelligenceService;
