/**
 * ledger.engine.withdrawal.spec.ts
 *
 * FASE 4.1 (Risk Engine, Bug #1) — LedgerEngine.requestWithdrawal() and
 * approveWithdrawal() used to compute free margin as balance-locked,
 * completely ignoring open positions' unrealized P&L. A client with an open
 * losing position could request (and have approved) a withdrawal that pulls
 * cash out from under that loss before it was ever realized, since
 * approveWithdrawal only checked raw balance sufficiency.
 *
 * Fix: both now derive free margin from BalanceCalculator (equity =
 * balance + live unrealizedPnL, freeMargin = equity - locked), computed
 * fresh from quoteCache at call time. requestWithdrawal's check is only
 * advisory (early UX rejection); approveWithdrawal's re-check inside the
 * same transaction that performs the debit is the actual security boundary,
 * since market conditions can move between request and admin approval.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuoteGet } = vi.hoisted(() => ({ mockQuoteGet: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockQuoteGet },
}));

const { LedgerEngine } = await import("../wallet-service/ledger.engine.js");

function decimalLike(n: number) {
  return {
    toString: () => String(n),
    toNumber: () => n,
    lt:   (x: number) => n < x,
    minus: (x: number) => decimalLike(n - x),
  };
}

function makeDb(overrides: {
  balance: number;
  locked: number;
  openPositions?: Array<{ symbol: string; side: "BUY" | "SELL"; quantity: number; entryPrice: number }>;
  existingApproval?: unknown;
}) {
  const positions = overrides.openPositions ?? [];

  const walletAccountRow = { balance: decimalLike(overrides.balance), locked: decimalLike(overrides.locked), currency: "USD" };

  const txLike = {
    walletAccount: {
      findUnique: vi.fn().mockResolvedValue(walletAccountRow),
      update:     vi.fn().mockResolvedValue({}),
    },
    position: {
      findMany: vi.fn().mockResolvedValue(positions.map((p) => ({
        symbol: p.symbol, side: p.side, quantity: decimalLike(p.quantity), entryPrice: decimalLike(p.entryPrice),
      }))),
    },
    ledgerEntry: {
      create:     vi.fn().mockResolvedValue({}),
      findFirst:  vi.fn().mockResolvedValue(overrides.existingApproval ?? null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };

  return {
    ...txLike,
    $transaction: vi.fn(async (fn: (tx: typeof txLike) => Promise<unknown>) => fn(txLike)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuoteGet.mockReturnValue(undefined);
});

describe("LedgerEngine.requestWithdrawal() — equity-based free margin", () => {
  it("rejects a withdrawal that exceeds equity-based free margin, even though raw balance covers it", async () => {
    // balance=10,000, locked=3,000, one open BUY position losing $6,000 unrealized
    // → equity = 10,000 - 6,000 = 4,000, freeMargin = 4,000 - 3,000 = 1,000
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 });
    const db = makeDb({
      balance: 10_000, locked: 3_000,
      openPositions: [{ symbol: "EURUSD", side: "BUY", quantity: 100_000, entryPrice: 1.0600 }], // (1.0000-1.0600)*100000 = -6000
    });
    const engine = new LedgerEngine(db as never);

    const result = await engine.requestWithdrawal({ userId: "user-1", amount: 6_000, destination: "bank-1", method: "wire" });

    expect(result.status).toBe("REJECTED");
    expect(result.message).toContain("Insufficient free margin");
  });

  it("accepts a withdrawal within equity-based free margin", async () => {
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 });
    const db = makeDb({
      balance: 10_000, locked: 3_000,
      openPositions: [{ symbol: "EURUSD", side: "BUY", quantity: 100_000, entryPrice: 1.0600 }],
    });
    const engine = new LedgerEngine(db as never);

    const result = await engine.requestWithdrawal({ userId: "user-1", amount: 500, destination: "bank-1", method: "wire" });

    expect(result.status).toBe("PENDING_ADMIN");
  });

  it("with no open positions, free margin equals balance-locked (equity reduces to balance)", async () => {
    const db = makeDb({ balance: 5_000, locked: 1_000, openPositions: [] });
    const engine = new LedgerEngine(db as never);

    const accepted = await engine.requestWithdrawal({ userId: "user-1", amount: 4_000, destination: "bank-1", method: "wire" });
    expect(accepted.status).toBe("PENDING_ADMIN");

    const rejected = await engine.requestWithdrawal({ userId: "user-1", amount: 4_001, destination: "bank-1", method: "wire" });
    expect(rejected.status).toBe("REJECTED");
  });
});

describe("LedgerEngine.approveWithdrawal() — authoritative equity re-check", () => {
  it("throws INSUFFICIENT_FREE_MARGIN and never debits when equity dropped below the withdrawal amount since the request", async () => {
    // Same losing-position scenario as above, but this is the money-moving step.
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 });
    const db = makeDb({
      balance: 10_000, locked: 3_000,
      openPositions: [{ symbol: "EURUSD", side: "BUY", quantity: 100_000, entryPrice: 1.0600 }],
    });
    const engine = new LedgerEngine(db as never);

    await expect(engine.approveWithdrawal("user-1", 6_000, "ref-1")).rejects.toThrow("INSUFFICIENT_FREE_MARGIN");
    expect(db.walletAccount.update).not.toHaveBeenCalled();
    expect(db.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it("approves and debits when equity-based free margin covers the amount", async () => {
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 });
    const db = makeDb({
      balance: 10_000, locked: 1_000,
      openPositions: [{ symbol: "EURUSD", side: "BUY", quantity: 10_000, entryPrice: 1.0001 }], // negligible pnl
    });
    const engine = new LedgerEngine(db as never);

    await engine.approveWithdrawal("user-1", 5_000, "ref-1");

    expect(db.walletAccount.update).toHaveBeenCalledTimes(1);
    expect(db.ledgerEntry.create).toHaveBeenCalledTimes(1);
  });

  it("still throws INSUFFICIENT_BALANCE when raw balance itself is short, independent of the free-margin check", async () => {
    const db = makeDb({ balance: 100, locked: 0, openPositions: [] });
    const engine = new LedgerEngine(db as never);

    await expect(engine.approveWithdrawal("user-1", 500, "ref-1")).rejects.toThrow("INSUFFICIENT_BALANCE");
  });

  it("is idempotent: a second approval for an already-COMPLETED reference is a no-op, no re-debit", async () => {
    const db = makeDb({
      balance: 10_000, locked: 0, openPositions: [],
      existingApproval: { id: "already-done" },
    });
    const engine = new LedgerEngine(db as never);

    await engine.approveWithdrawal("user-1", 5_000, "ref-1");

    expect(db.walletAccount.update).not.toHaveBeenCalled();
  });
});
