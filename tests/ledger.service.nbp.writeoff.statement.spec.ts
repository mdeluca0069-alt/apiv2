/**
 * ledger.service.nbp.writeoff.statement.spec.ts
 *
 * PHASE H (fresh due-diligence audit): LedgerService.getStatement()'s
 * per-entry categorization switch had no case for "NBP_WRITEOFF" -- the
 * ledger entry type settlement.engine.ts writes (a positive credit to the
 * client) whenever ESMA negative-balance protection caps a client's
 * aggregate wallet balance at zero after a settlement that would otherwise
 * have pushed it negative (see settlement.engine.ts's own docstring:
 * "residual is absorbed by the broker via an audited NBP_WRITEOFF ledger
 * entry"). Missing from the switch meant `netChange` never included the
 * write-off credit, so `openingBalance + netChange` diverged from the real
 * `closingBalance` by exactly the write-off amount for any period
 * containing one -- the statement couldn't reconcile to itself, and
 * understated the client's realized P&L by the amount the broker absorbed
 * on their behalf.
 *
 * Fix: NBP_WRITEOFF now folds into realizedPnl (it's economically a direct
 * offset to the realized loss that triggered it).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockFindMany, mockFindFirst, mockWalletFindUnique } = vi.hoisted(() => ({
  mockFindMany:       vi.fn(),
  mockFindFirst:      vi.fn(),
  mockWalletFindUnique: vi.fn(),
}));
vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    ledgerEntry:   { findMany: mockFindMany, findFirst: mockFindFirst },
    walletAccount: { findUnique: mockWalletFindUnique },
  },
}));

const { ledgerService } = await import("../wallet-service/ledger.service.js");

function entry(type: string, amount: number) {
  return { type, amount: new Decimal(amount), createdAt: new Date("2026-07-15T22:00:00Z") };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindFirst.mockResolvedValue(null); // no prior entry -> openingBalance = 0
});

describe("LedgerService.getStatement() — PHASE H: NBP_WRITEOFF reconciliation", () => {
  it("folds NBP_WRITEOFF into realizedPnl so netChange reconciles to the real closingBalance", async () => {
    // A client with $50 opening, whose positions close for -$350 total
    // (PNL_SETTLEMENT legs), triggering a $300 NBP write-off that floors
    // the wallet at $0 instead of going to -$300.
    mockFindFirst.mockResolvedValue({ runningBalance: new Decimal(50) });
    mockFindMany.mockResolvedValue([
      entry("PNL_SETTLEMENT", -350),
      entry("NBP_WRITEOFF", 300),
    ]);
    mockWalletFindUnique.mockResolvedValue({ balance: new Decimal(0) });

    const statement = await ledgerService.getStatement("user-1", "monthly");

    expect(statement.realizedPnl).toBeCloseTo(-50, 8); // -350 + 300
    expect(statement.closingBalance).toBe(0);
    expect(statement.openingBalance + statement.netChange).toBeCloseTo(statement.closingBalance, 8);
  });

  it("regression: a period with no write-off is unaffected (netChange still reconciles)", async () => {
    mockFindMany.mockResolvedValue([
      entry("PNL_SETTLEMENT", 120),
      entry("COMMISSION", -5),
    ]);
    mockWalletFindUnique.mockResolvedValue({ balance: new Decimal(115) });

    const statement = await ledgerService.getStatement("user-1", "monthly");

    expect(statement.realizedPnl).toBeCloseTo(120, 8);
    expect(statement.commissions).toBeCloseTo(5, 8);
    expect(statement.openingBalance + statement.netChange).toBeCloseTo(statement.closingBalance, 8);
  });
});
