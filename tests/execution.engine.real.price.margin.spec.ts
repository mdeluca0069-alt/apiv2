/**
 * execution.engine.real.price.margin.spec.ts
 *
 * FASE 4.3 (Risk Engine, Bug #7) — ExecutionEngine.execute() locked
 * req.marginRequired/req.notional -- computed by risk.engine.ts's
 * preTradeCheck() at ORDER-REQUEST time from the MID price -- even though
 * by the time margin is actually locked, the REAL fill price (top-of-book
 * + slippage, from fillEngine.fill()) is already known. The position's
 * persisted marginUsed never matched what was actually filled.
 *
 * Fix: margin/notional are recomputed from the real execPrice right after
 * the fill, and that corrected amount is what actually gets locked --
 * closing a second latent gap for free (the exposure check downstream
 * already read effectiveNotional, so it now checks the real notional too).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetQuote } = vi.hoisted(() => ({ mockGetQuote: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({
  // MARKET_DATA_FREEZE.md §0.13: this file doesn't test staleness -- always live.
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

// mid=1.0000 deliberately far from the real fill price so the mid-based
// req.marginRequired (below) and the real-price-based margin are clearly
// different numbers, not coincidentally close.
const REQ = {
  orderId: "order-1", userId: "user-1", symbol: "EURUSD",
  side: "BUY" as const, type: "MARKET" as const,
  quantity: 10_000, leverage: 10,
  marginRequired: 1_000, // mid-based estimate: 10,000 * 1.0000 / 10
  notional:       10_000,
};
const ORIGINAL_QUOTE = { bid: 0.9998, ask: 1.0000, mid: 1.0000, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 };

function fillAt(averagePrice: number, opts: { partial?: boolean; filled?: number; remaining?: number } = {}) {
  return {
    averagePrice,
    filledQuantity:    opts.filled ?? REQ.quantity,
    remainingQuantity: opts.remaining ?? 0,
    partialFill:       opts.partial ?? false,
    slippage: 0, fees: 0,
  };
}

/** Extracts the Decimal `required` value margin.controller.ts interpolates
 *  into its conditional-lock UPDATE (the first ${...} in that query). */
function lockedAmountFromCall(call: unknown[]): number {
  const value = call[1] as { toNumber?: () => number };
  return typeof value?.toNumber === "function" ? value.toNumber() : Number(value);
}

function makeQueryRawDispatcher(walletBalance: string, walletLocked: string) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("");
    if (sql.includes("SET locked = locked +")) {
      const required  = lockedAmountFromCall([strings, ...values]);
      const available  = Number(walletBalance) - Number(walletLocked);
      if (required > available) return Promise.resolve([]); // WHERE matched 0 rows → insufficient
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
  mockGetQuote.mockReturnValue(undefined); // no requote check interference
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
  mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("100000", "0"));
  mockTx.position.create.mockResolvedValue({});
  mockTx.outboxEvent.create.mockResolvedValue({ id: "outbox-1" });
  mockCheckCanOpenAtomic.mockResolvedValue({ ok: true });
});

describe("ExecutionEngine.execute() — margin locked reflects the real fill price", () => {
  it("locks margin computed from execPrice, not the stale mid-based req.marginRequired", async () => {
    // Real fill at ask=1.0000 + slippage → averagePrice=1.0500 (far from mid=1.0000)
    mockFill.mockReturnValue(fillAt(1.0500));

    const result = await executionEngine.execute(REQ, ORIGINAL_QUOTE);

    expect(result.status).toBe("FILLED");
    const lockCall = mockTx.$queryRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join("").includes("SET locked = locked +"));
    expect(lockCall).toBeDefined();
    const lockedAmount = lockedAmountFromCall(lockCall!);
    // real margin = 10,000 * 1.0500 / 10 = 1,050 -- NOT the stale 1,000 estimate
    expect(lockedAmount).toBeCloseTo(1_050, 2);
    expect(lockedAmount).not.toBeCloseTo(REQ.marginRequired, 2);
  });

  it("rejects with insufficient margin when the real fill price needs more than the client's free margin, even though the mid-based estimate would have fit", async () => {
    // Free margin = 1,020 -- covers the stale mid-based estimate (1,000) but
    // NOT the real-price-based requirement (1,050) computed above.
    mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("1020", "0"));
    mockFill.mockReturnValue(fillAt(1.0500));

    const result = await executionEngine.execute(REQ, ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("MARGIN_INSUFFICIENT");
    expect(mockTx.position.create).not.toHaveBeenCalled();
  });

  it("exposure check is validated against the real notional, not the stale mid-based one", async () => {
    mockFill.mockReturnValue(fillAt(1.0500));

    await executionEngine.execute(REQ, ORIGINAL_QUOTE);

    expect(mockCheckCanOpenAtomic).toHaveBeenCalledTimes(1);
    const notionalArg = mockCheckCanOpenAtomic.mock.calls[0][3];
    // real notional = 10,000 * 1.0500 = 10,500 -- NOT the stale 10,000 estimate
    expect(notionalArg).toBeCloseTo(10_500, 2);
  });

  it("partial fill: the position's persisted marginUsed is scaled from the real price, not the stale estimate", async () => {
    mockFill.mockReturnValue(fillAt(1.0500, { partial: true, filled: 5_000, remaining: 5_000 }));
    mockTx.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes("SET locked = locked +")) return Promise.resolve([{ id: "ledger-1" }]);
      if (sql.includes("WalletAccount")) return Promise.resolve([{ balance: "100000", locked: "0" }]);
      if (sql.includes("filledQuantity")) {
        return Promise.resolve([{ status: "PARTIALLY_FILLED", filledQty: "5000", qty: String(REQ.quantity) }]);
      }
      return Promise.resolve([]);
    });

    const result = await executionEngine.execute(REQ, ORIGINAL_QUOTE);

    expect(result.status).toBe("PARTIALLY_FILLED");
    expect(mockTx.position.create).toHaveBeenCalledTimes(1);
    // realMarginRequired (full) = 10,000*1.05/10 = 1,050; filled 50% → effectiveMargin = 525
    // (not 1,000*0.5 = 500, the stale mid-based figure)
    const posCreateArg = mockTx.position.create.mock.calls[0][0] as { data: { marginUsed: { toNumber(): number } } };
    expect(posCreateArg.data.marginUsed.toNumber()).toBeCloseTo(525, 2);
  });
});
