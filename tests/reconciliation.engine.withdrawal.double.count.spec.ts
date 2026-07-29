/**
 * reconciliation.engine.withdrawal.double.count.spec.ts
 *
 * CRITICAL_REMEDIATION Phase 1, finding C3 (PRODUCTION_RISK_REGISTER.md /
 * CRITICAL_REMEDIATION_REPORT.md).
 *
 * Root cause: approveWithdrawal() (wallet-service/ledger.engine.ts) writes
 * TWO WITHDRAW_REQUEST-typed rows per approved withdrawal -- the original
 * PENDING_ADMIN request row, flipped to status=APPROVED as a processed
 * marker, and a separate, real status=COMPLETED debit row. Both share
 * type="WITHDRAW_REQUEST", and the reconciliation engine's ledger-balance
 * invariant summed BOTH ("COMPLETED", "APPROVED") toward the same total,
 * double-counting every approved withdrawal and reporting a permanent false
 * MISMATCH on every account that has ever had one -- live-reproduced
 * 2026-07-29 (a single $100 withdrawal produced delta:100 forever). This is
 * the control that should have caught C1 (the withdrawal idempotency bug)
 * in production; instead it fired false positives on 100% of legitimate
 * withdrawal activity, training operators to ignore it.
 *
 * Fix: exclude WITHDRAW_REQUEST rows specifically when status=APPROVED from
 * the balance sum -- in every real code path (LedgerEngine.
 * approveWithdrawal(), BrokerState.adminReviewLedger()'s legacy path), that
 * combination is always the flipped request-marker row, never a second real
 * debit. ADMIN_CAPITAL_ALLOCATION-typed rows (a different type) are
 * unaffected and still counted regardless of status.
 */
import { describe, it, expect, vi } from "vitest";

function dec(n: number) {
  return { toNumber: () => n, valueOf: () => n };
}

const {
  mockWalletFindUnique, mockPositionFindMany, mockLedgerFindMany,
} = vi.hoisted(() => ({
  mockWalletFindUnique: vi.fn(),
  mockPositionFindMany: vi.fn().mockResolvedValue([]),
  mockLedgerFindMany:   vi.fn(),
}));

vi.mock("../shared/db.js", () => ({
  prisma: {
    walletAccount: { findUnique: mockWalletFindUnique },
    position:      { findMany: mockPositionFindMany },
    ledgerEntry:   { findMany: mockLedgerFindMany },
  },
  IS_PERSISTENT: true,
}));
vi.mock("../gateway/metrics.js", () => ({ metrics: { inc: vi.fn(), set: vi.fn() } }));
vi.mock("../alerting/alert.manager.js", () => ({ alertManager: { send: vi.fn() } }));

const { reconciliationEngine } = await import("../settlement/reconciliation.engine.js");

describe("CRITICAL_REMEDIATION (C3) — ledger balance invariant no longer double-counts approved withdrawals", () => {
  it("does not report a MISMATCH for a wallet correctly debited by exactly one approved withdrawal", async () => {
    // Exact shape LedgerEngine.approveWithdrawal() produces: the original
    // request row (now APPROVED, -100) plus the real settlement row
    // (COMPLETED, -100). Wallet started at 20,000 and correctly reflects
    // one $100 debit -> balance 19,900.
    mockWalletFindUnique.mockResolvedValue({ balance: dec(19_900), locked: dec(0) });
    mockPositionFindMany.mockResolvedValue([]);
    mockLedgerFindMany.mockResolvedValue([
      { amount: dec(20_000), type: "ADMIN_CAPITAL_ALLOCATION", status: "COMPLETED" },
      { amount: dec(-100),   type: "WITHDRAW_REQUEST",         status: "APPROVED" },  // marker row
      { amount: dec(-100),   type: "WITHDRAW_REQUEST",         status: "COMPLETED" }, // real debit
    ]);

    const result = await reconciliationEngine.checkUser("user-1");

    // Before the fix: ledgerComputed = 20000 - 100 - 100 = 19800, delta = 100 (false MISMATCH).
    // After the fix: ledgerComputed = 20000 - 100 = 19900, matches the wallet exactly.
    expect(result.ledgerBalance.ledgerComputed).toBe(19_900);
    expect(result.ledgerBalance.status).toBe("OK");
    expect(result.ledgerBalance.delta).toBe(0);
    expect(result.clean).toBe(true);
  });

  it("correctly sums multiple approved withdrawals without compounding the double-count", async () => {
    mockWalletFindUnique.mockResolvedValue({ balance: dec(14_900), locked: dec(0) });
    mockPositionFindMany.mockResolvedValue([]);
    mockLedgerFindMany.mockResolvedValue([
      { amount: dec(20_000), type: "ADMIN_CAPITAL_ALLOCATION", status: "COMPLETED" },
      { amount: dec(-100),   type: "WITHDRAW_REQUEST", status: "APPROVED" },
      { amount: dec(-100),   type: "WITHDRAW_REQUEST", status: "COMPLETED" },
      { amount: dec(-5_000), type: "WITHDRAW_REQUEST", status: "APPROVED" },
      { amount: dec(-5_000), type: "WITHDRAW_REQUEST", status: "COMPLETED" },
    ]);

    const result = await reconciliationEngine.checkUser("user-1");

    expect(result.ledgerBalance.ledgerComputed).toBe(14_900);
    expect(result.ledgerBalance.status).toBe("OK");
  });

  it("still detects a genuine mismatch (does not become blind to real drift)", async () => {
    mockWalletFindUnique.mockResolvedValue({ balance: dec(19_900), locked: dec(0) });
    mockPositionFindMany.mockResolvedValue([]);
    mockLedgerFindMany.mockResolvedValue([
      { amount: dec(20_000), type: "ADMIN_CAPITAL_ALLOCATION", status: "COMPLETED" },
      { amount: dec(-100), type: "WITHDRAW_REQUEST", status: "APPROVED" },
      { amount: dec(-100), type: "WITHDRAW_REQUEST", status: "COMPLETED" },
      // A genuinely unaccounted-for extra debit that should still be caught:
      { amount: dec(-300), type: "COMMISSION", status: "COMPLETED" },
    ]);

    const result = await reconciliationEngine.checkUser("user-1");

    expect(result.ledgerBalance.status).toBe("MISMATCH");
    expect(result.ledgerBalance.delta).toBe(300);
  });

  it("does not exclude ADMIN_CAPITAL_ALLOCATION rows with status=APPROVED (the legacy admin path is unaffected)", async () => {
    // BrokerState.adminReviewLedger()'s legacy path creates
    // ADMIN_CAPITAL_ALLOCATION rows with status=APPROVED to represent real
    // money movement -- a different type from WITHDRAW_REQUEST, so the C3
    // fix's type-scoped exclusion must not touch it.
    mockWalletFindUnique.mockResolvedValue({ balance: dec(500), locked: dec(0) });
    mockPositionFindMany.mockResolvedValue([]);
    mockLedgerFindMany.mockResolvedValue([
      { amount: dec(1_000), type: "ADMIN_CAPITAL_ALLOCATION", status: "APPROVED" },
      { amount: dec(-500),  type: "ADMIN_CAPITAL_ALLOCATION", status: "APPROVED" },
    ]);

    const result = await reconciliationEngine.checkUser("user-1");

    expect(result.ledgerBalance.ledgerComputed).toBe(500);
    expect(result.ledgerBalance.status).toBe("OK");
  });
});
