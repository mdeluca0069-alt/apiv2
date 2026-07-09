/**
 * risk.warning.generator.spec.ts
 *
 * Milestone 1 / Fix #9 — proves RiskWarningGenerator derives every field it
 * writes from real, already-computed data (margin state, real open
 * positions, real kill-switch/suspension state) rather than fabricating
 * anything, and that low margin genuinely produces a higher risk score and
 * CRITICAL/WARNING severity instead of the old hardcoded "STABLE" always.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

function dec(n: number) {
  return { toNumber: () => n, valueOf: () => n };
}

const {
  mockGetMarginState, mockPositionFindMany, mockWalletFindUnique,
  mockInstrumentFindMany, mockCreateOrUpdateWarning,
  mockKillSwitchIsActive, mockKillSwitchGetState, mockIsSuspended,
  mockPositionFindManyDistinct,
} = vi.hoisted(() => ({
  mockGetMarginState: vi.fn(),
  mockPositionFindMany: vi.fn(),
  mockWalletFindUnique: vi.fn(),
  mockInstrumentFindMany: vi.fn().mockResolvedValue([]),
  mockCreateOrUpdateWarning: vi.fn().mockResolvedValue({}),
  mockKillSwitchIsActive: vi.fn().mockReturnValue(false),
  mockKillSwitchGetState: vi.fn().mockReturnValue({ active: false, reason: "" }),
  mockIsSuspended: vi.fn().mockReturnValue(false),
  mockPositionFindManyDistinct: vi.fn().mockResolvedValue([]),
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    position: {
      findMany: (args: { distinct?: unknown }) =>
        args?.distinct ? mockPositionFindManyDistinct(args) : mockPositionFindMany(args),
    },
    walletAccount: { findUnique: mockWalletFindUnique },
    instrument: { findMany: mockInstrumentFindMany },
  },
}));
vi.mock("../risk-service/margin.controller.js", () => ({
  marginController: { getMarginState: mockGetMarginState },
}));
vi.mock("../risk-service/kill.switch.js", () => ({
  killSwitch: { isActive: mockKillSwitchIsActive, getState: mockKillSwitchGetState },
}));
vi.mock("../shared/trading.suspension.js", () => ({
  tradingSuspension: { isSuspended: mockIsSuspended },
}));
vi.mock("../risk-service/risk.warning.service.js", () => ({
  riskWarningService: { createOrUpdateWarning: mockCreateOrUpdateWarning },
}));

const { RiskWarningGenerator } = await import("../risk-service/risk.warning.generator.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockKillSwitchIsActive.mockReturnValue(false);
  mockIsSuspended.mockReturnValue(false);
  mockInstrumentFindMany.mockResolvedValue([]);
});

describe("RiskWarningGenerator.generateForUser", () => {
  it("reports low risk / INFO severity for a healthy margin level", async () => {
    mockGetMarginState.mockResolvedValue({
      userId: "user-1", balance: 10_000, equity: 10_000, marginUsed: 1_000,
      freeMargin: 9_000, marginLevelPct: 1000, unrealizedPnl: 0,
    });
    mockPositionFindMany.mockResolvedValue([]);
    mockWalletFindUnique.mockResolvedValue({ balance: dec(10_000) });

    const gen = new RiskWarningGenerator();
    await gen.generateForUser("user-1");

    expect(mockCreateOrUpdateWarning).toHaveBeenCalledTimes(1);
    const payload = mockCreateOrUpdateWarning.mock.calls[0]![0];
    expect(payload.severity).toBe("INFO");
    expect(payload.regulatoryLevel).toBe("none");
    expect(payload.riskScore).toBe(0);
    expect(payload.negativeBalanceActive).toBe(false);
    expect(payload.liveTradeDisabled).toBe(false);
  });

  it("reports CRITICAL severity and a high risk score at/below the ESMA stop-out margin level", async () => {
    mockGetMarginState.mockResolvedValue({
      userId: "user-1", balance: 100, equity: 100, marginUsed: 200,
      freeMargin: -100, marginLevelPct: 50, unrealizedPnl: 0, // exactly at stop-out
    });
    mockPositionFindMany.mockResolvedValue([]);
    mockWalletFindUnique.mockResolvedValue({ balance: dec(100) });

    const gen = new RiskWarningGenerator();
    await gen.generateForUser("user-1");

    const payload = mockCreateOrUpdateWarning.mock.calls[0]![0];
    expect(payload.severity).toBe("CRITICAL");
    expect(payload.regulatoryLevel).toBe("high_risk");
    expect(payload.riskScore).toBe(100);
  });

  it("aggregates real open positions into portfolioAggregate and exposureHeatmap by real asset class", async () => {
    mockGetMarginState.mockResolvedValue({
      userId: "user-1", balance: 5_000, equity: 5_000, marginUsed: 800,
      freeMargin: 4_200, marginLevelPct: 625, unrealizedPnl: 0,
    });
    mockPositionFindMany.mockResolvedValue([
      { symbol: "EURUSD", side: "BUY",  marginUsed: dec(300), leverage: 10 },
      { symbol: "BTCUSD", side: "SELL", marginUsed: dec(500), leverage: 2 },
    ]);
    mockInstrumentFindMany.mockResolvedValue([
      { symbol: "EURUSD", assetClass: "FX_MAJOR" },
      { symbol: "BTCUSD", assetClass: "CRYPTO" },
    ]);
    mockWalletFindUnique.mockResolvedValue({ balance: dec(5_000) });

    const gen = new RiskWarningGenerator();
    await gen.generateForUser("user-1");

    const payload = mockCreateOrUpdateWarning.mock.calls[0]![0];
    expect(payload.portfolioAggregate.byAsset).toEqual({ EURUSD: 300, BTCUSD: 500 });
    expect(payload.portfolioAggregate.byDirection).toEqual({ long: 300, short: 500 });
    expect(payload.portfolioAggregate.totalExposure).toBe(800);
    expect(payload.exposureHeatmap.FX_MAJOR).toBe(300);
    expect(payload.exposureHeatmap.CRYPTO).toBe(500);
    expect(payload.exposureHeatmap.EQUITY).toBe(0);
  });

  it("reflects a real active kill switch in killSwitchTriggers and liveTradeDisabled", async () => {
    mockGetMarginState.mockResolvedValue({
      userId: "user-1", balance: 1_000, equity: 1_000, marginUsed: 0,
      freeMargin: 1_000, marginLevelPct: Infinity, unrealizedPnl: 0,
    });
    mockPositionFindMany.mockResolvedValue([]);
    mockWalletFindUnique.mockResolvedValue({ balance: dec(1_000) });
    mockKillSwitchIsActive.mockReturnValue(true);
    mockKillSwitchGetState.mockReturnValue({ active: true, reason: "Emergency stop by admin" });

    const gen = new RiskWarningGenerator();
    await gen.generateForUser("user-1");

    const payload = mockCreateOrUpdateWarning.mock.calls[0]![0];
    expect(payload.liveTradeDisabled).toBe(true);
    expect(payload.killSwitchTriggers).toHaveLength(1);
    expect(payload.killSwitchTriggers[0].reason).toBe("Emergency stop by admin");
  });

  it("does not write a warning when the user has no wallet", async () => {
    mockGetMarginState.mockRejectedValue(new Error("WALLET_NOT_FOUND:user-x"));

    const gen = new RiskWarningGenerator();
    await gen.generateForUser("user-x");

    expect(mockCreateOrUpdateWarning).not.toHaveBeenCalled();
  });
});
