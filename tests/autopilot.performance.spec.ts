/**
 * autopilot.performance.spec.ts
 *
 * Task 14, Phase 4 — getUserAutopilotPerformance(), the client-facing "my
 * autopilot results" view scoped to Position rows with openedByAutopilot=true.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn().mockResolvedValue([]),
}));

let isPersistent = true;

vi.mock("../shared/db.js", () => ({
  get IS_PERSISTENT() { return isPersistent; },
  prisma: { position: { findMany: mockFindMany } },
}));

import { getUserAutopilotPerformance } from "../autopilot-service/autopilot.performance.js";

function dec(n: number) {
  return { toNumber: () => n };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "pos-1", symbol: "EURUSD", side: "BUY", pnl: dec(0), status: "OPEN",
    openedAt: new Date("2026-01-01T00:00:00Z"), closedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  isPersistent = true;
  mockFindMany.mockReset().mockResolvedValue([]);
});

describe("getUserAutopilotPerformance", () => {
  it("returns a NO_DATA zero-state when not persistent", async () => {
    isPersistent = false;
    const perf = await getUserAutopilotPerformance("user-1");
    expect(perf).toEqual({
      status: "NO_DATA", openCount: 0, closedCount: 0, winCount: 0, winRate: 0,
      totalPnl: 0, totalPnlOpen: 0, avgHoldHours: null, recentTrades: [],
    });
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("returns status REAL with a zeroed-out shape when there are no autopilot positions at all", async () => {
    mockFindMany.mockResolvedValue([]);
    const perf = await getUserAutopilotPerformance("user-1");
    expect(perf.status).toBe("REAL");
    expect(perf.openCount).toBe(0);
    expect(perf.winRate).toBe(0);
    expect(perf.avgHoldHours).toBeNull();
  });

  it("computes winRate, totalPnl and totalPnlOpen correctly across a mix of open/closed/win/loss positions", async () => {
    mockFindMany.mockResolvedValue([
      row({ id: "1", status: "CLOSED", pnl: dec(100), closedAt: new Date("2026-01-01T10:00:00Z") }), // win
      row({ id: "2", status: "CLOSED", pnl: dec(-40), closedAt: new Date("2026-01-01T12:00:00Z") }),  // loss
      row({ id: "3", status: "CLOSED", pnl: dec(20), closedAt: new Date("2026-01-01T14:00:00Z") }),   // win
      row({ id: "4", status: "OPEN", pnl: dec(15) }),
    ]);

    const perf = await getUserAutopilotPerformance("user-1");

    expect(perf.closedCount).toBe(3);
    expect(perf.openCount).toBe(1);
    expect(perf.winCount).toBe(2);
    expect(perf.winRate).toBeCloseTo((2 / 3) * 100, 1);
    expect(perf.totalPnl).toBe(80); // 100 - 40 + 20
    expect(perf.totalPnlOpen).toBe(15);
  });

  it("guards against division by zero: winRate is 0 (not NaN) with zero closed trades", async () => {
    mockFindMany.mockResolvedValue([row({ status: "OPEN" })]);
    const perf = await getUserAutopilotPerformance("user-1");
    expect(perf.winRate).toBe(0);
    expect(Number.isNaN(perf.winRate)).toBe(false);
  });

  it("avgHoldHours is null (not NaN) when there are no closed trades, and a real average otherwise", async () => {
    const noClosed = await getUserAutopilotPerformance("user-1"); // empty findMany from beforeEach
    expect(noClosed.avgHoldHours).toBeNull();

    mockFindMany.mockResolvedValue([
      row({ id: "1", status: "CLOSED", openedAt: new Date("2026-01-01T00:00:00Z"), closedAt: new Date("2026-01-01T02:00:00Z") }), // 2h
      row({ id: "2", status: "CLOSED", openedAt: new Date("2026-01-01T00:00:00Z"), closedAt: new Date("2026-01-01T06:00:00Z") }), // 6h
    ]);
    const withClosed = await getUserAutopilotPerformance("user-1");
    expect(withClosed.avgHoldHours).toBe(4); // (2+6)/2
  });

  it("orders recentTrades by openedAt desc (as returned by the query) and caps at 10", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => row({ id: `pos-${i}`, openedAt: new Date(2026, 0, 15 - i) }));
    mockFindMany.mockResolvedValue(rows);

    const perf = await getUserAutopilotPerformance("user-1");

    expect(perf.recentTrades).toHaveLength(10);
    expect(perf.recentTrades[0]!.id).toBe("pos-0");
  });
});
