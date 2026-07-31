/**
 * execution.engine.fok.spec.ts
 *
 * FASE 3.5 — Internal Liquidity Engine (Group C: order types).
 *
 * Proves ExecutionEngine.execute() rejects a FOK (Fill-Or-Kill) order
 * outright — with reason FOK_UNFILLABLE, no transaction started, no margin
 * locked, no position created — whenever the LP's fill would be partial.
 * Also proves a FOK order that CAN be fully filled executes normally, and
 * that a MARKET order under the identical partial-fill LP response is
 * unaffected (partial fills stay a MARKET/IOC-legal outcome — only FOK
 * turns "partial" into "reject the whole order").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetQuote } = vi.hoisted(() => ({ mockGetQuote: vi.fn() }));
// MARKET_DATA_FREEZE.md §0.13: this file doesn't test staleness -- always live.
vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockGetQuote, isStale: vi.fn().mockReturnValue(false) },
}));

const { mockTx, mockPrisma } = vi.hoisted(() => {
  const mockTx = {
    $queryRaw:   vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    position:    { create: vi.fn() },
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

// CRITICAL_REMEDIATION Phase 2 (H15): execute() now re-checks account
// eligibility (KYC) and the kill switch before proceeding -- not the
// subject of this file, so both pass by default.
vi.mock("../risk-service/risk.engine.js", () => ({
  assertAccountEligibleToTrade: vi.fn().mockResolvedValue({ eligible: true }),
}));
vi.mock("../risk-service/kill.switch.js", () => ({
  killSwitch: { isActive: vi.fn().mockReturnValue(false), getState: vi.fn().mockReturnValue({ active: false, reason: "" }) },
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

const { executionEngine } = await import("../execution-service/execution.engine.js");

const ORIGINAL_QUOTE = { bid: 1.0868, ask: 1.0870, mid: 1.0869, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 };

function fokRequest() {
  return {
    orderId: "order-1", userId: "user-1", symbol: "EURUSD",
    side: "BUY" as const, type: "FOK" as const,
    quantity: 10_000, leverage: 10, marginRequired: 100, notional: 10_870,
  };
}

function marketRequest() {
  return { ...fokRequest(), type: "MARKET" as const };
}

function partialFillResult() {
  return {
    averagePrice: 1.0870, filledQuantity: 6_000, remainingQuantity: 4_000,
    partialFill: true, slippage: 0, fees: 0.65,
  };
}

function fullFillResult() {
  return {
    averagePrice: 1.0870, filledQuantity: 10_000, remainingQuantity: 0,
    partialFill: false, slippage: 0, fees: 1.08,
  };
}

function makeQueryRawDispatcher(walletBalance: string, walletLocked: string, filledQty = "10000") {
  return (strings: TemplateStringsArray) => {
    const sql = strings.join("");
    if (sql.includes("SET locked = locked +")) {
      return Promise.resolve([{ id: "ledger-1" }]);
    }
    if (sql.includes("WalletAccount")) {
      return Promise.resolve([{ balance: walletBalance, locked: walletLocked }]);
    }
    if (sql.includes("filledQuantity")) {
      return Promise.resolve([{
        status: filledQty === "10000" ? "FILLED" : "PARTIALLY_FILLED",
        filledQty, qty: "10000",
      }]);
    }
    return Promise.resolve([]);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetQuote.mockReturnValue(ORIGINAL_QUOTE);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
  mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("10000", "0"));
  mockTx.position.create.mockResolvedValue({});
  mockTx.outboxEvent.create.mockResolvedValue({ id: "outbox-1" });
  mockCheckCanOpenAtomic.mockResolvedValue({ ok: true });
});

describe("ExecutionEngine.execute() — FOK (Fill-Or-Kill)", () => {
  it("rejects with FOK_UNFILLABLE when the fill would be partial, before any transaction starts", async () => {
    mockFill.mockReturnValue(partialFillResult());

    const result = await executionEngine.execute(fokRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("FOK_UNFILLABLE");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockTx.position.create).not.toHaveBeenCalled();
  });

  it("fills normally when the LP can satisfy the full quantity", async () => {
    mockFill.mockReturnValue(fullFillResult());

    const result = await executionEngine.execute(fokRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("FILLED");
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("does NOT reject a MARKET order under the identical partial-fill LP response", async () => {
    mockFill.mockReturnValue(partialFillResult());
    mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("10000", "0", "6000"));

    const result = await executionEngine.execute(marketRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("PARTIALLY_FILLED");
    expect(mockTx.position.create).toHaveBeenCalledTimes(1);
  });
});
