/**
 * execution.engine.requote.spec.ts
 *
 * FASE 3.3 — Internal Liquidity Engine.
 *
 * Proves ExecutionEngine.execute() rejects with REQUOTE, cheaply and before
 * any transaction starts (no margin lock, no position, no fill attempted),
 * when the live quote has drifted beyond tolerance from the one the order
 * was originally queued with — and that it fails open (executes normally)
 * when quoteCache has no live quote to compare against, since this is a new
 * protective check layered on top of the existing pipeline, not a
 * replacement for any of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetQuote } = vi.hoisted(() => ({ mockGetQuote: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockGetQuote },
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

const REQ = {
  orderId: "order-1", userId: "user-1", symbol: "EURUSD",
  side: "BUY" as const, type: "MARKET" as const,
  quantity: 10_000, leverage: 10, marginRequired: 100, notional: 10_870,
};
const ORIGINAL_QUOTE = { bid: 1.0868, ask: 1.0870, mid: 1.0869, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 };

function fullFillResult() {
  return {
    averagePrice: 1.0870, filledQuantity: 10_000, remainingQuantity: 0,
    partialFill: false, slippage: 0, fees: 1.08,
  };
}

// tx.$queryRaw serves three distinct callers (margin.controller.ts's
// conditional-lock UPDATE, its diagnostic fallback SELECT, and
// order.lifecycle.ts's recordFillLeg UPDATE) — dispatch on the query text,
// same helper as execution.engine.atomic.spec.ts.
function makeQueryRawDispatcher(walletBalance: string, walletLocked: string) {
  return (strings: TemplateStringsArray) => {
    const sql = strings.join("");
    if (sql.includes("SET locked = locked +")) {
      return Promise.resolve([{ id: "ledger-1" }]);
    }
    if (sql.includes("WalletAccount")) {
      return Promise.resolve([{ balance: walletBalance, locked: walletLocked }]);
    }
    if (sql.includes("filledQuantity")) {
      return Promise.resolve([{ status: "FILLED", filledQty: String(REQ.quantity), qty: String(REQ.quantity) }]);
    }
    return Promise.resolve([]);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
  mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("10000", "0"));
  mockTx.position.create.mockResolvedValue({});
  mockTx.outboxEvent.create.mockResolvedValue({ id: "outbox-1" });
  mockCheckCanOpenAtomic.mockResolvedValue({ ok: true });
  mockFill.mockReturnValue(fullFillResult());
});

describe("ExecutionEngine.execute() — requote check", () => {
  it("rejects with REQUOTE when the live ask drifted beyond tolerance, before any transaction starts", async () => {
    mockGetQuote.mockReturnValue({ bid: 1.0898, ask: 1.0900, mid: 1.0899, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 }); // ~0.276% ask move

    const result = await executionEngine.execute(REQ, ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("REQUOTE");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockFill).not.toHaveBeenCalled();
  });

  it("executes normally when the live quote is within tolerance", async () => {
    mockGetQuote.mockReturnValue({ bid: 1.0869, ask: 1.0871, mid: 1.0870, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 }); // negligible move

    const result = await executionEngine.execute(REQ, ORIGINAL_QUOTE);

    expect(result.status).toBe("FILLED");
    expect(mockFill).toHaveBeenCalledTimes(1);
  });

  it("fails open (executes normally) when quoteCache has no live quote to compare against", async () => {
    mockGetQuote.mockReturnValue(undefined);

    const result = await executionEngine.execute(REQ, ORIGINAL_QUOTE);

    expect(result.status).toBe("FILLED");
    expect(mockFill).toHaveBeenCalledTimes(1);
  });
});
