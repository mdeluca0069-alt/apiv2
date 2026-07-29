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

const { mockMetricsInc, mockMetricsObserve } = vi.hoisted(() => ({
  mockMetricsInc: vi.fn(), mockMetricsObserve: vi.fn(),
}));
vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: mockMetricsInc, observe: mockMetricsObserve, set: vi.fn(), get: vi.fn() },
}));

// Spy on the real eventBus singleton -- see broker-state.admin.capital.spec.ts
// for why a full module mock is avoided here.
const { eventBus } = await import("../events-bus/event.bus.js");
const emitSpy = vi.spyOn(eventBus, "emit");

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
    // $queryRaw backs immutableAudit.write()'s chain-head lookup;
    // $executeRaw (below) backs its advisory-lock acquisition
    // (pg_advisory_xact_lock returns void, which $queryRaw cannot
    // deserialize) -- ledger.engine.ts now routes its AuditLog write
    // through immutableAudit.write(..., tx), passing this same mock tx.
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
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

    await expect(engine.approveWithdrawal("user-1", 6_000, "ref-1", "admin-1")).rejects.toThrow("INSUFFICIENT_FREE_MARGIN");
    expect(db.walletAccount.update).not.toHaveBeenCalled();
    expect(db.ledgerEntry.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("approves and debits when equity-based free margin covers the amount", async () => {
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 });
    const db = makeDb({
      balance: 10_000, locked: 1_000,
      openPositions: [{ symbol: "EURUSD", side: "BUY", quantity: 10_000, entryPrice: 1.0001 }], // negligible pnl
    });
    const engine = new LedgerEngine(db as never);

    await engine.approveWithdrawal("user-1", 5_000, "ref-1", "admin-1");

    expect(db.walletAccount.update).toHaveBeenCalledTimes(1);
    expect(db.ledgerEntry.create).toHaveBeenCalledTimes(1);
    // The balance must go DOWN by the withdrawn amount, never up -- this is
    // exactly the direction the sign-inversion bug (see below) got backwards.
    const updateArg  = db.walletAccount.update.mock.calls[0][0] as { data: { balance: { toNumber(): number } } };
    expect(updateArg.data.balance.toNumber()).toBe(5_000); // 10,000 - 5,000
    const ledgerArg  = db.ledgerEntry.create.mock.calls[0][0] as { data: { amount: { toNumber(): number } } };
    expect(ledgerArg.data.amount.toNumber()).toBe(-5_000); // negative: money leaving the client's account
  });

  it("still throws INSUFFICIENT_BALANCE when raw balance itself is short, independent of the free-margin check", async () => {
    const db = makeDb({ balance: 100, locked: 0, openPositions: [] });
    const engine = new LedgerEngine(db as never);

    await expect(engine.approveWithdrawal("user-1", 500, "ref-1", "admin-1")).rejects.toThrow("INSUFFICIENT_BALANCE");
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("is idempotent: a second approval for an already-COMPLETED reference is a no-op, no re-debit", async () => {
    const db = makeDb({
      balance: 10_000, locked: 0, openPositions: [],
      existingApproval: { id: "already-done" },
    });
    const engine = new LedgerEngine(db as never);

    await engine.approveWithdrawal("user-1", 5_000, "ref-1", "admin-1");

    expect(db.walletAccount.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("LedgerEngine.approveWithdrawal() — audit trail (Bug #4, LEDGER_FREEZE.md §0.4)", () => {
  it("writes an AuditLog row, inside the same transaction, recording which admin approved the outbound transfer", async () => {
    const db = makeDb({ balance: 10_000, locked: 0, openPositions: [] });
    const engine = new LedgerEngine(db as never);

    await engine.approveWithdrawal("user-1", 5_000, "ref-1", "admin-42");

    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const entry = db.auditLog.create.mock.calls[0][0].data;
    expect(entry.actor).toBe("admin-42");
    expect(entry.action).toBe("withdrawal.approved");
    expect(entry.entity).toBe("user-1");
    expect(entry.payload.amount).toBe(5_000);
    // CRITICAL_REMEDIATION (C1): the audit payload now records the request's
    // own immutable row id (requestEntryId), not the destination string --
    // see LedgerEngine.approveWithdrawal()'s docstring for the root cause
    // this field rename fixes.
    expect(entry.payload.requestEntryId).toBe("ref-1");
  });
});

describe("Withdrawal request → approve round trip — sign-inversion regression (discovered live, not in the original audit)", () => {
  // requestWithdrawal() stores the PENDING_ADMIN LedgerEntry's amount as
  // NEGATIVE (-input.amount). The admin-approve route reads that same row
  // back and used to pass Number(entry.amount) -- i.e. the negative value --
  // straight into approveWithdrawal(), which treats its `amount` parameter
  // as a positive magnitude (balance.minus(amount), new Decimal(-amount)).
  // The double negative made every approved withdrawal CREDIT the client
  // instead of debiting them, and made the INSUFFICIENT_BALANCE /
  // INSUFFICIENT_FREE_MARGIN checks unconditionally pass (a negative amount
  // is never greater than a positive balance/freeMargin). Reproduced live
  // via a real request+approve round trip against a running server before
  // this fix. The route now does Math.abs(Number(entry.amount)) -- this
  // test proves why: it re-derives the exact negative value
  // requestWithdrawal() persists and confirms only the Math.abs()'d
  // (positive) form produces a correct debit.
  it("the amount requestWithdrawal() persists for admin review is negative", async () => {
    const db = makeDb({ balance: 5_000, locked: 0, openPositions: [] });
    const engine = new LedgerEngine(db as never);

    await engine.requestWithdrawal({ userId: "user-1", amount: 500, destination: "bank-1", method: "wire" });

    expect(db.ledgerEntry.create).toHaveBeenCalledTimes(1);
    const stored = db.ledgerEntry.create.mock.calls[0][0] as { data: { amount: number } };
    expect(stored.data.amount).toBe(-500);
  });

  it("approveWithdrawal() given that same negative value unconverted would credit the client instead of debiting them (the bug, reproduced)", async () => {
    const db = makeDb({ balance: 5_000, locked: 0, openPositions: [] });
    const engine = new LedgerEngine(db as never);
    const storedAmount = -500; // exactly what requestWithdrawal() persists

    await engine.approveWithdrawal("user-1", storedAmount, "ref-1", "admin-1");

    const updateArg = db.walletAccount.update.mock.calls[0][0] as { data: { balance: { toNumber(): number } } };
    // 5,000 - (-500) = 5,500 -- balance goes UP for a "withdrawal". This is
    // the exact defect; the route must never call approveWithdrawal() this way.
    expect(updateArg.data.balance.toNumber()).toBe(5_500);
  });

  it("approveWithdrawal() given Math.abs() of that value (what the fixed route now passes) correctly debits the client", async () => {
    const db = makeDb({ balance: 5_000, locked: 0, openPositions: [] });
    const engine = new LedgerEngine(db as never);
    const storedAmount = -500;

    await engine.approveWithdrawal("user-1", Math.abs(storedAmount), "ref-1", "admin-1");

    const updateArg = db.walletAccount.update.mock.calls[0][0] as { data: { balance: { toNumber(): number } } };
    expect(updateArg.data.balance.toNumber()).toBe(4_500); // 5,000 - 500, correct direction
  });
});

describe("LedgerEngine — Notification/Metrics (Bug #10, LEDGER_FREEZE.md §0.10)", () => {
  it("requestWithdrawal() increments withdrawal_requests_total on a successful request", async () => {
    const db = makeDb({ balance: 5_000, locked: 0, openPositions: [] });
    const engine = new LedgerEngine(db as never);

    await engine.requestWithdrawal({ userId: "user-1", amount: 500, destination: "bank-1", method: "wire" });

    expect(mockMetricsInc).toHaveBeenCalledWith("withdrawal_requests_total");
  });

  it("requestWithdrawal() does NOT increment withdrawal_requests_total when advisory-rejected for insufficient free margin", async () => {
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 });
    const db = makeDb({
      balance: 10_000, locked: 3_000,
      openPositions: [{ symbol: "EURUSD", side: "BUY", quantity: 100_000, entryPrice: 1.0600 }],
    });
    const engine = new LedgerEngine(db as never);

    await engine.requestWithdrawal({ userId: "user-1", amount: 6_000, destination: "bank-1", method: "wire" });

    expect(mockMetricsInc).not.toHaveBeenCalledWith("withdrawal_requests_total");
  });

  it("approveWithdrawal() emits a wallet.event DEBIT and increments withdrawal metrics on a genuine approval", async () => {
    const db = makeDb({ balance: 5_000, locked: 0, openPositions: [] });
    const engine = new LedgerEngine(db as never);

    await engine.approveWithdrawal("user-1", 500, "ref-1", "admin-1");

    expect(emitSpy).toHaveBeenCalledWith("wallet.event", expect.objectContaining({
      userId: "user-1", type: "DEBIT", amount: 500,
    }));
    expect(mockMetricsInc).toHaveBeenCalledWith("igfx_withdrawals_total");
    expect(mockMetricsInc).toHaveBeenCalledWith("withdrawal_approvals_total");
  });

  it("approveWithdrawal() emits/increments nothing on an idempotent no-op replay", async () => {
    const db = makeDb({
      balance: 5_000, locked: 0, openPositions: [],
      existingApproval: { id: "already-done" },
    });
    const engine = new LedgerEngine(db as never);

    await engine.approveWithdrawal("user-1", 500, "ref-1", "admin-1");

    expect(emitSpy).not.toHaveBeenCalled();
    expect(mockMetricsInc).not.toHaveBeenCalledWith("igfx_withdrawals_total");
  });
});

describe("CRITICAL_REMEDIATION (C1) — idempotency guard keyed on the request's own id, not the destination", () => {
  // Live-reproduced 2026-07-29 (CRITICAL_REMEDIATION_REPORT.md, finding C1):
  // approveWithdrawal() used to be called with entry.reference (== the
  // client-supplied `destination`), so a second, genuinely distinct
  // withdrawal request to a destination that had already been approved once
  // matched the idempotency guard's findFirst on that shared destination
  // string and was silently no-op'd -- {"ok":true} returned, the wallet
  // never debited a second time. These tests prove the guard and the
  // subsequent request-row update now query on `id`, never on `reference`/
  // destination, so two distinct requests sharing a destination cannot
  // collide with each other, while a genuine retry of the SAME request
  // (same id) still correctly no-ops.

  it("queries the idempotency guard by the request's own id, never by the destination/reference string", async () => {
    const db = makeDb({ balance: 10_000, locked: 0, openPositions: [] });
    const engine = new LedgerEngine(db as never);

    await engine.approveWithdrawal("user-1", 100, "withdrawal-request-id-AAA", "admin-1");

    const guardCall = db.ledgerEntry.findFirst.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(guardCall.where.reference).toBe("APPROVED:withdrawal-request-id-AAA");
    // The bug this replaces would have received the raw destination string
    // (e.g. "IBAN-SAME-ACCOUNT-999") here instead of a request id -- assert
    // the exact id round-trips unchanged, proving no destination-shaped
    // value is substituted anywhere in the guard's key construction.
    expect(guardCall.where.reference).not.toBe("APPROVED:IBAN-SAME-ACCOUNT-999");
  });

  it("two distinct withdrawal requests sharing the same destination each independently debit the wallet -- the exact scenario that lost $5,000 live", async () => {
    const db = makeDb({ balance: 20_000, locked: 0, openPositions: [] });
    const engine = new LedgerEngine(db as never);

    // Request 1: id "req-A", destination "IBAN-SAME-ACCOUNT-999", $100.
    await engine.approveWithdrawal("user-1", 100, "req-A", "admin-1");
    // Request 2: id "req-B" (DIFFERENT request), SAME destination, $5,000 --
    // this is exactly the live-reproduced scenario from CRITICAL_REMEDIATION_REPORT.md.
    await engine.approveWithdrawal("user-1", 5_000, "req-B", "admin-1");

    // Both must have actually debited -- two real ledgerEntry.create calls,
    // not one real + one silently-skipped-by-the-guard.
    expect(db.ledgerEntry.create).toHaveBeenCalledTimes(2);
    expect(db.walletAccount.update).toHaveBeenCalledTimes(2);
    const secondCreate = db.ledgerEntry.create.mock.calls[1][0] as { data: { reference: string; amount: unknown } };
    expect(secondCreate.data.reference).toBe("APPROVED:req-B");
  });

  it("a genuine retry of the SAME request id is still correctly idempotent (no double-debit)", async () => {
    const db = makeDb({
      balance: 10_000, locked: 0, openPositions: [],
      existingApproval: { id: "already-approved-row" },
    });
    const engine = new LedgerEngine(db as never);

    await engine.approveWithdrawal("user-1", 100, "req-A", "admin-1");

    expect(db.ledgerEntry.create).not.toHaveBeenCalled();
    expect(db.walletAccount.update).not.toHaveBeenCalled();
  });

  it("matches the PENDING_ADMIN → APPROVED status update by id, not by reference/destination", async () => {
    const db = makeDb({ balance: 10_000, locked: 0, openPositions: [] });
    const engine = new LedgerEngine(db as never);

    await engine.approveWithdrawal("user-1", 100, "req-A", "admin-1");

    const updateCall = db.ledgerEntry.updateMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(updateCall.where.id).toBe("req-A");
    expect(updateCall.where).not.toHaveProperty("reference");
  });
});
