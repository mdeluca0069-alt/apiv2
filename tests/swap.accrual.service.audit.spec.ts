/**
 * swap.accrual.service.audit.spec.ts
 *
 * FASE 5.2 (Ledger, Bug #9, LEDGER_FREEZE.md §0.9) — SwapAccrualService's
 * nightly per-position charge wrote Ledger+Wallet atomically but had zero
 * Audit trail and zero Metrics -- not even a registered counter existed for
 * a successful accrual, and the registered swap_accrual_errors_total
 * counter was never actually incremented anywhere.
 *
 * Fix: the same transaction now also writes an AuditLog row, a successful
 * charge increments a newly-registered swap_accrual_total counter, and a
 * per-position error now increments swap_accrual_errors_total. Event Bus
 * was already durably captured (event.archive.ts's ARCHIVED_EVENTS
 * includes "swap.accrued") -- the original audit finding assumed it was
 * in-memory-only without checking that file; this file's tests confirm the
 * emit still happens, unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockMetricsInc } = vi.hoisted(() => ({ mockMetricsInc: vi.fn() }));
vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: mockMetricsInc, observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

const { mockGetQuote } = vi.hoisted(() => ({ mockGetQuote: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({ quoteCache: { get: mockGetQuote } }));

const { mockPreview, mockCompute } = vi.hoisted(() => ({
  mockPreview: vi.fn(), mockCompute: vi.fn(),
}));
vi.mock("../trading-service/swap.calculator.js", () => ({
  swapCalculator: { preview: mockPreview, compute: mockCompute },
}));

const { mockTryAcquire, mockStartRenewal, mockRelease } = vi.hoisted(() => ({
  mockTryAcquire:   vi.fn().mockResolvedValue(true),
  mockStartRenewal: vi.fn().mockReturnValue(0 as unknown as NodeJS.Timeout),
  mockRelease:      vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../shared/distributed.job.lock.js", () => ({
  DistributedJobLock: vi.fn().mockImplementation(() => ({
    tryAcquire: mockTryAcquire, startRenewal: mockStartRenewal, release: mockRelease,
  })),
}));

const {
  mockPositionFindMany, mockSwapAccrualFindFirst, mockSwapAccrualCreate,
  mockLedgerCreate, mockWalletUpdate, mockAuditLogCreate, mockTransaction,
} = vi.hoisted(() => ({
  mockPositionFindMany:     vi.fn().mockResolvedValue([]),
  mockSwapAccrualFindFirst: vi.fn().mockResolvedValue(null),
  mockSwapAccrualCreate:    vi.fn(async () => ({})),
  mockLedgerCreate:         vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "l-1", ...args.data })),
  mockWalletUpdate:         vi.fn(async () => ({})),
  mockAuditLogCreate:       vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "a-1", ...args.data })),
  mockTransaction:          vi.fn(),
}));

vi.mock("../shared/db.js", () => {
  const tx = {
    swapAccrual:   { findFirst: mockSwapAccrualFindFirst, create: mockSwapAccrualCreate },
    ledgerEntry:   { create: mockLedgerCreate },
    walletAccount: { update: mockWalletUpdate },
    // $queryRaw backs immutableAudit.write()'s chain-head lookup;
    // $executeRaw backs its advisory-lock acquisition (pg_advisory_xact_lock
    // returns void, which $queryRaw cannot deserialize) -- swap.accrual.
    // service.ts now routes its AuditLog write through immutableAudit.
    // write(..., tx), passing this same mock transaction client.
    auditLog:      { create: mockAuditLogCreate },
    $executeRaw:   vi.fn().mockResolvedValue(0),
    $queryRaw:     vi.fn().mockResolvedValue([]),
  };
  return {
    IS_PERSISTENT: true,
    prisma: {
      position:    { findMany: mockPositionFindMany },
      swapAccrual: { findFirst: mockSwapAccrualFindFirst }, // truthy marker used by the !prisma?.swapAccrual guard
      $transaction: mockTransaction,
      __tx: tx,
    },
  };
});

const { eventBus } = await import("../events-bus/event.bus.js");
const emitSpy = vi.spyOn(eventBus, "emit");

const { swapAccrualService } = await import("../settlement/swap.accrual.service.js");
const { prisma } = await import("../shared/db.js");

const POSITION = {
  id: "pos-1", userId: "user-1", symbol: "EURUSD", side: "BUY",
  quantity: { toNumber: () => 10_000 }, openedAt: new Date("2026-07-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetQuote.mockReturnValue({ mid: 1.10 });
  mockPreview.mockReturnValue(-2.5); // per-night charge
  mockCompute.mockReturnValue({ totalSwap: -2.5, perNight: -2.5, nights: 1, rateAnnual: 3.2 });
  mockTryAcquire.mockResolvedValue(true);
  mockSwapAccrualFindFirst.mockResolvedValue(null);
  const tx = (prisma as unknown as { __tx: unknown }).__tx;
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
});

describe("SwapAccrualService.accruePosition() — Bug #9 fix", () => {
  it("writes an AuditLog row inside the same transaction as the Ledger/Wallet mutation", async () => {
    const charged = await swapAccrualService.accruePosition(POSITION, new Date("2026-07-16T00:00:00Z"));

    expect(charged).toBeCloseTo(-2.5, 8);
    expect(mockLedgerCreate).toHaveBeenCalledTimes(1);
    expect(mockWalletUpdate).toHaveBeenCalledTimes(1);
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const entry = mockAuditLogCreate.mock.calls[0][0].data as { action: string; entity: string; payload: { amount: number } };
    expect(entry.action).toBe("swap.accrued");
    expect(entry.entity).toBe("pos-1");
    expect(entry.payload.amount).toBeCloseTo(-2.5, 8);
  });

  it("increments swap_accrual_total on a successful charge and still emits the durably-archived swap.accrued event", async () => {
    await swapAccrualService.accruePosition(POSITION, new Date("2026-07-16T00:00:00Z"));

    expect(mockMetricsInc).toHaveBeenCalledWith("swap_accrual_total");
    expect(emitSpy).toHaveBeenCalledWith("swap.accrued", expect.objectContaining({
      userId: "user-1", positionId: "pos-1", symbol: "EURUSD", swap: -2.5,
    }));
  });

  it("does nothing (no Audit/Metrics/Ledger/Wallet) when already accrued for this day (idempotency)", async () => {
    mockSwapAccrualFindFirst.mockResolvedValue({ id: "already-done" });

    const charged = await swapAccrualService.accruePosition(POSITION, new Date("2026-07-16T00:00:00Z"));

    expect(charged).toBe(0);
    expect(mockLedgerCreate).not.toHaveBeenCalled();
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
    expect(mockMetricsInc).not.toHaveBeenCalledWith("swap_accrual_total");
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("does nothing when there is no live quote for the symbol", async () => {
    mockGetQuote.mockReturnValue(undefined);

    const charged = await swapAccrualService.accruePosition(POSITION, new Date("2026-07-16T00:00:00Z"));

    expect(charged).toBe(0);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
  });
});

describe("SwapAccrualService.accrueAll() — Bug #9 fix: error metric", () => {
  it("increments swap_accrual_errors_total for each position that throws, without stopping the batch", async () => {
    mockPositionFindMany.mockResolvedValue([POSITION, { ...POSITION, id: "pos-2" }]);
    mockTransaction
      .mockRejectedValueOnce(new Error("transient DB error"))
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn((prisma as unknown as { __tx: unknown }).__tx));

    const summary = await swapAccrualService.accrueAll();

    expect(summary.errors).toBe(1);
    expect(summary.positionsProcessed).toBe(1);
    expect(mockMetricsInc).toHaveBeenCalledWith("swap_accrual_errors_total");
  });
});
