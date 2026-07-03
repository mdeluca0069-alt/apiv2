/**
 * autopilot.position.manager.spec.ts
 *
 * Task 14, Phase 1 — first-ever test coverage for AutopilotPositionManager,
 * the 30s-cycle job that applies break-even/trailing/regime-exit/time-stop to
 * open autopilot positions, plus the platform-wide circuit breaker that runs
 * alongside it. Every dependency is mocked.
 *
 * Two safety invariants this file exists to prove, explicitly:
 *   - regime-exit and time-stop NEVER fire while floating P&L is positive
 *     (they only ever cut a thesis that hasn't worked out, never a winner).
 *   - trailing/break-even SL moves only ever tighten, never loosen.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BrokerState } from "../shared/state.js";

const {
  mockGetConfig,
  mockRecordDecision,
  mockSetDailyLossLock,
  mockClose,
  mockUpdateSLTP,
  mockQuoteCacheGet,
  mockGetRegimeSnapshot,
  mockEventBusEmit,
  mockAlertSend,
  mockPositionFindMany,
  mockPositionUpdate,
  mockPositionAggregate,
  mockPositionGroupBy,
  mockWalletAggregate,
  mockGetMarginState,
} = vi.hoisted(() => ({
  mockGetConfig:        vi.fn(),
  mockRecordDecision:   vi.fn().mockResolvedValue(undefined),
  mockSetDailyLossLock: vi.fn().mockResolvedValue(undefined),
  mockClose:            vi.fn().mockResolvedValue({ ok: true }),
  mockUpdateSLTP:       vi.fn().mockResolvedValue({ ok: true }),
  mockQuoteCacheGet:    vi.fn(),
  mockGetRegimeSnapshot: vi.fn(),
  mockEventBusEmit:     vi.fn(),
  mockAlertSend:        vi.fn().mockResolvedValue(undefined),
  mockPositionFindMany: vi.fn().mockResolvedValue([]),
  mockPositionUpdate:   vi.fn().mockResolvedValue({}),
  mockPositionAggregate: vi.fn(),
  mockPositionGroupBy:  vi.fn().mockResolvedValue([]),
  mockWalletAggregate:  vi.fn(),
  mockGetMarginState:   vi.fn(),
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    position: {
      findMany:  mockPositionFindMany,
      update:    mockPositionUpdate,
      aggregate: mockPositionAggregate,
      groupBy:   mockPositionGroupBy,
    },
    walletAccount: {
      aggregate: mockWalletAggregate,
    },
  },
}));

vi.mock("../autopilot-service/autopilot.service.js", () => ({
  autopilotService: { getConfig: mockGetConfig, recordDecision: mockRecordDecision, setDailyLossLock: mockSetDailyLossLock },
}));

vi.mock("../risk-service/margin.controller.js", () => ({
  marginController: { getMarginState: mockGetMarginState },
}));

vi.mock("../trading-service/position.service.js", () => ({
  positionService: { close: mockClose, updateSLTP: mockUpdateSLTP },
}));

vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockQuoteCacheGet },
}));

vi.mock("../ai-core/regime.snapshot.js", () => ({
  getRegimeSnapshot: mockGetRegimeSnapshot,
}));

vi.mock("../events-bus/event.bus.js", () => ({
  eventBus: { emit: mockEventBusEmit },
}));

vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { send: mockAlertSend },
}));

import { AutopilotPositionManager } from "../autopilot-service/autopilot.position.manager.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function dec(n: number) {
  return { toNumber: () => n };
}

function baseCfg(overrides: Record<string, unknown> = {}) {
  return {
    regimeExitEnabled: true, maxHoursOpen: 48,
    breakEvenTriggerR: 1, trailingStopEnabled: true, trailingActivationR: 1.5, atrTrailMultiple: 2,
    maxDailyLossPct: 5, dailyLossLockedUntil: undefined,
    ...overrides,
  };
}

function basePosition(overrides: Record<string, unknown> = {}) {
  return {
    id: "pos-1", userId: "user-1", symbol: "EURUSD", side: "BUY",
    entryPrice: dec(100), stopLoss: dec(98), initialStopLoss: dec(98), pnl: dec(0),
    openedAt: new Date(), breakEvenApplied: false, trailingActive: false,
    ...overrides,
  };
}

function fakeState(overrides: { autopilotEnabled?: boolean; maxDailyAutopilotDrawdownPct?: number } = {}): BrokerState {
  return {
    getOlosGovernance: () => ({ autopilotEnabled: overrides.autopilotEnabled ?? true, maxDailyAutopilotDrawdownPct: overrides.maxDailyAutopilotDrawdownPct ?? 5 }),
    adminUpdateOlosGovernance: vi.fn(),
  } as unknown as BrokerState;
}

const INACTIVE_SNAPSHOT = { status: "INSUFFICIENT_DATA" as const, regime: null, atr: null, trending: null };

beforeEach(() => {
  mockGetConfig.mockReset().mockResolvedValue(baseCfg());
  mockRecordDecision.mockReset().mockResolvedValue(undefined);
  mockClose.mockReset().mockResolvedValue({ ok: true });
  mockUpdateSLTP.mockReset().mockResolvedValue({ ok: true });
  mockQuoteCacheGet.mockReset().mockReturnValue({ bid: 100, ask: 100.02 });
  mockGetRegimeSnapshot.mockReset().mockReturnValue(INACTIVE_SNAPSHOT);
  mockEventBusEmit.mockReset();
  mockAlertSend.mockReset().mockResolvedValue(undefined);
  mockPositionFindMany.mockReset().mockResolvedValue([]);
  mockPositionUpdate.mockReset().mockResolvedValue({});
  mockPositionAggregate.mockReset().mockResolvedValue({ _sum: { pnl: dec(0) } });
  mockWalletAggregate.mockReset().mockResolvedValue({ _sum: { balance: dec(100_000) } });
  mockPositionGroupBy.mockReset().mockResolvedValue([]);
  mockSetDailyLossLock.mockReset().mockResolvedValue(undefined);
  mockGetMarginState.mockReset().mockResolvedValue({ equity: 10_000 });
});

describe("AutopilotPositionManager.manageOpenTrades", () => {
  it("returns {checked:0,managed:0} on a clean cycle with no open autopilot positions", async () => {
    mockPositionFindMany.mockResolvedValue([]);
    const mgr = new AutopilotPositionManager();
    const result = await mgr.manageOpenTrades(fakeState());
    expect(result).toEqual({ checked: 0, managed: 0 });
    expect(mockClose).not.toHaveBeenCalled();
  });

  it("closes a position on regime-flip when floating P&L <= 0 and the regime has reversed against the side", async () => {
    mockPositionFindMany.mockResolvedValue([basePosition({ pnl: dec(0) })]);
    mockGetRegimeSnapshot.mockReturnValue({ status: "ACTIVE", regime: "BEARISH_TREND", trending: true, atr: 0.001 });

    const mgr = new AutopilotPositionManager();
    const result = await mgr.manageOpenTrades(fakeState());

    expect(result.managed).toBe(1);
    expect(mockClose).toHaveBeenCalledWith("pos-1", "user-1", expect.anything());
    expect(mockEventBusEmit).toHaveBeenCalledWith("autopilot.position_managed", expect.objectContaining({ action: "REGIME_EXIT" }));
  });

  it("never cuts a winning trade on regime-flip even when the regime is against it", async () => {
    mockPositionFindMany.mockResolvedValue([basePosition({ pnl: dec(50) })]); // winning
    mockGetRegimeSnapshot.mockReturnValue({ status: "ACTIVE", regime: "BEARISH_TREND", trending: true, atr: 0.001 });

    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(fakeState());

    expect(mockClose).not.toHaveBeenCalled();
  });

  it("silently skips regime-exit when the regime snapshot is insufficient data — no throw", async () => {
    mockPositionFindMany.mockResolvedValue([basePosition({ pnl: dec(-10), initialStopLoss: null })]);
    mockGetRegimeSnapshot.mockReturnValue(INACTIVE_SNAPSHOT);

    const mgr = new AutopilotPositionManager();
    const result = await expect(mgr.manageOpenTrades(fakeState())).resolves.toEqual({ checked: 1, managed: 0 });
    void result;
    expect(mockClose).not.toHaveBeenCalled();
  });

  it("closes a position via the time-stop once open longer than maxHoursOpen with no progress", async () => {
    const openedAt = new Date(Date.now() - 50 * 3_600_000); // 50h ago
    mockPositionFindMany.mockResolvedValue([basePosition({ pnl: dec(-5), openedAt, initialStopLoss: null })]);
    mockGetConfig.mockResolvedValue(baseCfg({ regimeExitEnabled: false, maxHoursOpen: 48 }));

    const mgr = new AutopilotPositionManager();
    const result = await mgr.manageOpenTrades(fakeState());

    expect(result.managed).toBe(1);
    expect(mockClose).toHaveBeenCalledWith("pos-1", "user-1", expect.anything());
    expect(mockEventBusEmit).toHaveBeenCalledWith("autopilot.position_managed", expect.objectContaining({ action: "TIME_STOP" }));
  });

  it("never triggers the time-stop on a winning trade even past the hour limit", async () => {
    const openedAt = new Date(Date.now() - 50 * 3_600_000);
    mockPositionFindMany.mockResolvedValue([basePosition({ pnl: dec(5), openedAt, initialStopLoss: null })]);
    mockGetConfig.mockResolvedValue(baseCfg({ regimeExitEnabled: false, maxHoursOpen: 48 }));

    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(fakeState());

    expect(mockClose).not.toHaveBeenCalled();
  });

  it("skips break-even/trailing entirely when there is no frozen initialStopLoss (R cannot be computed)", async () => {
    mockPositionFindMany.mockResolvedValue([basePosition({ pnl: dec(0), initialStopLoss: null })]);
    mockGetConfig.mockResolvedValue(baseCfg({ regimeExitEnabled: false, maxHoursOpen: 999 }));

    const mgr = new AutopilotPositionManager();
    const result = await mgr.manageOpenTrades(fakeState());

    expect(result).toEqual({ checked: 1, managed: 0 });
    expect(mockUpdateSLTP).not.toHaveBeenCalled();
  });

  it("applies break-even once R reaches breakEvenTriggerR, persists the flag, and emits BREAK_EVEN", async () => {
    // entry=100, initialSL=98 -> riskDistance=2; bid=102 -> favorable=2 -> R=1.0 (>= trigger 1), < trailingActivationR(1.5)
    mockPositionFindMany.mockResolvedValue([basePosition({ initialStopLoss: dec(98), stopLoss: dec(98) })]);
    mockQuoteCacheGet.mockReturnValue({ bid: 102, ask: 102.02 });

    const mgr = new AutopilotPositionManager();
    const result = await mgr.manageOpenTrades(fakeState());

    expect(result.managed).toBe(1);
    expect(mockUpdateSLTP).toHaveBeenCalledWith("pos-1", "user-1", { stopLoss: expect.closeTo(100.02, 2) });
    expect(mockPositionUpdate).toHaveBeenCalledWith({ where: { id: "pos-1" }, data: { breakEvenApplied: true } });
    expect(mockEventBusEmit).toHaveBeenCalledWith("autopilot.position_managed", expect.objectContaining({ action: "BREAK_EVEN" }));
  });

  it("never re-applies break-even once breakEvenApplied is already true", async () => {
    mockPositionFindMany.mockResolvedValue([basePosition({ breakEvenApplied: true, stopLoss: dec(98) })]);
    mockQuoteCacheGet.mockReturnValue({ bid: 102, ask: 102.02 });

    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(fakeState());

    expect(mockUpdateSLTP).not.toHaveBeenCalled();
  });

  it("does not move the BUY break-even stop if the candidate would worsen the existing (already-better) stop", async () => {
    // candidate ~100.02, but live stopLoss is already 101 (better than candidate) -> must not move
    mockPositionFindMany.mockResolvedValue([basePosition({ stopLoss: dec(101) })]);
    mockQuoteCacheGet.mockReturnValue({ bid: 102, ask: 102.02 });

    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(fakeState());

    expect(mockUpdateSLTP).not.toHaveBeenCalled();
  });

  it("applies trailing once R reaches trailingActivationR, tightens via ATR, and emits TRAILING_STOP", async () => {
    // entry=100, initialSL=98 -> riskDistance=2; bid=103 -> favorable=3 -> R=1.5 (>= activation)
    // breakEvenApplied:true isolates this test to the trailing branch only.
    mockPositionFindMany.mockResolvedValue([basePosition({ breakEvenApplied: true, stopLoss: dec(98) })]);
    mockQuoteCacheGet.mockReturnValue({ bid: 103, ask: 103.02 });
    mockGetRegimeSnapshot.mockReturnValue({ status: "ACTIVE", regime: "BULLISH_TREND", trending: true, atr: 0.5 });

    const mgr = new AutopilotPositionManager();
    const result = await mgr.manageOpenTrades(fakeState());

    // candidateSL = bid(103) - atr(0.5)*atrTrailMultiple(2) = 102
    expect(result.managed).toBe(1);
    expect(mockUpdateSLTP).toHaveBeenCalledWith("pos-1", "user-1", { stopLoss: 102 });
    expect(mockPositionUpdate).toHaveBeenCalledWith({ where: { id: "pos-1" }, data: { trailingActive: true } });
    expect(mockEventBusEmit).toHaveBeenCalledWith("autopilot.position_managed", expect.objectContaining({ action: "TRAILING_STOP", stopLoss: 102 }));
  });

  it("never loosens the trailing stop — only tightens", async () => {
    // candidateSL would be 102, but live stopLoss is already 102.5 (tighter) -> must not move
    mockPositionFindMany.mockResolvedValue([basePosition({ breakEvenApplied: true, stopLoss: dec(102.5) })]);
    mockQuoteCacheGet.mockReturnValue({ bid: 103, ask: 103.02 });
    mockGetRegimeSnapshot.mockReturnValue({ status: "ACTIVE", regime: "BULLISH_TREND", trending: true, atr: 0.5 });

    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(fakeState());

    expect(mockUpdateSLTP).not.toHaveBeenCalled();
  });

  it("skips trailing when the regime snapshot is inactive, even with sufficient R", async () => {
    mockPositionFindMany.mockResolvedValue([basePosition({ breakEvenApplied: true, stopLoss: dec(98) })]);
    mockQuoteCacheGet.mockReturnValue({ bid: 103, ask: 103.02 });
    mockGetRegimeSnapshot.mockReturnValue(INACTIVE_SNAPSHOT);

    const mgr = new AutopilotPositionManager();
    const result = await mgr.manageOpenTrades(fakeState());

    expect(result.managed).toBe(0);
    expect(mockUpdateSLTP).not.toHaveBeenCalled();
  });

  it("aggregates checked/managed counts across multiple positions and isolates one failure from the rest", async () => {
    const throwing = basePosition({ id: "pos-bad", initialStopLoss: null });
    const ok1 = basePosition({ id: "pos-1", initialStopLoss: null });
    const ok2 = basePosition({ id: "pos-2", initialStopLoss: null });
    mockPositionFindMany.mockResolvedValue([throwing, ok1, ok2]);
    mockGetConfig.mockImplementation(async (userId: string) => {
      if (userId === "user-1" && false) return baseCfg(); // placeholder branch (kept simple below)
      return baseCfg({ regimeExitEnabled: false, maxHoursOpen: 999 });
    });
    // Force the first position's quote lookup to throw to simulate a per-position failure.
    let call = 0;
    mockQuoteCacheGet.mockImplementation(() => {
      call++;
      if (call === 1) throw new Error("quote lookup failed");
      return { bid: 100, ask: 100.02 };
    });

    const mgr = new AutopilotPositionManager();
    const result = await mgr.manageOpenTrades(fakeState());

    expect(result.checked).toBe(3);
    expect(result.managed).toBe(0); // none of the 3 has a frozen SL once past the throwing one
  });

  it("circuit breaker takes no action when today's realized autopilot P&L is non-negative", async () => {
    mockPositionAggregate.mockResolvedValue({ _sum: { pnl: dec(25) } });
    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(fakeState());
    expect(mockAlertSend).not.toHaveBeenCalled();
  });

  it("circuit breaker takes no action while drawdown stays below the configured threshold", async () => {
    mockPositionAggregate.mockResolvedValue({ _sum: { pnl: dec(-100) } }); // 0.1% of 100k equity
    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(fakeState({ maxDailyAutopilotDrawdownPct: 5 }));
    expect(mockAlertSend).not.toHaveBeenCalled();
  });

  it("circuit breaker trips, disables autopilot platform-wide, and sends a CRITICAL alert once the threshold is breached", async () => {
    mockPositionAggregate.mockResolvedValue({ _sum: { pnl: dec(-6_000) } }); // 6% of 100k equity
    const state = fakeState({ maxDailyAutopilotDrawdownPct: 5 });

    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(state);

    expect(state.adminUpdateOlosGovernance).toHaveBeenCalledWith(expect.anything(), { autopilotEnabled: false });
    expect(mockAlertSend).toHaveBeenCalledWith(expect.objectContaining({ type: "AUTOPILOT_CIRCUIT_BREAKER", severity: "CRITICAL" }));
  });

  it("does not re-check (or double-trip) the circuit breaker once autopilot is already disabled platform-wide", async () => {
    mockPositionAggregate.mockResolvedValue({ _sum: { pnl: dec(-6_000) } });
    const state = fakeState({ autopilotEnabled: false, maxDailyAutopilotDrawdownPct: 5 });

    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(state);

    expect(mockAlertSend).not.toHaveBeenCalled();
  });

  it("guards against division by zero when platform equity is zero or negative", async () => {
    mockPositionAggregate.mockResolvedValue({ _sum: { pnl: dec(-100) } });
    mockWalletAggregate.mockResolvedValue({ _sum: { balance: dec(0) } });
    const state = fakeState();

    const mgr = new AutopilotPositionManager();
    await expect(mgr.manageOpenTrades(state)).resolves.toBeTruthy();
    expect(mockAlertSend).not.toHaveBeenCalled();
  });
});

describe("AutopilotPositionManager — per-client daily loss breaker", () => {
  it("takes no action when no user has a net loss today", async () => {
    mockPositionGroupBy.mockResolvedValue([{ userId: "user-1", _sum: { pnl: dec(50) } }]);
    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(fakeState());
    expect(mockSetDailyLossLock).not.toHaveBeenCalled();
  });

  it("takes no action while loss stays below the client's own maxDailyLossPct", async () => {
    // -200 on 10,000 equity = 2% loss, below the 5% default limit
    mockPositionGroupBy
      .mockResolvedValueOnce([{ userId: "user-1", _sum: { pnl: dec(-200) } }]) // closedToday
      .mockResolvedValueOnce([]); // openNow
    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(fakeState());
    expect(mockSetDailyLossLock).not.toHaveBeenCalled();
  });

  it("locks only the breaching client once combined realized+floating loss exceeds maxDailyLossPct", async () => {
    // -600 on 10,000 equity = 6% loss, breaches the 5% default limit
    mockPositionGroupBy
      .mockResolvedValueOnce([{ userId: "user-1", _sum: { pnl: dec(-400) } }, { userId: "user-2", _sum: { pnl: dec(50) } }]) // closedToday
      .mockResolvedValueOnce([{ userId: "user-1", _sum: { pnl: dec(-200) } }]); // openNow
    mockGetConfig.mockImplementation(async () => baseCfg());

    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(fakeState());

    expect(mockSetDailyLossLock).toHaveBeenCalledTimes(1);
    expect(mockSetDailyLossLock).toHaveBeenCalledWith("user-1", expect.any(Date), expect.any(String));
    expect(mockAlertSend).toHaveBeenCalledWith(expect.objectContaining({ type: "AUTOPILOT_DAILY_LOSS_LOCK" }));
    expect(mockEventBusEmit).toHaveBeenCalledWith("autopilot.daily_loss_lock", expect.objectContaining({ userId: "user-1" }));
  });

  it("does not re-lock or re-alert a client whose lock is already active", async () => {
    mockPositionGroupBy
      .mockResolvedValueOnce([{ userId: "user-1", _sum: { pnl: dec(-600) } }])
      .mockResolvedValueOnce([]);
    mockGetConfig.mockResolvedValue(baseCfg({ dailyLossLockedUntil: new Date(Date.now() + 3_600_000).toISOString() }));

    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(fakeState());

    expect(mockSetDailyLossLock).not.toHaveBeenCalled();
  });

  it("never locks on a margin/equity lookup failure", async () => {
    mockPositionGroupBy.mockResolvedValueOnce([{ userId: "user-1", _sum: { pnl: dec(-600) } }]).mockResolvedValueOnce([]);
    mockGetMarginState.mockRejectedValue(new Error("wallet not found"));

    const mgr = new AutopilotPositionManager();
    await expect(mgr.manageOpenTrades(fakeState())).resolves.toBeTruthy();
    expect(mockSetDailyLossLock).not.toHaveBeenCalled();
  });
});
