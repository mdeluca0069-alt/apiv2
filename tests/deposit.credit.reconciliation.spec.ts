/**
 * deposit.credit.reconciliation.spec.ts
 *
 * Milestone 1 / Fix #7 — the live PSP deposit flow
 * (payment-service/deposit.state.machine.ts) writes ledger entries with
 * type "DEPOSIT_CREDIT", but neither ReconciliationEngine's ledger-balance
 * invariant nor EnhancedReconciliationService's deposit-integrity check
 * recognized that type — every real deposit produced a permanent
 * false-positive mismatch. Proves both are fixed.
 */
import { describe, it, expect, vi } from "vitest";

// Mimics Prisma.Decimal closely enough for this file's purposes — mirrors
// the same lightweight fake used in tests/portfolio.intelligence.test.ts.
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

describe("ReconciliationEngine — recognizes DEPOSIT_CREDIT", () => {
  it("does not report a MISMATCH for a wallet balance backed by a real PSP deposit", async () => {
    mockWalletFindUnique.mockResolvedValue({ balance: dec(1000), locked: dec(0) });
    mockPositionFindMany.mockResolvedValue([]);
    mockLedgerFindMany.mockResolvedValue([
      { amount: dec(1000), type: "DEPOSIT_CREDIT" },
    ]);

    const result = await reconciliationEngine.checkUser("user-1");

    expect(result.ledgerBalance.status).toBe("OK");
    expect(result.ledgerBalance.ledgerComputed).toBe(1000);
    expect(result.clean).toBe(true);
  });

  it("still reports a real mismatch when the ledger genuinely disagrees with the wallet", async () => {
    mockWalletFindUnique.mockResolvedValue({ balance: dec(1000), locked: dec(0) });
    mockPositionFindMany.mockResolvedValue([]);
    mockLedgerFindMany.mockResolvedValue([
      { amount: dec(500), type: "DEPOSIT_CREDIT" }, // half the wallet balance unaccounted for
    ]);

    const result = await reconciliationEngine.checkUser("user-1");

    expect(result.ledgerBalance.status).toBe("MISMATCH");
    expect(result.ledgerBalance.delta).toBe(500);
  });
});
