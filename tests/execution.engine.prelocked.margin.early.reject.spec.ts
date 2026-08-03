/**
 * execution.engine.prelocked.margin.early.reject.spec.ts
 *
 * PHASE E (failure-injection audit): req.preLockedMargin is only set for a
 * resting-order fill -- order.controller.ts's _parkPendingOrder() locks a
 * MID-price estimate at order-PLACEMENT time, and execute()'s unified fill
 * transaction true-ups (releases the estimate, locks the real amount) as
 * its first step. But seven REJECTED branches return BEFORE that
 * transaction is ever reached: kill switch active, KYC re-check failure,
 * stale feed, requote, LP fill error, FOK-unfillable, and cancel-before-
 * lock. None of them released the pre-locked estimate -- the order is now
 * REJECTED, so it will never reach the transaction that would have
 * released it, and nothing else in the request path reclaims it. It
 * self-healed eventually via the periodic orphan-margin reconciliation
 * sweep (~5 min), but understated the client's free margin until then with
 * no dedicated diagnostic anywhere pointing at why.
 *
 * Fix: a new releasePreLockedMarginIfAny(req) helper is called at each of
 * the seven early-return sites, releasing req.preLockedMargin immediately
 * (via the same releaseMarginWithRetry() already used for the partial-fill
 * unused-margin case) instead of waiting for the periodic sweep.
 *
 * Reuses execution.engine.rejection.events.spec.ts's mocking scaffold,
 * with risk-service/margin.controller.js mocked directly (rather than run
 * through the real controller against a mocked db, as
 * execution.engine.real.price.margin.spec.ts does for the in-transaction
 * H2 true-up) so each early-return branch's release call can be asserted
 * precisely and in isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetQuote, mockIsStale } = vi.hoisted(() => ({ mockGetQuote: vi.fn(), mockIsStale: vi.fn().mockReturnValue(false) }));
vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockGetQuote, isStale: mockIsStale },
}));

const { mockPrisma } = vi.hoisted(() => {
  const mockTx = {
    $queryRaw:   vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    position:    { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    walletAccount: { update: vi.fn().mockResolvedValue({}) },
    ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn() },
  };
  const mockPrisma = {
    $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    $executeRaw:  vi.fn().mockResolvedValue(undefined),
    $queryRaw:    vi.fn(),
    tradeAudit:   { create: vi.fn().mockResolvedValue({}) },
  };
  return { mockTx, mockPrisma };
});
vi.mock("../shared/db.js", () => ({ prisma: mockPrisma, IS_PERSISTENT: true }));

const { mockAssertEligible } = vi.hoisted(() => ({
  mockAssertEligible: vi.fn().mockResolvedValue({ eligible: true }),
}));
vi.mock("../risk-service/risk.engine.js", () => ({
  assertAccountEligibleToTrade: mockAssertEligible,
  getCachedUserTier: vi.fn().mockResolvedValue("STANDARD"),
}));
vi.mock("../risk-service/client.exposure.limits.js", () => ({
  clientExposureLimits: { checkAtomic: vi.fn().mockResolvedValue({ ok: true }) },
}));
vi.mock("../risk-service/concentration.guard.js", () => ({
  concentrationGuard: { checkAtomic: vi.fn().mockResolvedValue({ ok: true }) },
}));

const { mockKillSwitchActive, mockKillSwitchState } = vi.hoisted(() => ({
  mockKillSwitchActive: vi.fn().mockReturnValue(false),
  mockKillSwitchState:  vi.fn().mockReturnValue({ active: false, reason: "" }),
}));
vi.mock("../risk-service/kill.switch.js", () => ({
  killSwitch: { isActive: mockKillSwitchActive, getState: mockKillSwitchState },
}));

const { mockFill } = vi.hoisted(() => ({ mockFill: vi.fn() }));
vi.mock("../execution-service/fill.engine.js", () => ({
  fillEngine: { fill: mockFill, providerId: "MOCK_LP" },
}));

const { mockCheckCanOpenAtomic } = vi.hoisted(() => ({
  mockCheckCanOpenAtomic: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../risk-service/exposure.limits.js", () => ({
  exposureRegistry: {
    openPosition: vi.fn(), closePosition: vi.fn(),
    checkCanOpenAtomic: mockCheckCanOpenAtomic,
  },
}));

vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn(), observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));
vi.mock("../settlement/reconciliation.engine.js", () => ({
  reconciliationEngine: { repairOrphanMargin: vi.fn().mockResolvedValue(0) },
}));

const { mockReleaseMargin } = vi.hoisted(() => ({ mockReleaseMargin: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../risk-service/margin.controller.js", () => ({
  marginController: { checkAndLockMargin: vi.fn(), releaseMargin: mockReleaseMargin },
}));

const { executionEngine } = await import("../execution-service/execution.engine.js");

const ORIGINAL_QUOTE = { bid: 1.0868, ask: 1.0870, mid: 1.0869, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 };

function restingOrderRequest(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "order-resting-1", userId: "user-1", symbol: "EURUSD",
    side: "BUY" as const, type: "MARKET" as const,
    quantity: 10_000, leverage: 10, marginRequired: 100, notional: 10_870,
    preLockedMargin: 108.70, // estimate locked at PARK time by order.controller.ts
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetQuote.mockReturnValue(ORIGINAL_QUOTE);
  mockIsStale.mockReturnValue(false);
  mockKillSwitchActive.mockReturnValue(false);
  mockAssertEligible.mockResolvedValue({ eligible: true });
});

describe("ExecutionEngine.execute() — PHASE E: preLockedMargin released on every early-return REJECTED path", () => {
  it("KILL_SWITCH_ACTIVE: releases preLockedMargin before rejecting", async () => {
    mockKillSwitchActive.mockReturnValue(true);
    mockKillSwitchState.mockReturnValue({ active: true, reason: "admin halt" });

    const result = await executionEngine.execute(restingOrderRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect(mockReleaseMargin).toHaveBeenCalledWith("user-1", "order-resting-1", 108.70);
  });

  it("KYC_NOT_APPROVED: releases preLockedMargin before rejecting", async () => {
    mockAssertEligible.mockResolvedValue({ eligible: false, reason: "KYC revoked" });

    const result = await executionEngine.execute(restingOrderRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect(mockReleaseMargin).toHaveBeenCalledWith("user-1", "order-resting-1", 108.70);
  });

  it("NO_LIVE_MARKET_DATA (stale feed): releases preLockedMargin before rejecting", async () => {
    mockIsStale.mockReturnValue(true);

    const result = await executionEngine.execute(restingOrderRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("NO_LIVE_MARKET_DATA");
    expect(mockReleaseMargin).toHaveBeenCalledWith("user-1", "order-resting-1", 108.70);
  });

  it("REQUOTE: releases preLockedMargin before rejecting", async () => {
    mockGetQuote.mockReturnValue({ ...ORIGINAL_QUOTE, ask: 1.0970 }); // beyond FX_MAJOR tolerance

    const result = await executionEngine.execute(restingOrderRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("REQUOTE");
    expect(mockReleaseMargin).toHaveBeenCalledWith("user-1", "order-resting-1", 108.70);
  });

  it("LP_UNAVAILABLE (fill throws): releases preLockedMargin before rejecting", async () => {
    mockFill.mockImplementation(() => { throw new Error("no liquidity"); });

    const result = await executionEngine.execute(restingOrderRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("LP_UNAVAILABLE");
    expect(mockReleaseMargin).toHaveBeenCalledWith("user-1", "order-resting-1", 108.70);
  });

  it("FOK_UNFILLABLE: releases preLockedMargin before rejecting", async () => {
    mockFill.mockReturnValue({ averagePrice: 1.0870, filledQuantity: 6_000, remainingQuantity: 4_000, partialFill: true, slippage: 0, fees: 0.65 });

    const result = await executionEngine.execute(restingOrderRequest({ type: "FOK" }), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("FOK_UNFILLABLE");
    expect(mockReleaseMargin).toHaveBeenCalledWith("user-1", "order-resting-1", 108.70);
  });

  it("EXECUTION_TIMEOUT (cancelled before margin lock): releases preLockedMargin before rejecting", async () => {
    mockFill.mockReturnValue({ averagePrice: 1.0870, filledQuantity: 10_000, remainingQuantity: 0, partialFill: false, slippage: 0, fees: 1.08 });
    const cancelToken = { value: true };

    const result = await executionEngine.execute(restingOrderRequest(), ORIGINAL_QUOTE, cancelToken);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("EXECUTION_TIMEOUT");
    expect(mockReleaseMargin).toHaveBeenCalledWith("user-1", "order-resting-1", 108.70);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("regression: a MARKET order with no preLockedMargin never calls releaseMargin on an early rejection", async () => {
    mockKillSwitchActive.mockReturnValue(true);
    mockKillSwitchState.mockReturnValue({ active: true, reason: "admin halt" });

    const result = await executionEngine.execute(
      restingOrderRequest({ preLockedMargin: undefined }), ORIGINAL_QUOTE,
    );

    expect(result.status).toBe("REJECTED");
    expect(mockReleaseMargin).not.toHaveBeenCalled();
  });
});
