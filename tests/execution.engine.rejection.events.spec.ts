/**
 * execution.engine.rejection.events.spec.ts
 *
 * FASE 5.2 (Ledger, Bug #6, LEDGER_FREEZE.md §0.6) — every REJECTED branch
 * inside ExecutionEngine.execute() (MARGIN_INSUFFICIENT, EXECUTION_TIMEOUT,
 * LP_UNAVAILABLE, INSTRUMENT_HALTED, REQUOTE, FOK_UNFILLABLE) used to never
 * call eventBus.emit("order.rejected", ...) -- unlike order.controller.ts's
 * pre-trade rejection path, which does and thereby feeds Metrics
 * (orders_rejected_total), Notification, and the durable event archive. Two
 * rejections producing an identical client-visible OrderAck had radically
 * different downstream completeness depending only on which layer rejected.
 *
 * Fix: every REJECTED branch now calls the same eventBus.emit("order.rejected",
 * {orderId, userId, symbol, reason, timestamp}) shape order.controller.ts
 * already uses. This file proves each branch does it, with the exact reason
 * text passed to orderLifecycle.rejectOrder().
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetQuote } = vi.hoisted(() => ({ mockGetQuote: vi.fn() }));
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

const { mockMetricsInc } = vi.hoisted(() => ({ mockMetricsInc: vi.fn() }));
vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: mockMetricsInc, observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

vi.mock("../settlement/reconciliation.engine.js", () => ({
  reconciliationEngine: { repairOrphanMargin: vi.fn().mockResolvedValue(0) },
}));

// Spy on the real eventBus singleton (see broker-state.admin.capital.spec.ts
// for why: other modules register their own eventBus.on(...) listeners at
// import time and would break if the module were replaced with a bare stub).
const { eventBus } = await import("../events-bus/event.bus.js");
const emitSpy = vi.spyOn(eventBus, "emit");

const { executionEngine } = await import("../execution-service/execution.engine.js");

const ORIGINAL_QUOTE = { bid: 1.0868, ask: 1.0870, mid: 1.0869, symbol: "EURUSD", spread: 0.0002, changePct: 0.1 };

function baseRequest() {
  return {
    orderId: "order-1", userId: "user-1", symbol: "EURUSD",
    side: "BUY" as const, type: "MARKET" as const,
    quantity: 10_000, leverage: 10, marginRequired: 100, notional: 10_870,
  };
}

function fullFillResult() {
  return { averagePrice: 1.0870, filledQuantity: 10_000, remainingQuantity: 0, partialFill: false, slippage: 0, fees: 1.08 };
}

function makeQueryRawDispatcher(walletBalance: string, walletLocked: string) {
  return (strings: TemplateStringsArray) => {
    const sql = strings.join("");
    if (sql.includes("SET locked = locked +")) {
      const available = Number(walletBalance) - Number(walletLocked);
      return Promise.resolve(available >= 1086.70 ? [{ id: "ledger-1" }] : []);
    }
    if (sql.includes("WalletAccount")) return Promise.resolve([{ balance: walletBalance, locked: walletLocked }]);
    if (sql.includes("filledQuantity")) return Promise.resolve([{ status: "FILLED", filledQty: "10000", qty: "10000" }]);
    return Promise.resolve([]);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetQuote.mockReturnValue(ORIGINAL_QUOTE); // fresh quote == original quote by default -> no requote
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
  mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("100000", "0"));
  mockTx.position.create.mockResolvedValue({});
  mockTx.outboxEvent.create.mockResolvedValue({ id: "outbox-1" });
  mockCheckCanOpenAtomic.mockResolvedValue({ ok: true });
});

function lastRejectedEmit() {
  const call = emitSpy.mock.calls.find((c) => c[0] === "order.rejected");
  return call?.[1] as { orderId: string; userId: string; symbol: string; reason: string; timestamp: string } | undefined;
}

describe("ExecutionEngine.execute() — order.rejected eventBus emit on every REJECTED branch", () => {
  it("REQUOTE: emits order.rejected with the requote reason", async () => {
    mockGetQuote.mockReturnValue({ ...ORIGINAL_QUOTE, ask: 1.0970 }); // >0.25% FX_MAJOR tolerance
    mockFill.mockReturnValue(fullFillResult());

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("REQUOTE");
    const emitted = lastRejectedEmit();
    expect(emitted).toBeDefined();
    expect(emitted!.orderId).toBe("order-1");
    expect(emitted!.userId).toBe("user-1");
    expect(emitted!.symbol).toBe("EURUSD");
    expect(emitted!.reason).toContain("REQUOTE");
  });

  it("LP_UNAVAILABLE (fill throws): emits order.rejected", async () => {
    mockFill.mockImplementation(() => { throw new Error("no liquidity"); });

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("LP_UNAVAILABLE");
    expect(lastRejectedEmit()?.reason).toBe("Internal LP fill error — no liquidity");
  });

  it("FOK_UNFILLABLE: emits order.rejected", async () => {
    mockFill.mockReturnValue({ averagePrice: 1.0870, filledQuantity: 6_000, remainingQuantity: 4_000, partialFill: true, slippage: 0, fees: 0.65 });

    const result = await executionEngine.execute({ ...baseRequest(), type: "FOK" }, ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("FOK_UNFILLABLE");
    expect(lastRejectedEmit()?.reason).toContain("FOK_UNFILLABLE");
  });

  it("EXECUTION_TIMEOUT (cancelled before margin lock): emits order.rejected", async () => {
    mockFill.mockReturnValue(fullFillResult());
    const cancelToken = { value: true };

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE, cancelToken);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("EXECUTION_TIMEOUT");
    expect(lastRejectedEmit()?.reason).toContain("cancelled before margin lock");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("EXECUTION_TIMEOUT (cancelled after margin lock, inside the transaction): emits order.rejected", async () => {
    mockFill.mockReturnValue(fullFillResult());
    const cancelToken = { value: false };
    // Flip cancelToken to true only once the transaction is entered, so the
    // "before lock" check passes but the "after lock" check inside the tx fires.
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => {
      cancelToken.value = true;
      return fn(mockTx);
    });

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE, cancelToken);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("EXECUTION_TIMEOUT");
    expect(lastRejectedEmit()?.reason).toContain("cancelled after margin lock");
  });

  it("INSTRUMENT_HALTED (exposure check fails inside the transaction): emits order.rejected", async () => {
    mockFill.mockReturnValue(fullFillResult());
    mockCheckCanOpenAtomic.mockResolvedValue({ ok: false, detail: "EURUSD exposure limit reached" });

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("INSTRUMENT_HALTED");
    expect(lastRejectedEmit()?.reason).toBe("EURUSD exposure limit reached");
  });

  it("LP_UNAVAILABLE (generic transaction failure): emits order.rejected", async () => {
    mockFill.mockReturnValue(fullFillResult());
    mockPrisma.$transaction.mockRejectedValue(new Error("connection reset"));

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("LP_UNAVAILABLE");
    expect(lastRejectedEmit()?.reason).toContain("connection reset");
  });

  it("MARGIN_INSUFFICIENT: emits order.rejected", async () => {
    mockFill.mockReturnValue(fullFillResult());
    mockTx.$queryRaw.mockImplementation(makeQueryRawDispatcher("50", "0")); // far below required margin

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("REJECTED");
    expect((result as { reason?: string }).reason).toBe("MARGIN_INSUFFICIENT");
    expect(lastRejectedEmit()).toBeDefined();
  });

  it("does NOT emit order.rejected on a successful fill", async () => {
    mockFill.mockReturnValue(fullFillResult());

    const result = await executionEngine.execute(baseRequest(), ORIGINAL_QUOTE);

    expect(result.status).toBe("FILLED");
    expect(lastRejectedEmit()).toBeUndefined();
  });
});
