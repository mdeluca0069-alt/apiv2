/**
 * ledger.engine.deposit.spec.ts
 *
 * FASE 5.1 (Ledger, Bug #5, LEDGER_FREEZE.md §0.5) — LedgerEngine.approveDeposit()
 * -- an admin crediting a manual deposit (e.g. a bank wire) -- wrote zero
 * AuditLog entries, unlike rejectDeposit() right below it. No record of
 * which admin approved a manual credit into a client account existed.
 *
 * Fix: approveDeposit() now takes an adminId parameter and writes an
 * AuditLog row (action: "deposit.approved") inside the same transaction as
 * the credit, mirroring rejectDeposit()'s existing pattern.
 *
 * Unlike the withdrawal side (see ledger.engine.withdrawal.spec.ts's
 * sign-inversion regression tests), requestDeposit() stores its
 * DEPOSIT_REQUEST ledger amount as POSITIVE, matching what approveDeposit()
 * expects -- confirmed here too, so this file also guards against that
 * class of bug recurring on the deposit side.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
    plus: (x: number) => decimalLike(n + x),
  };
}

function makeDb(overrides: { balance: number; existingApproval?: unknown }) {
  const walletAccountRow = { balance: decimalLike(overrides.balance), currency: "USD" };

  const txLike = {
    walletAccount: {
      findUnique: vi.fn().mockResolvedValue(walletAccountRow),
      update:     vi.fn().mockResolvedValue({}),
      upsert:     vi.fn().mockResolvedValue(walletAccountRow),
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
});

describe("LedgerEngine.requestDeposit() — stores a positive amount (unlike withdrawals)", () => {
  it("persists the PENDING_ADMIN entry with a positive amount", async () => {
    const db = makeDb({ balance: 0 });
    const engine = new LedgerEngine(db as never);

    await engine.requestDeposit({ userId: "user-1", amount: 500, method: "wire" });

    expect(db.ledgerEntry.create).toHaveBeenCalledTimes(1);
    const stored = db.ledgerEntry.create.mock.calls[0][0] as { data: { amount: number } };
    expect(stored.data.amount).toBe(500);
  });
});

describe("LedgerEngine.approveDeposit() — credits the client correctly", () => {
  it("credits the balance by the deposited amount and creates a COMPLETED ledger entry", async () => {
    const db = makeDb({ balance: 1_000 });
    const engine = new LedgerEngine(db as never);

    await engine.approveDeposit("user-1", 500, "ref-1", "admin-1");

    expect(db.walletAccount.update).toHaveBeenCalledTimes(1);
    const updateArg = db.walletAccount.update.mock.calls[0][0] as { data: { balance: { toNumber(): number } } };
    expect(updateArg.data.balance.toNumber()).toBe(1_500); // 1,000 + 500

    expect(db.ledgerEntry.create).toHaveBeenCalledTimes(1);
    const entry = db.ledgerEntry.create.mock.calls[0][0] as { data: { amount: number; status: string; type: string } };
    expect(entry.data.amount).toBe(500);
    expect(entry.data.status).toBe("COMPLETED");
    expect(entry.data.type).toBe("ADMIN_CAPITAL_ALLOCATION");
  });

  it("is idempotent: a second approval for an already-approved reference is a no-op, no re-credit", async () => {
    const db = makeDb({ balance: 1_000, existingApproval: { id: "already-done" } });
    const engine = new LedgerEngine(db as never);

    await engine.approveDeposit("user-1", 500, "ref-1", "admin-1");

    expect(db.walletAccount.update).not.toHaveBeenCalled();
    expect(db.ledgerEntry.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("throws WALLET_NOT_FOUND and writes nothing when the wallet doesn't exist", async () => {
    const db = makeDb({ balance: 0 });
    db.walletAccount.findUnique.mockResolvedValueOnce(null);
    const engine = new LedgerEngine(db as never);

    await expect(engine.approveDeposit("user-1", 500, "ref-1", "admin-1")).rejects.toThrow("WALLET_NOT_FOUND");
    expect(db.walletAccount.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("LedgerEngine.approveDeposit() — audit trail (Bug #5, LEDGER_FREEZE.md §0.5)", () => {
  it("writes an AuditLog row, inside the same transaction, recording which admin approved the credit", async () => {
    const db = makeDb({ balance: 1_000 });
    const engine = new LedgerEngine(db as never);

    await engine.approveDeposit("user-1", 500, "ref-1", "admin-42");

    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const entry = db.auditLog.create.mock.calls[0][0].data as {
      actor: string; action: string; entity: string; payload: { amount: number; reference: string };
    };
    expect(entry.actor).toBe("admin-42");
    expect(entry.action).toBe("deposit.approved");
    expect(entry.entity).toBe("user-1");
    expect(entry.payload.amount).toBe(500);
    expect(entry.payload.reference).toBe("ref-1");
  });
});

describe("LedgerEngine — Notification/Metrics (Bug #10, LEDGER_FREEZE.md §0.10)", () => {
  it("requestDeposit() increments deposit_requests_total", async () => {
    const db = makeDb({ balance: 0 });
    const engine = new LedgerEngine(db as never);

    await engine.requestDeposit({ userId: "user-1", amount: 500, method: "wire" });

    expect(mockMetricsInc).toHaveBeenCalledWith("deposit_requests_total");
  });

  it("approveDeposit() emits a wallet.event CREDIT and increments deposit metrics on a genuine approval", async () => {
    const db = makeDb({ balance: 1_000 });
    const engine = new LedgerEngine(db as never);

    await engine.approveDeposit("user-1", 500, "ref-1", "admin-1");

    expect(emitSpy).toHaveBeenCalledWith("wallet.event", expect.objectContaining({
      userId: "user-1", type: "CREDIT", amount: 500,
    }));
    expect(mockMetricsInc).toHaveBeenCalledWith("igfx_deposits_total");
    expect(mockMetricsInc).toHaveBeenCalledWith("deposit_approvals_total");
    expect(mockMetricsObserve).toHaveBeenCalledWith("igfx_deposit_amount_usd", 500);
  });

  it("approveDeposit() emits/increments nothing on an idempotent no-op replay", async () => {
    const db = makeDb({ balance: 1_000, existingApproval: { id: "already-done" } });
    const engine = new LedgerEngine(db as never);

    await engine.approveDeposit("user-1", 500, "ref-1", "admin-1");

    expect(emitSpy).not.toHaveBeenCalled();
    expect(mockMetricsInc).not.toHaveBeenCalledWith("igfx_deposits_total");
  });
});
