/**
 * VarEngine — institutional Value-at-Risk computation.
 *
 * Methods:
 *
 *   historicalVaR   — uses actual past P&L distribution from TradeAudit
 *                     Sorts daily PnLs ascending; takes the (1-confidence)th percentile.
 *
 *   parametricVaR   — assumes normal distribution; σ × z-score × portfolio equity.
 *                     z-score: 95% = 1.645, 99% = 2.326.
 *
 *   stressTest      — applies predefined shock scenarios to current portfolio.
 *                     Each scenario is a % price move by asset class.
 *
 *   marginForecast  — projects margin level under gradual adverse drift.
 *
 * All values in USD, expressed as positive loss amounts.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { liveNotional } from "../market-data/position.valuation.js";

// z-scores for common confidence levels
const Z_SCORES: Record<number, number> = {
  90: 1.282,
  95: 1.645,
  99: 2.326,
};

export type VarEstimate = {
  confidence:   number;
  horizonDays:  number;
  varUsd:       number;
  varPct:       number;
  method:       "historical" | "parametric";
};

export type StressScenario = {
  name:          string;
  description:   string;
  shockPct:      number;
  estimatedLoss: number;
  marginImpact:  number;
  severity:      "mild" | "moderate" | "severe" | "extreme";
};

export type MarginForecastPoint = {
  daysAhead:      number;
  marginLevel:    number;
  riskZone:       "safe" | "caution" | "danger" | "stop_out";
};

export type VarReport = {
  equity:           number;
  historicalVar95:  VarEstimate;
  historicalVar99:  VarEstimate;
  parametricVar95:  VarEstimate;
  parametricVar99:  VarEstimate;
  expectedShortfall95: number;
  stressScenarios:  StressScenario[];
  marginForecast:   MarginForecastPoint[];
  dataPoints:       number;
  generatedAt:      string;
};

// Pre-defined institutional stress scenarios
const STRESS_SCENARIOS: Omit<StressScenario, "estimatedLoss" | "marginImpact">[] = [
  {
    name:        "FX Flash Crash",
    description: "Sudden 3% FX move (similar to Jan 2015 CHF event)",
    shockPct:    -3.0,
    severity:    "moderate",
  },
  {
    name:        "Equity Black Monday",
    description: "10% equity index drop (similar to Oct 1987 or Mar 2020)",
    shockPct:    -10.0,
    severity:    "severe",
  },
  {
    name:        "Crypto Crash",
    description: "30% crypto drop (similar to May 2022 or Nov 2022)",
    shockPct:    -30.0,
    severity:    "extreme",
  },
  {
    name:        "Gold Spike",
    description: "5% gold appreciation (flight-to-safety scenario)",
    shockPct:    5.0,
    severity:    "mild",
  },
  {
    name:        "Oil Supply Shock",
    description: "15% oil price surge (geopolitical disruption)",
    shockPct:    15.0,
    severity:    "moderate",
  },
  {
    name:        "Sovereign Bond Crisis",
    description: "2% yield spike → 8% index drop (2011 Eurozone scenario)",
    shockPct:    -8.0,
    severity:    "severe",
  },
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil(sorted.length * (1 - p / 100)) - 1);
  return Math.abs(sorted[idx]!);
}

/** Expected Shortfall (CVaR): mean of losses beyond VaR. */
function expectedShortfall(sorted: number[], p: number): number {
  const cutIdx  = Math.ceil(sorted.length * (1 - p / 100));
  const tail    = sorted.slice(0, cutIdx);
  if (tail.length === 0) return 0;
  return Math.abs(tail.reduce((s, v) => s + v, 0) / tail.length);
}

export class VarEngine {

  async computeVaR(userId: string, horizonDays = 1): Promise<VarReport> {
    if (!IS_PERSISTENT) return this._sandboxReport();

    const windowDays = Math.max(252, horizonDays * 252); // minimum 1 year of history
    const since      = new Date(Date.now() - windowDays * 86_400_000);

    const [wallet, openPositions, tradeHistory] = await Promise.all([
      prisma.walletAccount.findUnique({ where: { userId }, select: { balance: true, locked: true } }),
      prisma.position.findMany({
        where:  { userId, status: "OPEN" },
        select: { pnl: true, marginUsed: true, quantity: true, entryPrice: true, symbol: true },
      }),
      prisma.tradeAudit.findMany({
        where:   { userId, tradeStatus: "CLOSED", closedAt: { gte: since, not: null } },
        select:  { pnlRealized: true, closedAt: true },
        orderBy: { closedAt: "asc" },
      }),
    ]);

    const balance   = Number(wallet?.balance ?? 0);
    const locked    = Number(wallet?.locked  ?? 0);
    const unrealized = openPositions.reduce((s, p) => s + p.pnl.toNumber(), 0);
    const equity    = balance + unrealized;
    const marginUsed = locked;

    // Aggregate daily PnL from trade history
    const dayMap = new Map<string, number>();
    for (const t of tradeHistory) {
      const key = t.closedAt!.toISOString().slice(0, 10);
      dayMap.set(key, (dayMap.get(key) ?? 0) + Number(t.pnlRealized ?? 0));
    }

    const dailyPnls = Array.from(dayMap.values());
    const sortedAsc = [...dailyPnls].sort((a, b) => a - b); // ascending (losses first)
    const dataPoints = dailyPnls.length;

    // Historical VaR
    const hVar95  = percentile(sortedAsc, 95);
    const hVar99  = percentile(sortedAsc, 99);
    const hES95   = expectedShortfall(sortedAsc, 95);

    // Scale to horizon: VaR(T) = VaR(1) × √T (square-root of time)
    const scale = Math.sqrt(horizonDays);

    // Parametric VaR using empirical σ
    const mean = dailyPnls.reduce((s, v) => s + v, 0) / (dailyPnls.length || 1);
    const variance = dailyPnls.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (dailyPnls.length || 1);
    const sigma = Math.sqrt(variance);

    const pVar95  = (Z_SCORES[95]! * sigma * scale) || (equity * 0.016 * scale);
    const pVar99  = (Z_SCORES[99]! * sigma * scale) || (equity * 0.023 * scale);

    // Stress scenarios applied to current portfolio.
    // MARKET_DATA_FREEZE.md §0.3: live quoteCache valuation, not the
    // Position.markPrice DB column -- see market-data/position.valuation.ts.
    const grossNotional = openPositions.reduce(
      (s, p) => s + liveNotional({ symbol: p.symbol, quantity: p.quantity.toNumber(), entryPrice: p.entryPrice.toNumber() }), 0
    );

    const stressScenarios: StressScenario[] = STRESS_SCENARIOS.map((sc) => {
      const lossEstimate = Math.abs(grossNotional * (sc.shockPct / 100));
      return {
        ...sc,
        estimatedLoss: Math.round(lossEstimate * 100) / 100,
        marginImpact:  Math.round((equity > 0 ? (lossEstimate / equity) * 100 : 0) * 10) / 10,
      };
    });

    // Margin forecast (1-5 days ahead under worst-case daily loss = VaR95)
    const marginForecast: MarginForecastPoint[] = [];
    for (let d = 0; d <= 5; d++) {
      const projectedLoss = hVar95 * d;
      const projEquity    = Math.max(0, equity - projectedLoss);
      const marginLevel   = marginUsed > 0 ? (projEquity / marginUsed) * 100 : 9999;
      marginForecast.push({
        daysAhead:   d,
        marginLevel: Math.round(marginLevel * 10) / 10,
        riskZone:    marginLevel > 200 ? "safe"
                   : marginLevel > 100 ? "caution"
                   : marginLevel > 50  ? "danger"
                   : "stop_out",
      });
    }

    const mkVar = (method: "historical" | "parametric", v95: number, v99: number): [VarEstimate, VarEstimate] => [
      {
        confidence: 95, horizonDays, varUsd: Math.round(v95 * scale * 100) / 100,
        varPct: equity > 0 ? Math.round((v95 * scale / equity) * 10000) / 100 : 0,
        method,
      },
      {
        confidence: 99, horizonDays, varUsd: Math.round(v99 * scale * 100) / 100,
        varPct: equity > 0 ? Math.round((v99 * scale / equity) * 10000) / 100 : 0,
        method,
      },
    ];

    const [hv95, hv99] = mkVar("historical", hVar95, hVar99);
    const [pv95, pv99] = mkVar("parametric", pVar95, pVar99);

    return {
      equity:               Math.round(equity * 100) / 100,
      historicalVar95:      hv95,
      historicalVar99:      hv99,
      parametricVar95:      pv95,
      parametricVar99:      pv99,
      expectedShortfall95:  Math.round(hES95 * scale * 100) / 100,
      stressScenarios,
      marginForecast,
      dataPoints,
      generatedAt:          new Date().toISOString(),
    };
  }

  private _sandboxReport(): VarReport {
    const equity = 100_000;
    const mkV = (method: "historical" | "parametric", c: number, v: number): VarEstimate => ({
      confidence: c, horizonDays: 1, varUsd: v, varPct: (v / equity) * 100, method,
    });
    return {
      equity,
      historicalVar95:     mkV("historical", 95, 1240),
      historicalVar99:     mkV("historical", 99, 1850),
      parametricVar95:     mkV("parametric", 95, 1150),
      parametricVar99:     mkV("parametric", 99, 1720),
      expectedShortfall95: 1680,
      stressScenarios: STRESS_SCENARIOS.map((sc) => ({
        ...sc,
        estimatedLoss: Math.abs(equity * (sc.shockPct / 100)),
        marginImpact:  Math.abs(sc.shockPct),
      })),
      marginForecast: [
        { daysAhead: 0, marginLevel: 842, riskZone: "safe" },
        { daysAhead: 1, marginLevel: 620, riskZone: "safe" },
        { daysAhead: 2, marginLevel: 420, riskZone: "safe" },
        { daysAhead: 3, marginLevel: 280, riskZone: "caution" },
        { daysAhead: 4, marginLevel: 160, riskZone: "danger" },
        { daysAhead: 5, marginLevel: 72,  riskZone: "danger" },
      ],
      dataPoints:  0,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const varEngine = new VarEngine();
