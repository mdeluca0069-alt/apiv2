/**
 * global.risk.supervisor.spec.ts
 *
 * Task 13, Phase 1 — first-ever test coverage for GlobalRiskSupervisor, the
 * platform-wide autopilot safety monitor. Every dependency is mocked to a
 * deterministic "clean" baseline by default; each test overrides only the
 * signal it targets, mirroring the pattern used throughout this project's
 * other autopilot test files.
 *
 * Key invariants this file exists to prove:
 *   - Escalation (worse mode) applies on the very next cycle.
 *   - Recovery (better mode) only applies after RECOVERY_CYCLES consecutive
 *     clean cycles — hysteresis, prevents mode-flapping.
 *   - An admin override fully replaces automatic control until cleared.
 *   - AuditLog/alert fire only on an actual mode change, never every cycle.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// REALTIME_FREEZE.md Critical #2: global.risk.supervisor.ts now routes
// through immutableAudit.write() (real module, not mocked) instead of
// calling prisma.auditLog.create() directly -- $transaction/$queryRaw/
// auditLog.findFirst satisfy its chain-head lock and lookup.
const {
  mockBSFindUnique, mockBSUpsert, mockAuditCreate,
  mockPosFindMany, mockPosAggregate, mockWalletAggregate, mockOrderFindMany,
  mockCheckDb, mockCheckRedis, mockCheckMarket,
  mockGetSnapshot, mockGetRegimeSnapshot, mockMetricsGet, mockAlertSend,
  mockPrisma,
} = vi.hoisted(() => {
  const mockBSFindUnique = vi.fn();
  const mockBSUpsert     = vi.fn().mockResolvedValue({});
  const mockAuditCreate  = vi.fn().mockResolvedValue({});
  const mockPosFindMany  = vi.fn().mockResolvedValue([]);
  const mockPosAggregate = vi.fn();
  const mockWalletAggregate = vi.fn();
  const mockOrderFindMany   = vi.fn().mockResolvedValue([]);
  const mockCheckDb      = vi.fn();
  const mockCheckRedis   = vi.fn();
  const mockCheckMarket  = vi.fn();
  const mockGetSnapshot  = vi.fn();
  const mockGetRegimeSnapshot = vi.fn();
  const mockMetricsGet   = vi.fn();
  const mockAlertSend    = vi.fn().mockResolvedValue(undefined);
  const mockPrisma: Record<string, unknown> = {
    brokerSetting: { findUnique: mockBSFindUnique, upsert: mockBSUpsert },
    auditLog:      { create: mockAuditCreate },
    position:      { findMany: mockPosFindMany, aggregate: mockPosAggregate },
    walletAccount: { aggregate: mockWalletAggregate },
    order:         { findMany: mockOrderFindMany },
    $executeRaw:   vi.fn().mockResolvedValue(0),
    $queryRaw:     vi.fn().mockResolvedValue([]),
  };
  mockPrisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(mockPrisma));
  return {
    mockBSFindUnique, mockBSUpsert, mockAuditCreate,
    mockPosFindMany, mockPosAggregate, mockWalletAggregate, mockOrderFindMany,
    mockCheckDb, mockCheckRedis, mockCheckMarket,
    mockGetSnapshot, mockGetRegimeSnapshot, mockMetricsGet, mockAlertSend,
    mockPrisma,
  };
});

let isPersistent = true;

vi.mock("../shared/db.js", () => ({
  get IS_PERSISTENT() { return isPersistent; },
  prisma: mockPrisma,
}));

vi.mock("../shared/health.check.js", () => ({
  checkDatabaseHealth: mockCheckDb,
  checkRedisHealth:    mockCheckRedis,
  checkMarketDataHealth: mockCheckMarket,
}));

vi.mock("../market-data/feed.health.monitor.js", () => ({
  feedHealthMonitor: { getSnapshot: mockGetSnapshot },
}));

vi.mock("../ai-core/regime.snapshot.js", () => ({
  getRegimeSnapshot: mockGetRegimeSnapshot,
}));

vi.mock("../gateway/metrics.js", () => ({
  metrics: { get: mockMetricsGet, inc: vi.fn(), set: vi.fn(), observe: vi.fn(), register: vi.fn() },
}));

vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { send: mockAlertSend },
}));

import { GlobalRiskSupervisor } from "../risk-service/global.risk.supervisor.js";

function dec(n: number) {
  return { toNumber: () => n };
}

const CLEAN_FEED_SNAPSHOT = {
  checkedAt: new Date().toISOString(), circuitOpen: false,
  staleSymbols: [] as string[], freshSymbols: ["EURUSD", "XAUUSD"], totalSymbols: 2,
  qualityMetrics: [
    { symbol: "EURUSD", fresh: true, ageMs: 100, tickCount: 10, ticksPerMin: 5, lastBid: 1.1, lastAsk: 1.1002, spread: 0.0002, spreadQuality: "ok" as const, lastReceivedAt: null },
    { symbol: "XAUUSD", fresh: true, ageMs: 100, tickCount: 10, ticksPerMin: 5, lastBid: 2000, lastAsk: 2000.5, spread: 0.5, spreadQuality: "ok" as const, lastReceivedAt: null },
  ],
  reconnectAudit: [], ordersBlocked: false,
};

beforeEach(() => {
  isPersistent = true;
  mockBSFindUnique.mockReset().mockResolvedValue(null);
  mockBSUpsert.mockReset().mockResolvedValue({});
  mockAuditCreate.mockReset().mockResolvedValue({});
  mockPosFindMany.mockReset().mockResolvedValue([]);
  mockPosAggregate.mockReset().mockResolvedValue({ _sum: { pnl: dec(0) } });
  mockWalletAggregate.mockReset().mockResolvedValue({ _sum: { balance: dec(100_000) } });
  mockOrderFindMany.mockReset().mockResolvedValue([]);
  mockCheckDb.mockReset().mockResolvedValue({ service: "database", status: "operational", latencyMs: 10, checkedAt: new Date().toISOString() });
  mockCheckRedis.mockReset().mockResolvedValue({ service: "redis", status: "operational", latencyMs: 5, checkedAt: new Date().toISOString() });
  mockCheckMarket.mockReset().mockReturnValue({ service: "market-data", status: "operational", latencyMs: null, checkedAt: new Date().toISOString() });
  mockGetSnapshot.mockReset().mockReturnValue(CLEAN_FEED_SNAPSHOT);
  mockGetRegimeSnapshot.mockReset().mockReturnValue({ status: "ACTIVE", atrNormalized: 1.0, atr: 0.001, regime: "RANGING", adx: 15, adxSlope: 0, trending: false, description: "", volatilityLevel: "LOW", asOf: new Date().toISOString() });
  mockMetricsGet.mockReset().mockReturnValue(100);
  mockAlertSend.mockReset().mockResolvedValue(undefined);
});

describe("GlobalRiskSupervisor.evaluate — sandbox mode", () => {
  it("returns NORMAL with no DB calls when not persistent", async () => {
    isPersistent = false;
    const sup = new GlobalRiskSupervisor();
    const result = await sup.evaluate();
    expect(result.mode).toBe("NORMAL");
    expect(mockBSFindUnique).not.toHaveBeenCalled();
  });
});

describe("GlobalRiskSupervisor.evaluate — clean baseline", () => {
  it("stays NORMAL when every signal is clean", async () => {
    const sup = new GlobalRiskSupervisor();
    const result = await sup.evaluate();
    expect(result.mode).toBe("NORMAL");
    expect(mockAuditCreate).not.toHaveBeenCalled();
    expect(mockAlertSend).not.toHaveBeenCalled();
  });
});

describe("GlobalRiskSupervisor.evaluate — individual signals escalate correctly", () => {
  it("database offline forces FULL_AUTOPILOT_STOP immediately", async () => {
    mockCheckDb.mockResolvedValue({ service: "database", status: "offline", latencyMs: null, checkedAt: new Date().toISOString() });
    const sup = new GlobalRiskSupervisor();
    const result = await sup.evaluate();
    expect(result.mode).toBe("FULL_AUTOPILOT_STOP");
    expect(result.reason).toContain("Database offline");
  });

  it("redis offline triggers SAFE_MODE", async () => {
    mockCheckRedis.mockResolvedValue({ service: "redis", status: "offline", latencyMs: null, checkedAt: new Date().toISOString() });
    const sup = new GlobalRiskSupervisor();
    const result = await sup.evaluate();
    expect(result.mode).toBe("SAFE_MODE");
  });

  it("market data circuit open triggers EMERGENCY_MODE", async () => {
    mockCheckMarket.mockReturnValue({ service: "market-data", status: "offline", latencyMs: null, checkedAt: new Date().toISOString() });
    const sup = new GlobalRiskSupervisor();
    const result = await sup.evaluate();
    expect(result.mode).toBe("EMERGENCY_MODE");
  });

  it.each([
    [4, "NORMAL"],
    [5, "SAFE_MODE"],
    [8, "EMERGENCY_MODE"],
    [12, "FULL_AUTOPILOT_STOP"],
  ] as const)("%d consecutive autopilot losses → %s", async (count, expected) => {
    mockPosFindMany.mockResolvedValue(Array.from({ length: count }, () => ({ pnl: dec(-10) })));
    const sup = new GlobalRiskSupervisor();
    const result = await sup.evaluate();
    expect(result.mode).toBe(expected);
  });

  it("a win breaks the consecutive-loss streak", async () => {
    mockPosFindMany.mockResolvedValue([
      { pnl: dec(-10) }, { pnl: dec(-10) }, { pnl: dec(10) }, { pnl: dec(-10) }, { pnl: dec(-10) }, { pnl: dec(-10) },
    ]);
    const sup = new GlobalRiskSupervisor();
    const result = await sup.evaluate();
    expect(result.mode).toBe("NORMAL"); // streak = 2, below SAFE threshold of 5
  });

  it.each([
    [2, "NORMAL"],
    [3, "SAFE_MODE"],
    [6, "EMERGENCY_MODE"],
    [10, "FULL_AUTOPILOT_STOP"],
  ] as const)("platform drawdown of %d%% → %s", async (pct, expected) => {
    mockPosAggregate.mockResolvedValue({ _sum: { pnl: dec(-pct * 1_000) } }); // pct% of 100k equity
    const sup = new GlobalRiskSupervisor();
    const result = await sup.evaluate();
    expect(result.mode).toBe(expected);
  });

  it("stale symbols at/above threshold trigger the matching tier", async () => {
    mockGetSnapshot.mockReturnValue({ ...CLEAN_FEED_SNAPSHOT, staleSymbols: ["EURUSD", "XAUUSD", "GBPUSD"] });
    const sup = new GlobalRiskSupervisor();
    const result = await sup.evaluate();
    expect(result.mode).toBe("EMERGENCY_MODE"); // 3 >= STALE_SYMBOLS_EMERGENCY default
  });

  it("abnormal spread on enough symbols triggers SAFE_MODE", async () => {
    mockGetSnapshot.mockReturnValue({
      ...CLEAN_FEED_SNAPSHOT,
      qualityMetrics: [
        { ...CLEAN_FEED_SNAPSHOT.qualityMetrics[0]!, spreadQuality: "wide" as const },
        { ...CLEAN_FEED_SNAPSHOT.qualityMetrics[1]!, spreadQuality: "crossed" as const },
      ],
    });
    const sup = new GlobalRiskSupervisor();
    const result = await sup.evaluate();
    expect(result.mode).toBe("SAFE_MODE");
  });

  it("execution failure rate above the emergency threshold triggers EMERGENCY_MODE", async () => {
    const now = new Date();
    mockOrderFindMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        status: i < 4 ? "FILLED" : "REJECTED", createdAt: now, filledAt: i < 4 ? now : null,
      })),
    );
    const sup = new GlobalRiskSupervisor();
    const result = await sup.evaluate();
    expect(result.mode).toBe("EMERGENCY_MODE"); // 60% failure >= 30% emergency threshold
  });

  it("execution latency above the emergency threshold triggers EMERGENCY_MODE", async () => {
    const start = new Date();
    const filledAt = new Date(start.getTime() + 3000); // 3s, above 2000ms emergency threshold
    mockOrderFindMany.mockResolvedValue([{ status: "FILLED", createdAt: start, filledAt }]);
    const sup = new GlobalRiskSupervisor();
    const result = await sup.evaluate();
    expect(result.mode).toBe("EMERGENCY_MODE");
  });

  it("volatility burst on enough symbols triggers SAFE_MODE once a baseline exists", async () => {
    const sup = new GlobalRiskSupervisor();
    await sup.evaluate(); // cycle 1 — establishes baseline atrNormalized=1.0 for both symbols
    mockGetRegimeSnapshot.mockReturnValue({ status: "ACTIVE", atrNormalized: 5.0, atr: 0.005, regime: "EXPANSION", adx: 30, adxSlope: 2, trending: true, description: "", volatilityLevel: "HIGH", asOf: new Date().toISOString() });
    const result = await sup.evaluate(); // cycle 2 — 5.0 > 1.0 * 2.5 multiplier on both watched symbols
    expect(result.mode).toBe("SAFE_MODE");
  });
});

describe("GlobalRiskSupervisor.evaluate — hysteresis", () => {
  it("escalates to a worse mode immediately on a single bad cycle", async () => {
    const sup = new GlobalRiskSupervisor();
    await sup.evaluate(); // clean
    mockPosFindMany.mockResolvedValue(Array.from({ length: 8 }, () => ({ pnl: dec(-10) })));
    const result = await sup.evaluate();
    expect(result.mode).toBe("EMERGENCY_MODE");
  });

  it("does not recover until RECOVERY_CYCLES consecutive clean cycles have passed", async () => {
    const sup = new GlobalRiskSupervisor();
    mockPosFindMany.mockResolvedValue(Array.from({ length: 8 }, () => ({ pnl: dec(-10) })));
    await sup.evaluate(); // escalate to EMERGENCY_MODE
    mockPosFindMany.mockResolvedValue([]); // signals now clean

    for (let i = 0; i < 4; i++) {
      const r = await sup.evaluate();
      expect(r.mode).toBe("EMERGENCY_MODE"); // still holding — recovery streak not yet complete
    }
    const recovered = await sup.evaluate(); // 5th consecutive clean cycle
    expect(recovered.mode).toBe("NORMAL");
  });

  it("resets the recovery streak if a bad signal reappears mid-recovery", async () => {
    const sup = new GlobalRiskSupervisor();
    mockPosFindMany.mockResolvedValue(Array.from({ length: 8 }, () => ({ pnl: dec(-10) })));
    await sup.evaluate(); // EMERGENCY_MODE

    mockPosFindMany.mockResolvedValue([]);
    await sup.evaluate();
    await sup.evaluate(); // 2 clean cycles into the streak

    mockPosFindMany.mockResolvedValue(Array.from({ length: 8 }, () => ({ pnl: dec(-10) })));
    await sup.evaluate(); // bad again — streak resets, stays EMERGENCY_MODE (no change, severity equal)

    mockPosFindMany.mockResolvedValue([]);
    for (let i = 0; i < 4; i++) {
      const r = await sup.evaluate();
      expect(r.mode).toBe("EMERGENCY_MODE");
    }
    const recovered = await sup.evaluate();
    expect(recovered.mode).toBe("NORMAL");
  });
});

describe("GlobalRiskSupervisor — admin override", () => {
  it("forceMode fully replaces automatic control regardless of signals", async () => {
    const sup = new GlobalRiskSupervisor();
    await sup.forceMode("SAFE_MODE", "Manual ops decision", "admin-1");
    expect(sup.getMode()).toBe("SAFE_MODE");

    // Even clean signals must not auto-revert while the override is active.
    const result = await sup.evaluate();
    expect(result.mode).toBe("SAFE_MODE");
    expect(result.triggeredBy).toBe("admin");
  });

  it("clearOverride hands control back and re-evaluates immediately", async () => {
    const sup = new GlobalRiskSupervisor();
    await sup.forceMode("EMERGENCY_MODE", "Manual ops decision", "admin-1");
    await sup.clearOverride("admin-1");
    expect(sup.getMode()).toBe("NORMAL"); // signals are clean in this test's baseline
  });

  it("writes an audit log entry for both the override and its clearance", async () => {
    const sup = new GlobalRiskSupervisor();
    await sup.forceMode("SAFE_MODE", "Manual ops decision", "admin-1");
    await sup.clearOverride("admin-1");
    const actions = mockAuditCreate.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);
    expect(actions).toContain("risk_supervisor.mode_changed");
    expect(actions).toContain("risk_supervisor.override_cleared");
  });
});

describe("GlobalRiskSupervisor — persistence and audit hygiene", () => {
  it("persists state to BrokerSetting under the expected key on every cycle", async () => {
    const sup = new GlobalRiskSupervisor();
    await sup.evaluate();
    expect(mockBSUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: "global_risk_supervisor" },
    }));
  });

  it("writes AuditLog and sends an alert only when the mode actually changes, not every cycle", async () => {
    const sup = new GlobalRiskSupervisor();
    mockPosFindMany.mockResolvedValue(Array.from({ length: 8 }, () => ({ pnl: dec(-10) })));
    await sup.evaluate(); // change: NORMAL -> EMERGENCY_MODE
    await sup.evaluate(); // same signals, same mode -> no new audit/alert

    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAlertSend).toHaveBeenCalledTimes(1);
  });

  it("loads persisted state from BrokerSetting on load()", async () => {
    const persisted = { mode: "SAFE_MODE", reason: "restored", triggeredBy: "system", changedAt: new Date().toISOString(), signals: null, adminOverride: null };
    mockBSFindUnique.mockResolvedValue({ key: "global_risk_supervisor", value: persisted });
    const sup = new GlobalRiskSupervisor();
    await sup.load();
    expect(sup.getMode()).toBe("SAFE_MODE");
  });
});
