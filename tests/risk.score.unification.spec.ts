/**
 * risk.score.unification.spec.ts
 *
 * FASE 4.3 (Risk Engine, Bug #8) — risk.snapshot.service.ts (dashboard Risk
 * Center) and risk.warning.generator.ts (persisted RiskWarning row) used to
 * compute two INDEPENDENT riskScore formulas for the same concept -- a
 * weighted composite (margin/drawdown/concentration/utilisation) in one,
 * a pure linear function of marginLevelPct alone in the other. The two
 * could disagree for the same user at the same instant depending on which
 * endpoint was queried.
 *
 * Fix: risk.warning.generator.ts now calls riskSnapshotService.getSnapshot()
 * and reuses its riskScore verbatim instead of a second formula. This test
 * proves the convergence directly: neither service is mocked here (only
 * their shared DB/quote/analytics dependencies are), so both code paths run
 * for real against the same underlying user state and must produce the
 * identical riskScore.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

function dec(n: number) {
  return { toNumber: () => n, valueOf: () => n };
}

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    walletAccount: { findUnique: vi.fn() },
    position:      { findMany: vi.fn() },
    instrument:    { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("../shared/db.js", () => ({ IS_PERSISTENT: true, prisma: mockDb }));

vi.mock("../analytics/trading.analytics.service.js", () => ({
  tradingAnalyticsService: { getStats: vi.fn().mockResolvedValue({ maxDrawdown: 0 }) },
}));

const { mockQuoteGet } = vi.hoisted(() => ({ mockQuoteGet: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({ quoteCache: { get: mockQuoteGet } }));

vi.mock("../risk-service/kill.switch.js", () => ({
  killSwitch: { isActive: vi.fn().mockReturnValue(false), getState: vi.fn().mockReturnValue({ active: false, reason: "" }) },
}));
vi.mock("../shared/trading.suspension.js", () => ({
  tradingSuspension: { isSuspended: vi.fn().mockReturnValue(false) },
}));

const { mockCreateOrUpdateWarning } = vi.hoisted(() => ({ mockCreateOrUpdateWarning: vi.fn().mockResolvedValue({}) }));
vi.mock("../risk-service/risk.warning.service.js", () => ({
  riskWarningService: { createOrUpdateWarning: mockCreateOrUpdateWarning },
}));

// Deliberately NOT mocked: risk.snapshot.service.js, margin.controller.js,
// pnl.calculator.js -- the whole point is to run the real formulas.
const { riskWarningGenerator } = await import("../risk-service/risk.warning.generator.js");
const { riskSnapshotService }  = await import("../risk-service/risk.snapshot.service.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockQuoteGet.mockReturnValue(undefined); // no open-position PnL complexity needed for this test
});

describe("riskWarningGenerator and riskSnapshotService — unified riskScore", () => {
  it("produce the identical riskScore for a healthy account", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: dec(10_000), locked: dec(1_000) });
    mockDb.position.findMany.mockResolvedValue([]);

    await riskWarningGenerator.generateForUser("user-1");
    const warningPayload = mockCreateOrUpdateWarning.mock.calls[0][0];

    const directSnapshot = await riskSnapshotService.getSnapshot("user-1");

    expect(warningPayload.riskScore).toBe(directSnapshot.riskScore);
  });

  it("produce the identical riskScore for an account near the stop-out floor", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: dec(100), locked: dec(200) });
    mockDb.position.findMany.mockResolvedValue([]);

    await riskWarningGenerator.generateForUser("user-2");
    const warningPayload = mockCreateOrUpdateWarning.mock.calls[0][0];

    const directSnapshot = await riskSnapshotService.getSnapshot("user-2");

    expect(warningPayload.riskScore).toBe(directSnapshot.riskScore);
  });

  it("produce the identical riskScore with open positions contributing margin utilisation/concentration", async () => {
    mockDb.walletAccount.findUnique.mockResolvedValue({ balance: dec(5_000), locked: dec(2_000) });
    const positions = [
      { symbol: "EURUSD", side: "BUY",  quantity: dec(10_000), entryPrice: dec(1.10), marginUsed: dec(1_200), leverage: 10 },
      { symbol: "BTCUSD", side: "SELL", quantity: dec(1),      entryPrice: dec(60_000), marginUsed: dec(800), leverage: 5 },
    ];
    mockDb.position.findMany.mockResolvedValue(positions);

    await riskWarningGenerator.generateForUser("user-3");
    const warningPayload = mockCreateOrUpdateWarning.mock.calls[0][0];

    const directSnapshot = await riskSnapshotService.getSnapshot("user-3");

    expect(warningPayload.riskScore).toBe(directSnapshot.riskScore);
  });
});
