/**
 * swap.accrual.weekend.date.spec.ts
 *
 * PHASE H (fresh due-diligence audit): SwapAccrualService's real nightly
 * charging path -- nightsForAccrualDate() (formerly nightsForToday()) --
 * had two bugs, both in the same small function:
 *
 *   1. It never skipped Saturday for any asset class. FX/commodities/
 *      indices/equities are all closed on Saturday (same assumption
 *      already made by market-data/synthetic.seeder.ts and by
 *      trading-service/swap.calculator.ts's own _countNights(), which DOES
 *      skip Saturday) -- but quoteCache never expires, so Friday's
 *      stale-but-positive closing price always passed accruePosition()'s
 *      only guard (`midPrice <= 0`). The result: every open non-crypto
 *      position was silently charged a real, ledger-committed night of
 *      swap every single Saturday, forever, for as long as it stayed
 *      open -- a genuine, unconditional, recurring overcharge with no
 *      live market activity behind it.
 *
 *   2. It read `new Date().getUTCDay()` (wall-clock "now") instead of the
 *      `accrualDate` parameter being charged, even though the reference
 *      string built a few lines below already derives from accrualDate
 *      specifically to support a future catch-up run for a missed day.
 *      A catch-up run for a missed Wednesday, executed on any other day,
 *      would silently apply the wrong (non-triple) multiplier.
 *
 * Fix: nightsForAccrualDate(symbol, accrualDate) now reads accrualDate's
 * day-of-week, and returns 0 (skip, no ledger/audit rows written at all)
 * on Saturday for every asset class except the 24/7 ones (currently just
 * CRYPTO).
 *
 * Reuses swap.accrual.service.audit.spec.ts's mocking scaffold.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn(), observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

const { mockGetQuote } = vi.hoisted(() => ({ mockGetQuote: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({ quoteCache: { get: mockGetQuote } }));

const { mockPreview, mockCompute } = vi.hoisted(() => ({
  mockPreview: vi.fn(), mockCompute: vi.fn(),
}));
vi.mock("../trading-service/swap.calculator.js", () => ({
  swapCalculator: { preview: mockPreview, compute: mockCompute },
}));

vi.mock("../shared/distributed.job.lock.js", () => ({
  DistributedJobLock: vi.fn().mockImplementation(() => ({
    tryAcquire: vi.fn().mockResolvedValue(true),
    startRenewal: vi.fn().mockReturnValue(0 as unknown as NodeJS.Timeout),
    release: vi.fn().mockResolvedValue(undefined),
  })),
}));

const {
  mockSwapAccrualFindFirst, mockSwapAccrualCreate,
  mockLedgerCreate, mockWalletUpdate, mockAuditLogCreate, mockTransaction,
} = vi.hoisted(() => ({
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
    auditLog:      { create: mockAuditLogCreate },
    $executeRaw:   vi.fn().mockResolvedValue(0),
    $queryRaw:     vi.fn().mockResolvedValue([]),
  };
  return {
    IS_PERSISTENT: true,
    prisma: {
      position:    { findMany: vi.fn().mockResolvedValue([]) },
      swapAccrual: { findFirst: mockSwapAccrualFindFirst },
      $transaction: mockTransaction,
      __tx: tx,
    },
  };
});

const { swapAccrualService } = await import("../settlement/swap.accrual.service.js");
const { prisma } = await import("../shared/db.js");

function position(symbol: string, side: "BUY" | "SELL" = "BUY") {
  return {
    id: `pos-${symbol}`, userId: "user-1", symbol, side,
    quantity: { toNumber: () => 10_000 }, openedAt: new Date("2026-07-01T00:00:00Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetQuote.mockReturnValue({ mid: 1.10 }); // stale-but-positive "Friday close" price
  mockPreview.mockReturnValue(-2.5);
  mockCompute.mockReturnValue({ totalSwap: -2.5, perNight: -2.5, nights: 1, rateAnnual: 3.2 });
  mockSwapAccrualFindFirst.mockResolvedValue(null);
  const tx = (prisma as unknown as { __tx: unknown }).__tx;
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
});

describe("SwapAccrualService.accruePosition() — PHASE H: Saturday weekend gate", () => {
  it("Saturday, EURUSD (FX_MAJOR): charges ZERO, writes no SwapAccrual/Ledger/Audit rows at all", async () => {
    // 2026-07-18 is a Saturday.
    const charged = await swapAccrualService.accruePosition(position("EURUSD"), new Date("2026-07-18T00:00:00Z"));

    expect(charged).toBe(0);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockLedgerCreate).not.toHaveBeenCalled();
    expect(mockWalletUpdate).not.toHaveBeenCalled();
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
  });

  it("Saturday, XAUUSD (COMMODITY): also charges ZERO -- Saturday skip applies to every non-24/7 class", async () => {
    const charged = await swapAccrualService.accruePosition(position("XAUUSD"), new Date("2026-07-18T00:00:00Z"));
    expect(charged).toBe(0);
    expect(mockWalletUpdate).not.toHaveBeenCalled();
  });

  it("Saturday, US500 (INDEX): also charges ZERO", async () => {
    const charged = await swapAccrualService.accruePosition(position("US500"), new Date("2026-07-18T00:00:00Z"));
    expect(charged).toBe(0);
    expect(mockWalletUpdate).not.toHaveBeenCalled();
  });

  it("Saturday, BTCUSD (CRYPTO): STILL charges -- crypto markets never close", async () => {
    const charged = await swapAccrualService.accruePosition(position("BTCUSD"), new Date("2026-07-18T00:00:00Z"));

    expect(charged).toBeCloseTo(-2.5, 8);
    expect(mockWalletUpdate).toHaveBeenCalledTimes(1);
    expect(mockLedgerCreate).toHaveBeenCalledTimes(1);
  });

  it("Sunday, EURUSD: charges normally (1 night) -- only Saturday is skipped, not the whole weekend", async () => {
    // 2026-07-19 is a Sunday.
    const charged = await swapAccrualService.accruePosition(position("EURUSD"), new Date("2026-07-19T00:00:00Z"));
    expect(charged).toBeCloseTo(-2.5, 8);
  });

  it("Wednesday, EURUSD: still applies the 3x multiplier as before (regression check)", async () => {
    // 2026-07-15 is a Wednesday.
    const charged = await swapAccrualService.accruePosition(position("EURUSD"), new Date("2026-07-15T00:00:00Z"));
    expect(charged).toBeCloseTo(-7.5, 8); // -2.5 * 3
    const calls = mockSwapAccrualCreate.mock.calls as unknown as Array<[{ data: { nights: number } }]>;
    const swapCreateArgs = calls[0]![0];
    expect(swapCreateArgs.data.nights).toBe(3);
  });
});

describe("SwapAccrualService.accruePosition() — PHASE H: accrualDate drives the multiplier, not wall-clock now", () => {
  it("a catch-up run for a missed Wednesday (executed on a later day) still applies the 3x multiplier", async () => {
    // The call happens "now" (whatever the real wall-clock is when this
    // test runs), but accrualDate says the day being charged was a
    // Wednesday (2026-07-15) -- proves the day-of-week comes from
    // accrualDate, not from `new Date()` inside the function.
    const charged = await swapAccrualService.accruePosition(position("EURUSD"), new Date("2026-07-15T00:00:00Z"));
    expect(charged).toBeCloseTo(-7.5, 8);
  });

  it("a catch-up run for a missed Saturday still correctly charges zero, regardless of wall-clock now", async () => {
    const charged = await swapAccrualService.accruePosition(position("EURUSD"), new Date("2026-07-18T00:00:00Z"));
    expect(charged).toBe(0);
  });
});
