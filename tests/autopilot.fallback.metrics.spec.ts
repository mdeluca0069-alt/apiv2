/**
 * autopilot.fallback.metrics.spec.ts
 *
 * Task 14, Phase 7 — visibility for the 2 silent fallback paths that must
 * never block a trade or a management rule:
 *   - autopilot.pipeline.ts: correlation-check throws → falls through to
 *     full position size.
 *   - autopilot.position.manager.ts: regime-exit / trailing-stop skipped
 *     because the regime snapshot isn't ACTIVE.
 *
 * Covers both fallback sites counting correctly with behavior unchanged,
 * plus AutopilotPositionManager's new threshold-based WARNING alert inside
 * _checkCircuitBreaker() (delta-since-last-cycle, not an absolute total).
 *
 * metrics.inc()/get() are mocked with a tiny real counter map (not pure
 * spies) so the threshold tests can pre-seed an absolute total and let the
 * production delta logic compute against it, exactly like the real registry.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AutopilotConfigFull } from "../autopilot-service/autopilot.service.js";
import type { BrokerState } from "../shared/state.js";

const {
  mockMetricsInc, fallbackCounters,
  // pipeline deps
  mockGetConfig, mockRecordDecision,
  mockPreTradeCheck, mockPlaceOrder, mockGetMarginState,
  mockCorrelationWithOpenPositions, mockQuoteCacheGet,
  mockPositionCount, mockPositionFindMany, mockPositionFindFirst, mockPositionUpdate,
  mockEventBusEmit, mockLinkPosition, mockGetUpcoming,
  // position manager deps
  mockClose, mockUpdateSLTP, mockGetRegimeSnapshot, mockAlertSend,
  mockPositionAggregate, mockPositionGroupBy, mockWalletAggregate,
  mockAssertEligible, mockSetDailyLossLock, mockEiEvaluate,
} = vi.hoisted(() => {
  const fallbackCounters: Record<string, number> = {};
  return {
    fallbackCounters,
    mockMetricsInc: vi.fn((name: string) => { fallbackCounters[name] = (fallbackCounters[name] ?? 0) + 1; }),
    mockGetConfig:    vi.fn(),
    mockRecordDecision: vi.fn().mockResolvedValue(undefined),
    mockPreTradeCheck: vi.fn(),
    mockPlaceOrder:   vi.fn(),
    mockGetMarginState: vi.fn(),
    mockCorrelationWithOpenPositions: vi.fn().mockResolvedValue([]),
    mockQuoteCacheGet: vi.fn(),
    mockPositionCount: vi.fn().mockResolvedValue(0),
    mockPositionFindMany: vi.fn().mockResolvedValue([]),
    mockPositionFindFirst: vi.fn().mockResolvedValue(null),
    mockPositionUpdate: vi.fn().mockResolvedValue({}),
    mockEventBusEmit: vi.fn(),
    mockLinkPosition: vi.fn().mockResolvedValue(undefined),
    mockGetUpcoming: vi.fn().mockResolvedValue([]),
    mockClose:            vi.fn().mockResolvedValue({ ok: true }),
    mockUpdateSLTP:       vi.fn().mockResolvedValue({ ok: true }),
    mockGetRegimeSnapshot: vi.fn(),
    mockAlertSend:        vi.fn().mockResolvedValue(undefined),
    mockPositionAggregate: vi.fn(),
    mockPositionGroupBy:  vi.fn().mockResolvedValue([]),
    mockWalletAggregate:  vi.fn(),
    mockAssertEligible:   vi.fn().mockResolvedValue({ eligible: true }),
    mockSetDailyLossLock: vi.fn().mockResolvedValue(undefined),
    mockEiEvaluate:       vi.fn(),
  };
});

vi.mock("../gateway/metrics.js", () => ({
  metrics: {
    inc:    mockMetricsInc,
    get:    (name: string) => fallbackCounters[name] ?? 0,
    set:    vi.fn(),
    register: vi.fn(),
    observe: vi.fn(),
  },
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    position: {
      // Same mock backs both the pipeline's correlation-pairs lookup and the
      // position manager's open-positions lookup — never needed by both at
      // once within a single test in this file.
      count:     mockPositionCount,
      findMany:  mockPositionFindMany,
      findFirst: mockPositionFindFirst,
      update:    mockPositionUpdate,
      aggregate: mockPositionAggregate,
      groupBy:   mockPositionGroupBy,
    },
    walletAccount: { aggregate: mockWalletAggregate },
  },
}));

vi.mock("../autopilot-service/autopilot.service.js", () => ({
  autopilotService: { getConfig: mockGetConfig, recordDecision: mockRecordDecision, setDailyLossLock: mockSetDailyLossLock },
}));

vi.mock("../autopilot-service/autopilot.eligibility.js", () => ({
  autopilotEligibility: { assertEligible: mockAssertEligible },
}));

vi.mock("../risk-service/risk.engine.js", () => ({
  riskEngine: { preTradeCheck: mockPreTradeCheck },
}));

vi.mock("../trading-service/order.controller.js", () => ({
  orderController: { placeOrder: mockPlaceOrder },
}));

vi.mock("../risk-service/margin.controller.js", () => ({
  marginController: { getMarginState: mockGetMarginState },
}));

vi.mock("../risk-service/correlation.matrix.js", () => ({
  correlationMatrix: { correlationWithOpenPositions: mockCorrelationWithOpenPositions },
}));

vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockQuoteCacheGet },
}));

vi.mock("../events-bus/event.bus.js", () => ({
  eventBus: { emit: mockEventBusEmit, on: vi.fn() },
}));

vi.mock("../signals-engine/signal.telemetry.js", () => ({
  signalTelemetry: { linkPosition: mockLinkPosition },
}));

vi.mock("../economic-calendar/economic.event.service.js", () => ({
  economicEventService: { getUpcoming: mockGetUpcoming },
  currenciesForSymbol: (symbol: string) => (symbol === "EURUSD" ? ["EUR", "USD"] : []),
}));

vi.mock("../trading-service/position.service.js", () => ({
  positionService: { close: mockClose, updateSLTP: mockUpdateSLTP },
}));

vi.mock("../ai-core/regime.snapshot.js", () => ({
  getRegimeSnapshot: mockGetRegimeSnapshot,
}));

vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { send: mockAlertSend },
}));

vi.mock("../execution-service/execution.intelligence.js", () => ({
  executionIntelligence: { evaluate: mockEiEvaluate },
}));

import { autopilotPipeline, type AutopilotSignalInput } from "../autopilot-service/autopilot.pipeline.js";
import { AutopilotPositionManager } from "../autopilot-service/autopilot.position.manager.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function dec(n: number) {
  return { toNumber: () => n };
}

function baseInput(overrides: Partial<AutopilotSignalInput> = {}): AutopilotSignalInput {
  return {
    userId: "user-1", symbol: "EURUSD", signalType: "BUY", confidence: 80,
    signalId: "sig-1", entryPrice: 1.1001, stopLoss: 1.0950, takeProfit: 1.1100,
    ...overrides,
  };
}

function pipelineCfg(overrides: Partial<AutopilotConfigFull> = {}): AutopilotConfigFull {
  return {
    userId: "user-1", enabled: true, mode: "BALANCED", minConfidence: 0.5,
    maxRiskPerTrade: 0.05, maxOpenTrades: 10, maxExposurePct: 80,
    allowedSymbols: [], blockedSymbols: [], stopDrawdownPct: 50, capitalPct: 100,
    eventLockMinutes: 0, maxDailyTrades: 50,
    breakEvenTriggerR: 1, trailingStopEnabled: true, trailingActivationR: 1.5, atrTrailMultiple: 2,
    regimeExitEnabled: true, maxHoursOpen: 48, pausedByAdmin: false,
    maxDailyLossPct: 5, maxSpreadBps: 15,
    tier: "PLATINUM", updatedAt: new Date().toISOString(),
    ...overrides,
  } as AutopilotConfigFull;
}

function mgrCfg(overrides: Record<string, unknown> = {}) {
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

function mgrState(): BrokerState {
  return {
    getOlosGovernance: () => ({ autopilotEnabled: true, maxDailyAutopilotDrawdownPct: 5 }),
    adminUpdateOlosGovernance: vi.fn(),
  } as unknown as BrokerState;
}

const HEALTHY_MARGIN = { userId: "user-1", balance: 10_000, equity: 10_000, marginUsed: 1_000, freeMargin: 9_000, marginLevelPct: 1000, unrealizedPnl: 0 };
const LIVE_QUOTE = { symbol: "EURUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001, spread: 0.0002, changePct: 0.1, ts: new Date().toISOString() };
const FILLED_ACK = { id: "order-1", symbol: "EURUSD", side: "BUY" as const, type: "MARKET" as const, quantity: 100, status: "FILLED" as const, marginRequired: 100, notional: 1000, createdAt: new Date().toISOString() };
const INACTIVE_SNAPSHOT = { status: "INSUFFICIENT_DATA" as const, regime: null, atr: null, trending: null };

beforeEach(() => {
  Object.keys(fallbackCounters).forEach((k) => delete fallbackCounters[k]);
  mockMetricsInc.mockClear();

  mockGetConfig.mockReset().mockResolvedValue(pipelineCfg());
  mockRecordDecision.mockReset().mockResolvedValue(undefined);
  mockPreTradeCheck.mockReset().mockResolvedValue({ pass: true });
  mockPlaceOrder.mockReset().mockResolvedValue({ ...FILLED_ACK });
  mockGetMarginState.mockReset().mockResolvedValue({ ...HEALTHY_MARGIN });
  mockCorrelationWithOpenPositions.mockReset().mockResolvedValue([]);
  mockQuoteCacheGet.mockReset().mockReturnValue({ ...LIVE_QUOTE });
  mockPositionCount.mockReset().mockResolvedValue(0);
  mockPositionFindMany.mockReset().mockResolvedValue([]);
  mockPositionFindFirst.mockReset().mockResolvedValue({ id: "pos-1", entryPrice: { toNumber: () => 1.1001 }, stopLoss: { toNumber: () => 1.0950 } });
  mockPositionUpdate.mockReset().mockResolvedValue({});
  mockEventBusEmit.mockReset();
  mockLinkPosition.mockReset().mockResolvedValue(undefined);
  mockGetUpcoming.mockReset().mockResolvedValue([]);

  mockClose.mockReset().mockResolvedValue({ ok: true });
  mockUpdateSLTP.mockReset().mockResolvedValue({ ok: true });
  mockGetRegimeSnapshot.mockReset().mockReturnValue(INACTIVE_SNAPSHOT);
  mockAlertSend.mockReset().mockResolvedValue(undefined);
  mockPositionFindMany.mockReset().mockResolvedValue([]);
  mockPositionAggregate.mockReset().mockResolvedValue({ _sum: { pnl: dec(0) } });
  mockPositionGroupBy.mockReset().mockResolvedValue([]);
  mockWalletAggregate.mockReset().mockResolvedValue({ _sum: { balance: dec(100_000) } });
  mockAssertEligible.mockReset().mockResolvedValue({ eligible: true });
  mockSetDailyLossLock.mockReset().mockResolvedValue(undefined);
  mockEiEvaluate.mockReset().mockReturnValue({ action: "PROCEED", executionScore: 100, reasons: [], signals: {} });
});

// ── Site 1: pipeline correlation-check fallback ───────────────────────────────

describe("AutopilotPipeline — correlation fallback visibility", () => {
  it("increments autopilot_correlation_fallback_total when the correlation check throws, and still never blocks the trade", async () => {
    mockCorrelationWithOpenPositions.mockRejectedValue(new Error("matrix unavailable"));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("EXECUTED");
    expect(mockMetricsInc).toHaveBeenCalledWith("autopilot_correlation_fallback_total");
  });

  it("does not increment the counter when the correlation check succeeds normally", async () => {
    mockCorrelationWithOpenPositions.mockResolvedValue([]);
    await autopilotPipeline.evaluate(baseInput());
    expect(mockMetricsInc).not.toHaveBeenCalledWith("autopilot_correlation_fallback_total");
  });
});

// ── Site 2: position manager regime-snapshot-unavailable fallback ────────────

describe("AutopilotPositionManager — regime-unavailable fallback visibility", () => {
  it("increments autopilot_regime_unavailable_total on the regime-exit path, and never exits the position because of it", async () => {
    mockPositionFindMany.mockResolvedValueOnce([basePosition({ pnl: dec(-5) })]); // at-loss, would qualify for regime-exit if active
    mockGetRegimeSnapshot.mockReturnValue(INACTIVE_SNAPSHOT);

    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(mgrState());

    expect(mockMetricsInc).toHaveBeenCalledWith("autopilot_regime_unavailable_total");
    expect(mockClose).not.toHaveBeenCalled();
  });

  it("increments autopilot_regime_unavailable_total on the trailing-stop path, and never moves the stop because of it", async () => {
    // R = 2.0 (well past trailingActivationR=1.5): entry 100, initialSL 98, price moved to 104.
    mockPositionFindMany.mockResolvedValueOnce([basePosition({
      entryPrice: dec(100), initialStopLoss: dec(98), stopLoss: dec(98), pnl: dec(400),
    })]);
    mockQuoteCacheGet.mockReturnValue({ bid: 104, ask: 104.02 });
    mockGetConfig.mockResolvedValue(mgrCfg({ breakEvenTriggerR: 5 })); // keep break-even from also firing, isolate trailing
    mockGetRegimeSnapshot.mockReturnValue(INACTIVE_SNAPSHOT);

    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(mgrState());

    expect(mockMetricsInc).toHaveBeenCalledWith("autopilot_regime_unavailable_total");
    expect(mockUpdateSLTP).not.toHaveBeenCalled();
  });

  it("does not increment the counter when the regime snapshot is ACTIVE", async () => {
    mockPositionFindMany.mockResolvedValueOnce([basePosition({ pnl: dec(-5) })]);
    mockGetRegimeSnapshot.mockReturnValue({ status: "ACTIVE", regime: "BULLISH_TREND", trending: true, atr: 0.001 });

    const mgr = new AutopilotPositionManager();
    await mgr.manageOpenTrades(mgrState());

    expect(mockMetricsInc).not.toHaveBeenCalledWith("autopilot_regime_unavailable_total");
  });
});

// ── Threshold alert inside _checkCircuitBreaker() ─────────────────────────────

describe("AutopilotPositionManager — fallback-spike threshold alert", () => {
  it("fires a WARNING AUTOPILOT_FALLBACK_SPIKE alert once a counter's delta since the last cycle crosses the threshold", async () => {
    fallbackCounters["autopilot_correlation_fallback_total"] = 12;
    const mgr = new AutopilotPositionManager();

    await mgr.manageOpenTrades(mgrState());

    expect(mockAlertSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "AUTOPILOT_FALLBACK_SPIKE", severity: "WARNING",
    }));
  });

  it("does not fire when both counters' deltas stay below the threshold", async () => {
    fallbackCounters["autopilot_correlation_fallback_total"] = 3;
    fallbackCounters["autopilot_regime_unavailable_total"]   = 4;
    const mgr = new AutopilotPositionManager();

    await mgr.manageOpenTrades(mgrState());

    expect(mockAlertSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: "AUTOPILOT_FALLBACK_SPIKE" }));
  });

  it("computes the delta since the last cycle, not the absolute total — a second cycle with no further growth does not re-fire", async () => {
    fallbackCounters["autopilot_regime_unavailable_total"] = 15;
    const mgr = new AutopilotPositionManager();

    await mgr.manageOpenTrades(mgrState()); // first cycle: delta = 15, fires
    expect(mockAlertSend).toHaveBeenCalledWith(expect.objectContaining({ type: "AUTOPILOT_FALLBACK_SPIKE" }));

    mockAlertSend.mockClear();
    await mgr.manageOpenTrades(mgrState()); // second cycle: delta = 0, must not re-fire
    expect(mockAlertSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: "AUTOPILOT_FALLBACK_SPIKE" }));
  });
});
