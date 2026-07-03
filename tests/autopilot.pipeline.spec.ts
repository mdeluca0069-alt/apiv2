/**
 * autopilot.pipeline.spec.ts
 *
 * Task 14, Phase 1 — first-ever test coverage for AutopilotPipeline.evaluate(),
 * the sequential gate chain that turns an OLOS signal into a real order.
 * Every dependency is mocked; each test sets up only the gate it targets and
 * lets every earlier/later gate pass through its permissive default, mirroring
 * the baseInputs()+overrides pattern used throughout this project's other
 * test files (e.g. dynamic.risk.engine.test.ts).
 *
 * The single most important invariant this file exists to prove: autopilot
 * NEVER bypasses riskEngine.preTradeCheck() — see "never bypasses the risk
 * engine" below, which asserts the mock was actually called.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AutopilotConfigFull } from "../autopilot-service/autopilot.service.js";
import type { BrokerState } from "../shared/state.js";

const {
  mockGetConfig, mockRecordDecision,
  mockPreTradeCheck,
  mockPlaceOrder,
  mockGetMarginState,
  mockCorrelationWithOpenPositions,
  mockQuoteCacheGet,
  mockPositionCount, mockPositionFindMany, mockPositionFindFirst, mockPositionUpdate,
  mockEventBusEmit,
  mockLinkPosition,
  mockGetUpcoming,
  mockAssertEligible,
  mockSupervisorGetMode, mockSupervisorGetState,
  mockEiEvaluate,
} = vi.hoisted(() => ({
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
  mockAssertEligible: vi.fn(),
  mockSupervisorGetMode:  vi.fn(),
  mockSupervisorGetState: vi.fn(),
  mockEiEvaluate:         vi.fn(),
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    position: {
      count:     mockPositionCount,
      findMany:  mockPositionFindMany,
      findFirst: mockPositionFindFirst,
      update:    mockPositionUpdate,
    },
  },
}));

vi.mock("../autopilot-service/autopilot.service.js", () => ({
  autopilotService: { getConfig: mockGetConfig, recordDecision: mockRecordDecision },
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

vi.mock("../autopilot-service/autopilot.eligibility.js", () => ({
  autopilotEligibility: { assertEligible: mockAssertEligible },
}));

vi.mock("../risk-service/global.risk.supervisor.js", () => ({
  globalRiskSupervisor: { getMode: mockSupervisorGetMode, getState: mockSupervisorGetState },
  SAFE_MODE_MIN_CONFIDENCE: 0.80,
}));

vi.mock("../execution-service/execution.intelligence.js", () => ({
  executionIntelligence: { evaluate: mockEiEvaluate },
}));

import { autopilotPipeline, type AutopilotSignalInput } from "../autopilot-service/autopilot.pipeline.js";
import type { OrderTriggeredEvent } from "../events-bus/event.bus.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function baseInput(overrides: Partial<AutopilotSignalInput> = {}): AutopilotSignalInput {
  return {
    userId: "user-1", symbol: "EURUSD", signalType: "BUY", confidence: 80,
    signalId: "sig-1", entryPrice: 1.1001, stopLoss: 1.0950, takeProfit: 1.1100,
    ...overrides,
  };
}

function baseCfg(overrides: Partial<AutopilotConfigFull> = {}): AutopilotConfigFull {
  return {
    userId: "user-1", enabled: true, mode: "BALANCED", minConfidence: 0.5,
    maxRiskPerTrade: 0.05, maxOpenTrades: 10, maxExposurePct: 80,
    allowedSymbols: [], blockedSymbols: [], stopDrawdownPct: 50, capitalPct: 100,
    eventLockMinutes: 0, maxDailyTrades: 50,
    breakEvenTriggerR: 1, trailingStopEnabled: true, trailingActivationR: 1.5, atrTrailMultiple: 2,
    regimeExitEnabled: true, maxHoursOpen: 48,
    maxDailyLossPct: 5, maxSpreadBps: 15,
    tier: "PLATINUM", updatedAt: new Date().toISOString(),
    ...overrides,
  } as AutopilotConfigFull;
}

function fakeState(overrides: { autopilotEnabled?: boolean; killSwitchEnabled?: boolean } = {}): BrokerState {
  return {
    getOlosGovernance: () => ({ autopilotEnabled: overrides.autopilotEnabled ?? true }),
    getRiskPolicy:     () => ({ killSwitchEnabled: overrides.killSwitchEnabled ?? false }),
  } as unknown as BrokerState;
}

const HEALTHY_MARGIN = { userId: "user-1", balance: 10_000, equity: 10_000, marginUsed: 1_000, freeMargin: 9_000, marginLevelPct: 1000, unrealizedPnl: 0 };
const LIVE_QUOTE = { symbol: "EURUSD", bid: 1.1000, ask: 1.1002, mid: 1.1001, spread: 0.0002, changePct: 0.1, ts: new Date().toISOString() };
const FILLED_ACK = { id: "order-1", symbol: "EURUSD", side: "BUY" as const, type: "MARKET" as const, quantity: 100, status: "FILLED" as const, marginRequired: 100, notional: 1000, createdAt: new Date().toISOString() };

beforeEach(() => {
  mockGetConfig.mockReset().mockResolvedValue(baseCfg());
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
  mockAssertEligible.mockReset().mockResolvedValue({ eligible: true });
  mockSupervisorGetMode.mockReset().mockReturnValue("NORMAL");
  mockSupervisorGetState.mockReset().mockReturnValue({ mode: "NORMAL", reason: "No restriction" });
  mockEiEvaluate.mockReset().mockReturnValue({ action: "PROCEED", executionScore: 100, reasons: [], signals: {} });
});

describe("AutopilotPipeline.evaluate — early gates", () => {
  it("skips NEUTRAL signals immediately, with no DB calls at all", async () => {
    const decision = await autopilotPipeline.evaluate(baseInput({ signalType: "NEUTRAL" }));
    expect(decision).toEqual({ action: "SKIPPED", reason: "NEUTRAL signal — no action" });
    expect(mockPositionCount).not.toHaveBeenCalled();
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("skips when the user's autopilot config is disabled", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ enabled: false }));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision).toEqual({ action: "SKIPPED", reason: "Autopilot disabled" });
  });

  it("(Phase 3) skips with the admin's reason when paused by admin", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ pausedByAdmin: true, pausedReason: "Suspicious activity" } as Partial<AutopilotConfigFull>));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision).toEqual({ action: "SKIPPED", reason: "Autopilot paused by admin: Suspicious activity" });
  });

  it("(Phase 3) skips with a generic message when paused by admin without a reason", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ pausedByAdmin: true } as Partial<AutopilotConfigFull>));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision).toEqual({ action: "SKIPPED", reason: "Autopilot paused by admin" });
  });

  it("(Phase 3) proceeds normally when not paused by admin", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ pausedByAdmin: false }));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("EXECUTED");
  });
});

describe("AutopilotPipeline.evaluate — platform governance gates (require state)", () => {
  it("skips when autopilot is disabled platform-wide", async () => {
    const decision = await autopilotPipeline.evaluate(baseInput(), fakeState({ autopilotEnabled: false }));
    expect(decision).toEqual({ action: "SKIPPED", reason: "Autopilot disabled platform-wide by admin" });
  });

  it("rejects when the trading kill switch is active", async () => {
    const decision = await autopilotPipeline.evaluate(baseInput(), fakeState({ killSwitchEnabled: true }));
    expect(decision.action).toBe("REJECTED");
    expect(decision.reason).toContain("kill switch");
  });

  it("runs every gate normally when no state is passed at all (state is optional)", async () => {
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("EXECUTED");
  });
});

describe("AutopilotPipeline.evaluate — eligibility gate (KYC/tier/funded, fails CLOSED)", () => {
  it("rejects accounts below PLATINUM tier", async () => {
    mockAssertEligible.mockResolvedValue({ eligible: false, reason: "Tier GOLD below required PLATINUM" });
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("REJECTED");
    expect(decision.reason).toContain("Tier GOLD below required PLATINUM");
  });

  it("rejects when KYC is not approved", async () => {
    mockAssertEligible.mockResolvedValue({ eligible: false, reason: "KYC not approved (status: pending)" });
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("REJECTED");
    expect(decision.reason).toContain("KYC not approved");
  });

  it("rejects (fails CLOSED) when the eligibility check itself fails — never lets a lookup error through", async () => {
    mockAssertEligible.mockResolvedValue({ eligible: false, reason: "Eligibility check failed: db down" });
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("REJECTED");
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("proceeds when eligible", async () => {
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("EXECUTED");
  });
});

describe("AutopilotPipeline.evaluate — per-client daily loss lock", () => {
  it("skips when the daily loss lock is still in the future", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ dailyLossLockedUntil: new Date(Date.now() + 3_600_000).toISOString() } as Partial<AutopilotConfigFull>));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("Daily loss limit");
  });

  it("proceeds once the lock has expired", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ dailyLossLockedUntil: new Date(Date.now() - 3_600_000).toISOString() } as Partial<AutopilotConfigFull>));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("EXECUTED");
  });
});

describe("AutopilotPipeline.evaluate — global risk supervisor gate", () => {
  it("NORMAL mode is a no-op — reproduces the default EXECUTED outcome unchanged", async () => {
    mockSupervisorGetMode.mockReturnValue("NORMAL");
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("EXECUTED");
  });

  it("EMERGENCY_MODE skips all new entries regardless of confidence", async () => {
    mockSupervisorGetMode.mockReturnValue("EMERGENCY_MODE");
    mockSupervisorGetState.mockReturnValue({ mode: "EMERGENCY_MODE", reason: "Database offline" });
    const decision = await autopilotPipeline.evaluate(baseInput({ confidence: 99 }));
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("EMERGENCY_MODE");
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("FULL_AUTOPILOT_STOP skips all new entries regardless of confidence", async () => {
    mockSupervisorGetMode.mockReturnValue("FULL_AUTOPILOT_STOP");
    mockSupervisorGetState.mockReturnValue({ mode: "FULL_AUTOPILOT_STOP", reason: "Platform drawdown 11.00%" });
    const decision = await autopilotPipeline.evaluate(baseInput({ confidence: 99 }));
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("FULL_AUTOPILOT_STOP");
  });

  it("SAFE_MODE skips a signal below the raised confidence bar", async () => {
    mockSupervisorGetMode.mockReturnValue("SAFE_MODE");
    mockSupervisorGetState.mockReturnValue({ mode: "SAFE_MODE", reason: "3 stale symbol(s)" });
    mockGetConfig.mockResolvedValue(baseCfg({ minConfidence: 0.5 })); // below SAFE_MODE_MIN_CONFIDENCE (0.80)
    const decision = await autopilotPipeline.evaluate(baseInput({ confidence: 70 })); // 70% < 80% bar
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("SAFE_MODE");
  });

  it("SAFE_MODE proceeds when confidence meets the raised bar", async () => {
    mockSupervisorGetMode.mockReturnValue("SAFE_MODE");
    mockGetConfig.mockResolvedValue(baseCfg({ minConfidence: 0.5 }));
    const decision = await autopilotPipeline.evaluate(baseInput({ confidence: 85 })); // 85% >= 80% bar
    expect(decision.action).toBe("EXECUTED");
  });

  it("SAFE_MODE uses the client's own minConfidence when it's already stricter than the supervisor floor", async () => {
    mockSupervisorGetMode.mockReturnValue("SAFE_MODE");
    mockGetConfig.mockResolvedValue(baseCfg({ minConfidence: 0.9 })); // stricter than the 0.80 SAFE_MODE floor
    const decision = await autopilotPipeline.evaluate(baseInput({ confidence: 85 })); // passes supervisor floor, fails client's own 90% gate
    expect(decision.action).toBe("SKIPPED");
  });
});

describe("AutopilotPipeline.evaluate — spread guard", () => {
  it("skips when the live spread exceeds maxSpreadBps", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ maxSpreadBps: 5 } as Partial<AutopilotConfigFull>));
    mockQuoteCacheGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0990, ask: 1.1010, mid: 1.1000, spread: 0.002, changePct: 0.1, ts: new Date().toISOString() });
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("Spread");
  });

  it("proceeds when the spread is within maxSpreadBps", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ maxSpreadBps: 50 } as Partial<AutopilotConfigFull>));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("EXECUTED");
  });
});

describe("AutopilotPipeline.evaluate — event lock", () => {
  it("skips when a high-impact event falls inside the lock window", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ eventLockMinutes: 30 }));
    mockGetUpcoming.mockResolvedValue([{ eventTime: new Date(Date.now() + 10 * 60_000), impact: "high" }]);
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("Event lock");
  });

  it("never blocks a trade when the economic calendar throws", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ eventLockMinutes: 30 }));
    mockGetUpcoming.mockRejectedValue(new Error("calendar unavailable"));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("EXECUTED");
  });
});

describe("AutopilotPipeline.evaluate — trade caps and confidence", () => {
  it("skips once the daily trade cap is reached", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ maxDailyTrades: 3 }));
    mockPositionCount.mockResolvedValueOnce(3); // daily cap query is the first count() call
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("Daily trade cap");
  });

  it("skips when confidence is below the configured gate", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ minConfidence: 0.9 }));
    const decision = await autopilotPipeline.evaluate(baseInput({ confidence: 80 }));
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("Confidence");
  });
});

describe("AutopilotPipeline.evaluate — symbol allow/blocklist", () => {
  it("skips a blocked symbol", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ blockedSymbols: ["EURUSD"] }));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("blocked");
  });

  it("skips a symbol not present in a non-empty allowlist", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ allowedSymbols: ["XAUUSD"] }));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("not in allowed list");
  });
});

describe("AutopilotPipeline.evaluate — open trades, drawdown, exposure", () => {
  it("skips once the max open trades guard is reached", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ maxOpenTrades: 2 }));
    mockPositionCount.mockResolvedValueOnce(0).mockResolvedValueOnce(2); // [dailyCap, openTrades]
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("Max open trades");
  });

  it("rejects when drawdown meets or exceeds the stop limit", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ stopDrawdownPct: 5 }));
    mockGetMarginState.mockResolvedValue({ ...HEALTHY_MARGIN, balance: 10_000, equity: 9_000 }); // 10% drawdown
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("REJECTED");
    expect(decision.reason).toContain("Drawdown");
  });

  it("skips when exposure meets or exceeds the configured max", async () => {
    mockGetConfig.mockResolvedValue(baseCfg({ maxExposurePct: 10 }));
    // balance === equity -> 0% drawdown, isolating the exposure gate; marginUsed/equity = 50% exposure
    mockGetMarginState.mockResolvedValue({ ...HEALTHY_MARGIN, balance: 1_000, equity: 1_000, marginUsed: 500 });
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("Exposure");
  });

  it("skips (does not crash) when reading margin state throws", async () => {
    mockGetMarginState.mockRejectedValue(new Error("db down"));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision).toEqual({ action: "SKIPPED", reason: "Could not read margin state" });
  });
});

describe("AutopilotPipeline.evaluate — price and sizing", () => {
  it("skips when no live quote is available", async () => {
    mockQuoteCacheGet.mockReturnValue(undefined);
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision).toEqual({ action: "SKIPPED", reason: "No live price available" });
  });

  it("halves quantity when a correlated open position would compound the same net exposure", async () => {
    // With this file's fixture defaults (BALANCED mode, maxRiskPerTrade=0.05,
    // capitalPct=100, equity=10,000, leverage=10x, mid=1.1001) the full-size
    // quantity is deterministic: notional = 10,000*0.05*10 = 5,000 -> qty = round(5000/1.1001) = 4545.
    const FULL_QTY = 4545;

    const baseline = await autopilotPipeline.evaluate(baseInput());
    expect(baseline.action).toBe("EXECUTED");
    expect(mockPlaceOrder.mock.calls[0]![0].quantity).toBe(FULL_QTY);
    mockPlaceOrder.mockClear();

    mockCorrelationWithOpenPositions.mockResolvedValue([{ symbolB: "GBPUSD", correlation: 0.9, dataPoints: 50 }]);
    mockPositionFindMany.mockResolvedValue([{ symbol: "GBPUSD", side: "BUY" }]);

    const halved = await autopilotPipeline.evaluate(baseInput());
    expect(halved.action).toBe("EXECUTED");
    expect(mockPlaceOrder.mock.calls[0]![0].quantity).toBe(Math.max(1, Math.round(FULL_QTY * 0.5)));
  });

  it("never blocks a trade when the correlation check throws — proceeds at full size", async () => {
    mockCorrelationWithOpenPositions.mockRejectedValue(new Error("matrix unavailable"));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("EXECUTED");
  });
});

describe("AutopilotPipeline.evaluate — risk engine is never bypassed", () => {
  it("rejects when riskEngine.preTradeCheck fails, and proves the check actually ran", async () => {
    mockPreTradeCheck.mockResolvedValue({ pass: false, reason: "MAX_POSITION_SIZE", detail: "exceeds 50% of equity" });
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(mockPreTradeCheck).toHaveBeenCalledTimes(1);
    expect(decision.action).toBe("REJECTED");
    expect(decision.reason).toContain("MAX_POSITION_SIZE");
    expect(decision.reason).toContain("exceeds 50% of equity");
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("emits autopilot.rejected (Phase 2) whenever _reject() fires, e.g. on a risk-engine failure", async () => {
    mockPreTradeCheck.mockResolvedValue({ pass: false, reason: "MAX_POSITION_SIZE", detail: "exceeds 50% of equity" });
    await autopilotPipeline.evaluate(baseInput());
    expect(mockEventBusEmit).toHaveBeenCalledWith("autopilot.rejected", expect.objectContaining({
      userId: "user-1", symbol: "EURUSD", reason: expect.stringContaining("MAX_POSITION_SIZE"),
    }));
  });

  it("always calls preTradeCheck before placeOrder on the success path too", async () => {
    await autopilotPipeline.evaluate(baseInput());
    expect(mockPreTradeCheck).toHaveBeenCalledTimes(1);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
  });
});

describe("AutopilotPipeline.evaluate — execution outcomes", () => {
  it("executes on a FILLED ack: records EXECUTED, emits autopilot.executed, tags the position, links telemetry", async () => {
    const decision = await autopilotPipeline.evaluate(baseInput());

    expect(decision.action).toBe("EXECUTED");
    expect(mockRecordDecision).toHaveBeenCalledWith("user-1", "EURUSD", "EXECUTED", expect.any(String));
    expect(mockEventBusEmit).toHaveBeenCalledWith("autopilot.executed", expect.objectContaining({
      userId: "user-1", symbol: "EURUSD", orderId: "order-1",
    }));
    expect(mockPositionUpdate).toHaveBeenCalledWith({
      where: { id: "pos-1" },
      data: { openedByAutopilot: true, initialStopLoss: { toNumber: expect.any(Function) } },
    });
    expect(mockLinkPosition).toHaveBeenCalledWith("sig-1", "pos-1", "order-1", 1.1001);
  });

  it("rejects when the order does not come back FILLED", async () => {
    mockPlaceOrder.mockResolvedValue({ ...FILLED_ACK, status: "REJECTED", rejectionReason: "INSUFFICIENT_MARGIN" });
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("REJECTED");
    expect(decision.reason).toContain("INSUFFICIENT_MARGIN");
  });

  it("rejects when placeOrder throws", async () => {
    mockPlaceOrder.mockRejectedValue(new Error("feed circuit open"));
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("REJECTED");
    expect(decision.reason).toContain("feed circuit open");
  });
});

describe("AutopilotPipeline.evaluate — mode-based leverage", () => {
  it.each([
    ["CONSERVATIVE", 5],
    ["BALANCED", 10],
    ["AGGRESSIVE", 20],
  ] as const)("uses %s leverage of %dx", async (mode, expectedLeverage) => {
    mockGetConfig.mockResolvedValue(baseCfg({ mode }));
    await autopilotPipeline.evaluate(baseInput());
    expect(mockPlaceOrder.mock.calls[0]![0].leverage).toBe(expectedLeverage);
  });
});

describe("AutopilotPipeline.evaluate — execution intelligence gate (Task 13, Phase 2)", () => {
  it("PROCEED (the default mock) reproduces the existing FILLED-path behavior unchanged", async () => {
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("EXECUTED");
    expect(mockPlaceOrder.mock.calls[0]![0].type).toBe("MARKET");
    expect(mockPlaceOrder.mock.calls[0]![0].price).toBeUndefined();
    expect(mockPlaceOrder.mock.calls[0]![0].expiresAt).toBeUndefined();
  });

  it("CANCEL skips the signal and never calls placeOrder", async () => {
    mockEiEvaluate.mockReturnValue({ action: "CANCEL", executionScore: 10, reasons: ["Crossed book"], signals: {} });
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("CANCEL");
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("DELAY skips the signal and never calls placeOrder", async () => {
    mockEiEvaluate.mockReturnValue({ action: "DELAY", executionScore: 40, reasons: ["Volatility EXTREME"], signals: {} });
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("SKIPPED");
    expect(decision.reason).toContain("DELAY");
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("RESIZE reduces the quantity passed to placeOrder and to the risk engine", async () => {
    mockEiEvaluate.mockReturnValue({ action: "RESIZE", adjustedQuantity: 42, executionScore: 60, reasons: ["Spread 80% of max"], signals: {} });
    const decision = await autopilotPipeline.evaluate(baseInput());
    expect(decision.action).toBe("EXECUTED");
    expect(mockPreTradeCheck.mock.calls[0]![0].quantity).toBe(42);
    expect(mockPlaceOrder.mock.calls[0]![0].quantity).toBe(42);
  });

  it("SWITCH_TO_LIMIT places a real LIMIT order with price + expiresAt, and handles an ACCEPTED ack without tagging a nonexistent position", async () => {
    const limitExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    mockEiEvaluate.mockReturnValue({
      action: "SWITCH_TO_LIMIT", limitPrice: 1.1001, limitExpiresAt,
      executionScore: 45, reasons: ["Spread 85% of max"], signals: {},
    });
    mockPlaceOrder.mockResolvedValue({ ...FILLED_ACK, type: "LIMIT" as const, status: "ACCEPTED" as const });

    const decision = await autopilotPipeline.evaluate(baseInput());

    expect(decision.action).toBe("EXECUTED");
    expect(mockPlaceOrder.mock.calls[0]![0]).toMatchObject({ type: "LIMIT", price: 1.1001, expiresAt: limitExpiresAt });
    expect(mockPositionUpdate).not.toHaveBeenCalled();
    expect(mockLinkPosition).not.toHaveBeenCalled();
    expect(decision.reason).toContain("resting LIMIT");
  });

  it("PROCEED/RESIZE never set a LIMIT price or expiry on the order request", async () => {
    mockEiEvaluate.mockReturnValue({ action: "RESIZE", adjustedQuantity: 10, executionScore: 60, reasons: [], signals: {} });
    await autopilotPipeline.evaluate(baseInput());
    expect(mockPlaceOrder.mock.calls[0]![0].type).toBe("MARKET");
    expect(mockPlaceOrder.mock.calls[0]![0].price).toBeUndefined();
    expect(mockPlaceOrder.mock.calls[0]![0].expiresAt).toBeUndefined();
  });
});

describe("AutopilotPipeline.handleOrderTriggered — deferred-fill tagging for SWITCH_TO_LIMIT positions", () => {
  function triggeredEvent(overrides: Partial<OrderTriggeredEvent> = {}): OrderTriggeredEvent {
    return {
      pendingId: "pending-1", orderId: "order-1", userId: "user-1", symbol: "EURUSD",
      side: "BUY", type: "LIMIT", execPrice: 1.1001, timestamp: new Date().toISOString(),
      clientOrderId: "ap_sig-1",
      ...overrides,
    };
  }

  it("tags the position when clientOrderId carries the ap_ autopilot prefix", async () => {
    await autopilotPipeline.handleOrderTriggered(triggeredEvent());
    expect(mockPositionUpdate).toHaveBeenCalledWith({
      where: { id: "pos-1" },
      data: { openedByAutopilot: true, initialStopLoss: { toNumber: expect.any(Function) } },
    });
    expect(mockLinkPosition).toHaveBeenCalledWith("sig-1", "pos-1", "order-1", 1.1001);
  });

  it("ignores a manually-placed triggered order (no clientOrderId)", async () => {
    await autopilotPipeline.handleOrderTriggered(triggeredEvent({ clientOrderId: undefined }));
    expect(mockPositionUpdate).not.toHaveBeenCalled();
    expect(mockLinkPosition).not.toHaveBeenCalled();
  });

  it("ignores a triggered order whose clientOrderId doesn't carry the autopilot prefix", async () => {
    await autopilotPipeline.handleOrderTriggered(triggeredEvent({ clientOrderId: "manual-order-42" }));
    expect(mockPositionUpdate).not.toHaveBeenCalled();
    expect(mockLinkPosition).not.toHaveBeenCalled();
  });
});
