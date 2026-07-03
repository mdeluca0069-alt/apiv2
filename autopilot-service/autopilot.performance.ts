/**
 * autopilot.performance.ts — per-client "my autopilot results" view.
 *
 * Task 14, Phase 4. Scoped to Position rows (the authoritative realized-P&L
 * source), not SignalTelemetry (which tracks signal-level MFE/MAE, not
 * settled P&L) — same reduce/filter/Math.round arithmetic style already used
 * by the existing GET /autopilot/stats/public route, just scoped to one user
 * instead of the whole platform. No new formula.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";

export type AutopilotTradeSummary = {
  id:       string;
  symbol:   string;
  side:     string;
  pnl:      number;
  status:   string;
  openedAt: string;
  closedAt: string | null;
};

export type AutopilotPerformance = {
  status:       "NO_DATA" | "REAL";
  openCount:    number;
  closedCount:  number;
  winCount:     number;
  winRate:      number;        // 0-100, 0 when there are no closed trades yet
  totalPnl:     number;        // realized P&L, closed positions only
  totalPnlOpen: number;        // floating P&L, open positions only
  avgHoldHours: number | null; // null (not NaN) when there are no closed trades yet
  recentTrades: AutopilotTradeSummary[];
};

const RECENT_TRADES_LIMIT = 10;

function emptyPerformance(): AutopilotPerformance {
  return {
    status: "NO_DATA", openCount: 0, closedCount: 0, winCount: 0, winRate: 0,
    totalPnl: 0, totalPnlOpen: 0, avgHoldHours: null, recentTrades: [],
  };
}

export async function getUserAutopilotPerformance(userId: string): Promise<AutopilotPerformance> {
  if (!IS_PERSISTENT || !prisma) return emptyPerformance();
  const db = prisma as NonNullable<typeof prisma>;

  const rows = await db.position.findMany({
    where:  { userId, openedByAutopilot: true },
    select: { id: true, symbol: true, side: true, pnl: true, status: true, openedAt: true, closedAt: true },
    orderBy: { openedAt: "desc" },
  }).catch(() => []);

  const open   = rows.filter((r) => r.status === "OPEN");
  const closed = rows.filter((r) => r.status === "CLOSED");
  const wins   = closed.filter((r) => r.pnl.toNumber() > 0);

  const winRate  = closed.length > 0 ? Math.round((wins.length / closed.length) * 1000) / 10 : 0;
  const totalPnl     = Math.round(closed.reduce((s, r) => s + r.pnl.toNumber(), 0) * 100) / 100;
  const totalPnlOpen = Math.round(open.reduce((s, r) => s + r.pnl.toNumber(), 0) * 100) / 100;

  const holdHours = closed
    .filter((r) => r.closedAt !== null)
    .map((r) => (r.closedAt!.getTime() - r.openedAt.getTime()) / 3_600_000);
  const avgHoldHours = holdHours.length > 0
    ? Math.round((holdHours.reduce((a, b) => a + b, 0) / holdHours.length) * 10) / 10
    : null;

  const recentTrades: AutopilotTradeSummary[] = rows.slice(0, RECENT_TRADES_LIMIT).map((r) => ({
    id:       r.id,
    symbol:   r.symbol,
    side:     r.side,
    pnl:      Math.round(r.pnl.toNumber() * 100) / 100,
    status:   r.status,
    openedAt: r.openedAt.toISOString(),
    closedAt: r.closedAt ? r.closedAt.toISOString() : null,
  }));

  return {
    status: "REAL",
    openCount: open.length, closedCount: closed.length, winCount: wins.length,
    winRate, totalPnl, totalPnlOpen, avgHoldHours, recentTrades,
  };
}
