/**
 * ledger.entry.composite.pk.spec.ts
 *
 * Milestone 1 / Fix #11 — schema.prisma now declares LedgerEntry/TradeAudit's
 * real composite primary key (id, createdAt), which required converting
 * every findUnique/update({where:{id}}) call site to findFirst/updateMany
 * (id alone is no longer a valid Prisma unique-where). Proves the two live
 * admin-facing call sites this touched — LedgerEngine.rejectDeposit() and
 * rejectWithdrawal() — still behave correctly: they find the entry by id,
 * validate its state, and update it by id, with the same success/failure
 * semantics as before.
 */
import { describe, it, expect, vi } from "vitest";
import { LedgerEngine } from "../wallet-service/ledger.engine.js";

function makeMockTx(entry: Record<string, unknown> | null) {
  return {
    ledgerEntry: {
      findFirst: vi.fn().mockResolvedValue(entry),
      updateMany: vi.fn().mockResolvedValue({ count: entry ? 1 : 0 }),
      // Presence of findUnique/update would indicate the old, now-invalid
      // pattern is still in use — asserted absent-of-calls in the tests below.
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    // findFirst (below, distinct from ledgerEntry.findFirst above) backs
    // immutableAudit.write()'s chain-head lookup; $executeRaw backs its
    // advisory-lock acquisition (pg_advisory_xact_lock returns void, which
    // $queryRaw cannot deserialize) -- ledger.engine.ts now routes its
    // AuditLog write through immutableAudit.write(..., tx).
    auditLog: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
}

function makeDb(tx: ReturnType<typeof makeMockTx>) {
  return {
    $transaction: vi.fn(async (fn: (tx: ReturnType<typeof makeMockTx>) => Promise<unknown>) => fn(tx)),
  } as unknown as import("@prisma/client").PrismaClient;
}

describe("LedgerEngine.rejectDeposit — composite-PK-safe lookup/update", () => {
  it("finds the entry via findFirst and updates it via updateMany, by id", async () => {
    const tx = makeMockTx({
      id: "entry-1", userId: "user-1", type: "DEPOSIT_REQUEST", status: "PENDING_ADMIN",
      amount: { toString: () => "100" }, reference: "ref-1",
    });
    const engine = new LedgerEngine(makeDb(tx));

    await engine.rejectDeposit("user-1", "entry-1", "admin-1");

    expect(tx.ledgerEntry.findFirst).toHaveBeenCalledWith({ where: { id: "entry-1" } });
    expect(tx.ledgerEntry.updateMany).toHaveBeenCalledWith({ where: { id: "entry-1" }, data: { status: "REJECTED" } });
    expect(tx.ledgerEntry.findUnique).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("throws and never updates when the entry is not found", async () => {
    const tx = makeMockTx(null);
    const engine = new LedgerEngine(makeDb(tx));

    await expect(engine.rejectDeposit("user-1", "missing", "admin-1")).rejects.toThrow("ENTRY_NOT_FOUND_OR_INVALID_STATE");
    expect(tx.ledgerEntry.updateMany).not.toHaveBeenCalled();
  });

  it("throws when the entry belongs to a different user (never trusts client-claimed ownership)", async () => {
    const tx = makeMockTx({
      id: "entry-1", userId: "someone-else", type: "DEPOSIT_REQUEST", status: "PENDING_ADMIN",
      amount: { toString: () => "100" }, reference: "ref-1",
    });
    const engine = new LedgerEngine(makeDb(tx));

    await expect(engine.rejectDeposit("user-1", "entry-1", "admin-1")).rejects.toThrow("ENTRY_NOT_FOUND_OR_INVALID_STATE");
    expect(tx.ledgerEntry.updateMany).not.toHaveBeenCalled();
  });
});

describe("LedgerEngine.rejectWithdrawal — composite-PK-safe lookup/update", () => {
  it("finds the entry via findFirst and updates it via updateMany, by id", async () => {
    const tx = makeMockTx({
      id: "entry-2", userId: "user-1", type: "WITHDRAW_REQUEST", status: "PENDING_ADMIN",
      amount: { toString: () => "50" }, reference: "ref-2",
    });
    const engine = new LedgerEngine(makeDb(tx));

    await engine.rejectWithdrawal("user-1", "entry-2", "admin-1");

    expect(tx.ledgerEntry.findFirst).toHaveBeenCalledWith({ where: { id: "entry-2" } });
    expect(tx.ledgerEntry.updateMany).toHaveBeenCalledWith({ where: { id: "entry-2" }, data: { status: "REJECTED" } });
  });
});
