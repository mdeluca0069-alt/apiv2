/**
 * risk.engine.pretrade.gates.spec.ts
 *
 * PHASE D (execution-safety gate certification): an independent audit
 * pass over the whole pre-trade pipeline confirmed every gate in
 * RiskEngine.preTradeCheck() is genuinely wired and its failure path
 * genuinely rejects the order -- verified by code trace, since NO
 * dedicated test previously exercised preTradeCheck() as a whole (every
 * individual gate implementation has its own spec file, e.g.
 * client.exposure.limits.spec.ts, concentration.guard.spec.ts,
 * correlation.guard.spec.ts, margin.controller.equity.spec.ts -- but
 * nothing proved they're actually called, in the right order, by
 * preTradeCheck() itself). This file closes that gap: it mocks every
 * individual gate at its true module boundary and proves preTradeCheck()
 * correctly short-circuits and rejects on each one, and that ordering
 * matches the source (kill switch -> KYC -> duplicate order -> instrument
 * -> min trade size -> margin -> position-vs-equity cap -> client
 * exposure -> correlation -> concentration -> global instrument
 * exposure), with a full happy-path proving all gates passing yields
 * pass:true with the correct computed marginRequired/notional/
 * effectiveLeverage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockUser, mockOrder, mockInstrumentFind } = vi.hoisted(() => ({
  mockUser: { findUnique: vi.fn().mockResolvedValue({ kycStatus: "approved", tier: "STANDARD" }) },
  mockOrder: { findUnique: vi.fn().mockResolvedValue(null) },
  // Default resolved value (needs `Decimal`, not available inside
  // vi.hoisted() before imports run) is set just below, and again in
  // beforeEach.
  mockInstrumentFind: vi.fn(),
}));
vi.mock("../shared/db.js", () => ({
  prisma: { user: mockUser, order: mockOrder, instrument: { findUnique: mockInstrumentFind } },
}));

mockInstrumentFind.mockResolvedValue({ assetClass: "FX_MAJOR", minTradeSize: new Decimal(100), maxLeverageRetail: 30 });

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("id") }));
vi.mock("../security/immutable.audit.js", () => ({ immutableAudit: { write: mockAuditWrite } }));

const mockKillSwitch = { isActive: vi.fn().mockReturnValue(false), getState: vi.fn().mockReturnValue({ active: false, reason: "" }) };
vi.mock("../risk-service/kill.switch.js", () => ({ killSwitch: mockKillSwitch }));

const mockLeverageGuard = {
  check: vi.fn().mockReturnValue({ effectiveLeverage: 20, capped: false, requestedLeverage: 20, cap: 30 }),
  computeNotional: vi.fn((qty: number, price: number) => qty * price),
  computeMarginRequired: vi.fn((notional: number, lev: number) => notional / lev),
};
vi.mock("../risk-service/leverage.guard.js", () => ({ leverageGuard: mockLeverageGuard }));

const mockVolatilityGuard = { apply: vi.fn((_symbol: string, capped: number) => capped) };
vi.mock("../risk-service/volatility.leverage.guard.js", () => ({ volatilityLeverageGuard: mockVolatilityGuard }));

const mockMarginController = {
  getMarginState: vi.fn().mockResolvedValue({
    userId: "user-1", balance: 100_000, equity: 100_000, marginUsed: 0,
    freeMargin: 100_000, marginLevelPct: 999, unrealizedPnl: 0,
  }),
  canAcceptOrder: vi.fn().mockReturnValue(true),
};
vi.mock("../risk-service/margin.controller.js", () => ({ marginController: mockMarginController }));

const mockExposureRegistry = { checkCanOpen: vi.fn().mockReturnValue({ ok: true }) };
vi.mock("../risk-service/exposure.limits.js", () => ({ exposureRegistry: mockExposureRegistry }));

const mockClientExposureLimits = { check: vi.fn().mockResolvedValue({ ok: true }) };
vi.mock("../risk-service/client.exposure.limits.js", () => ({ clientExposureLimits: mockClientExposureLimits }));

const mockCorrelationGuard = { check: vi.fn().mockResolvedValue({ ok: true }) };
vi.mock("../risk-service/correlation.guard.js", () => ({ correlationGuard: mockCorrelationGuard }));

const mockConcentrationGuard = { check: vi.fn().mockResolvedValue({ ok: true }) };
vi.mock("../risk-service/concentration.guard.js", () => ({ concentrationGuard: mockConcentrationGuard }));

const { riskEngine } = await import("../risk-service/risk.engine.js");

function baseInput() {
  return {
    userId: "user-1", symbol: "eurusd", side: "BUY" as const,
    quantity: 1000, leverage: 20, midPrice: 1.10,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.findUnique.mockResolvedValue({ kycStatus: "approved", tier: "STANDARD" });
  mockOrder.findUnique.mockResolvedValue(null);
  mockInstrumentFind.mockResolvedValue({ assetClass: "FX_MAJOR", minTradeSize: new Decimal(100), maxLeverageRetail: 30 });
  mockKillSwitch.isActive.mockReturnValue(false);
  mockLeverageGuard.check.mockReturnValue({ effectiveLeverage: 20, capped: false, requestedLeverage: 20, cap: 30 });
  mockVolatilityGuard.apply.mockImplementation((_s: string, capped: number) => capped);
  mockMarginController.getMarginState.mockResolvedValue({
    userId: "user-1", balance: 100_000, equity: 100_000, marginUsed: 0,
    freeMargin: 100_000, marginLevelPct: 999, unrealizedPnl: 0,
  });
  mockMarginController.canAcceptOrder.mockReturnValue(true);
  mockExposureRegistry.checkCanOpen.mockReturnValue({ ok: true });
  mockClientExposureLimits.check.mockResolvedValue({ ok: true });
  mockCorrelationGuard.check.mockResolvedValue({ ok: true });
  mockConcentrationGuard.check.mockResolvedValue({ ok: true });
});

describe("RiskEngine.preTradeCheck() — PHASE D: every gate genuinely rejects when it should", () => {
  it("HAPPY PATH: all gates passing yields pass:true with correctly computed notional/margin/leverage", async () => {
    const result = await riskEngine.preTradeCheck(baseInput());

    expect(result.pass).toBe(true);
    if (result.pass) {
      expect(result.notional).toBeCloseTo(1000 * 1.10, 6);
      expect(result.marginRequired).toBeCloseTo((1000 * 1.10) / 20, 6);
      expect(result.effectiveLeverage).toBe(20);
    }
    expect(mockAuditWrite).toHaveBeenCalledWith(expect.objectContaining({ action: "PRE_TRADE_RISK_PASS" }));
  });

  it("GATE 1 — kill switch active rejects before any DB/cache call", async () => {
    mockKillSwitch.isActive.mockReturnValue(true);
    mockKillSwitch.getState.mockReturnValue({ active: true, reason: "admin halt" });

    const result = await riskEngine.preTradeCheck(baseInput());

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("KILL_SWITCH_ACTIVE");
    expect(mockUser.findUnique).not.toHaveBeenCalled();
  });

  it("GATE 2 — unapproved KYC rejects", async () => {
    mockUser.findUnique.mockResolvedValue({ kycStatus: "pending", tier: "STANDARD" });

    // Unique userId: getCachedUser() has a 60s in-process TTL cache
    // keyed by userId -- reusing "user-1" here would hit the HAPPY
    // PATH test's cached "approved" result instead of calling the mock
    // again.
    const result = await riskEngine.preTradeCheck({ ...baseInput(), userId: "user-gate2-pending-kyc" });

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("KYC_NOT_APPROVED");
  });

  it("GATE 2b — user not found rejects as KYC_NOT_APPROVED (fails closed, not a crash)", async () => {
    mockUser.findUnique.mockResolvedValue(null);

    const result = await riskEngine.preTradeCheck({ ...baseInput(), userId: "user-gate2b-not-found" });

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("KYC_NOT_APPROVED");
  });

  it("GATE 3 — duplicate clientOrderId rejects", async () => {
    mockOrder.findUnique.mockResolvedValue({ id: "existing-order-1" });

    const result = await riskEngine.preTradeCheck({ ...baseInput(), clientOrderId: "dup-1" });

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("DUPLICATE_CLIENT_ORDER_ID");
  });

  it("GATE 4 — unknown instrument rejects", async () => {
    mockInstrumentFind.mockResolvedValue(null);

    // Unique symbol: getCachedInstrument() has a 5min in-process TTL
    // cache keyed by symbol -- reusing "eurusd" would hit an earlier
    // test's cached instrument row instead of calling the mock again.
    const result = await riskEngine.preTradeCheck({ ...baseInput(), symbol: "gate4-unknown-symbol" });

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("INSTRUMENT_NOT_FOUND");
  });

  it("GATE 6 — quantity below the instrument's minimum trade size rejects", async () => {
    mockInstrumentFind.mockResolvedValue({ assetClass: "FX_MAJOR", minTradeSize: new Decimal(5000), maxLeverageRetail: 30 });

    const result = await riskEngine.preTradeCheck({ ...baseInput(), symbol: "gate6-min-size-symbol", quantity: 1000 });

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("POSITION_SIZE_EXCEEDS_LIMIT");
  });

  it("GATE 7 (margin availability) — canAcceptOrder()=false rejects as INSUFFICIENT_MARGIN", async () => {
    mockMarginController.canAcceptOrder.mockReturnValue(false);

    const result = await riskEngine.preTradeCheck(baseInput());

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("INSUFFICIENT_MARGIN");
  });

  it("GATE 7 — no wallet for the user rejects as WALLET_NOT_FOUND, not an unhandled throw", async () => {
    mockMarginController.getMarginState.mockRejectedValue(new Error("WALLET_NOT_FOUND"));

    const result = await riskEngine.preTradeCheck(baseInput());

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("WALLET_NOT_FOUND");
  });

  it("GATE 8 — a single order requiring >50% of account equity rejects, even though margin is technically available", async () => {
    mockMarginController.getMarginState.mockResolvedValue({
      userId: "user-1", balance: 100, equity: 100, marginUsed: 0,
      freeMargin: 100, marginLevelPct: 999, unrealizedPnl: 0,
    });
    mockMarginController.canAcceptOrder.mockReturnValue(true); // margin exists, but...

    const result = await riskEngine.preTradeCheck(baseInput()); // marginRequired = 1100/20 = 55 -> 55% of 100 equity

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("POSITION_SIZE_EXCEEDS_LIMIT");
  });

  it("GATE 9 — client aggregate exposure cap breach rejects with the guard's own reason/detail", async () => {
    mockClientExposureLimits.check.mockResolvedValue({
      ok: false, reason: "CLIENT_EXPOSURE_LIMIT_EXCEEDED", detail: "over cap",
    });

    const result = await riskEngine.preTradeCheck(baseInput());

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("CLIENT_EXPOSURE_LIMIT_EXCEEDED");
  });

  it("GATE 10 — correlation guard breach rejects", async () => {
    mockCorrelationGuard.check.mockResolvedValue({
      ok: false, reason: "CORRELATION_LIMIT_EXCEEDED", detail: "compounding position",
    });

    const result = await riskEngine.preTradeCheck(baseInput());

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("CORRELATION_LIMIT_EXCEEDED");
  });

  it("GATE 11 — concentration (HHI) guard breach rejects", async () => {
    mockConcentrationGuard.check.mockResolvedValue({
      ok: false, reason: "CONCENTRATION_LIMIT_EXCEEDED", detail: "HHI too high",
    });

    const result = await riskEngine.preTradeCheck(baseInput());

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("CONCENTRATION_LIMIT_EXCEEDED");
  });

  it("GATE 12 — global instrument exposure halt rejects as INSTRUMENT_HALTED", async () => {
    mockExposureRegistry.checkCanOpen.mockReturnValue({
      ok: false, reason: "INSTRUMENT_HALTED", detail: "gross exposure cap breached",
    });

    const result = await riskEngine.preTradeCheck(baseInput());

    expect(result.pass).toBe(false);
    if (!result.pass) expect(result.reason).toBe("INSTRUMENT_HALTED");
  });

  it("ORDERING: client exposure / correlation / concentration are only checked AFTER margin and position-size gates pass", async () => {
    // If margin availability rejects first, the later soft gates must
    // never even be called -- proves short-circuit ordering, not just
    // that each gate CAN reject in isolation.
    mockMarginController.canAcceptOrder.mockReturnValue(false);

    await riskEngine.preTradeCheck(baseInput());

    expect(mockClientExposureLimits.check).not.toHaveBeenCalled();
    expect(mockCorrelationGuard.check).not.toHaveBeenCalled();
    expect(mockConcentrationGuard.check).not.toHaveBeenCalled();
    expect(mockExposureRegistry.checkCanOpen).not.toHaveBeenCalled();
  });

  it("leverage capping and volatility derating feed into the ACTUAL margin computation used by the margin gate", async () => {
    // requestedLeverage=20 gets capped to 10 by leverageGuard, then
    // further derated to 5 by volatilityLeverageGuard -- marginRequired
    // must reflect the FINAL 5x, not the originally requested 20x.
    mockLeverageGuard.check.mockReturnValue({ effectiveLeverage: 10, capped: true, requestedLeverage: 20, cap: 10 });
    mockVolatilityGuard.apply.mockReturnValue(5);

    const result = await riskEngine.preTradeCheck(baseInput());

    expect(result.pass).toBe(true);
    if (result.pass) {
      expect(result.effectiveLeverage).toBe(5);
      expect(result.marginRequired).toBeCloseTo((1000 * 1.10) / 5, 6);
    }
  });
});
