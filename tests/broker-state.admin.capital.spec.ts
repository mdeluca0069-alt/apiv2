/**
 * broker-state.admin.capital.spec.ts
 *
 * FASE 5.1 (Ledger, Bug #1, LEDGER_FREEZE.md §0.1) — BrokerState.adminAllocateCapital()/
 * adminWithdrawCapital() used to compute a new WalletAccount.balance from this
 * class's own in-memory ledger (a per-process view never reconciled with the
 * real DB) and blind-overwrite it (`upsert({ update: { balance } })`) instead
 * of an atomic increment/decrement — no transaction, no concurrency guard,
 * no real double-entry, and no Notification/Event Bus/Metrics at all.
 *
 * Fix: when a real Prisma client is present, both methods now go through
 * WalletRepository.credit()/debit() -- the same atomic, Serializable-tx,
 * real-double-entry primitive already used by wallet-service/ledger.engine.ts
 * -- and emit the wallet.event that feeds Notification (notification.router.ts)
 * and the durable event archive (realtime-infra/event.archive.ts), plus a
 * Metrics increment. These tests prove the real WalletRepository is actually
 * invoked (not the old blind overwrite), that failures (insufficient funds)
 * propagate before any audit/in-memory state is touched, and that sandbox
 * mode (no prisma) is unaffected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import type { PrismaClient } from "@prisma/client";

const { mockInc, mockObserve } = vi.hoisted(() => ({ mockInc: vi.fn(), mockObserve: vi.fn() }));
vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: mockInc, observe: mockObserve, set: vi.fn(), get: vi.fn() },
}));

// Spy on the real eventBus singleton instead of replacing the whole module --
// other modules transitively imported by shared/state.ts (e.g. signal.telemetry.ts)
// register their own eventBus.on(...) listeners at import time and would break
// if eventBus were swapped for a bare { emit } stub.
const { eventBus } = await import("../events-bus/event.bus.js");
const mockEmit = vi.spyOn(eventBus, "emit");

const { BrokerState } = await import("../shared/state.js");

const ADMIN_EMAIL = "admin@igfxpro.local";
const ADMIN_PASS  = "OlosAdmin!2026";
const TRADER_ID   = "usr_trader_demo";

function makeMockPrisma(initialBalance: number) {
  let balance = new Decimal(initialBalance);
  const walletAccount = {
    findUnique: vi.fn(async () => ({ balance })),
    update: vi.fn(async ({ data }: { data: { balance?: Decimal } }) => {
      if (data.balance) balance = data.balance;
      return { balance };
    }),
    upsert: vi.fn(async () => ({ balance })),
  };
  const ledgerEntry = {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "ledger-1", ...args.data })),
  };
  const auditLog = { create: vi.fn(async () => ({})) };
  const session = { upsert: vi.fn(async () => ({})) }; // login()'s own fire-and-forget persistSession
  const prismaLike: Record<string, unknown> = { walletAccount, ledgerEntry, auditLog, session };
  prismaLike.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaLike));
  return {
    prisma: prismaLike as unknown as PrismaClient,
    walletAccount, ledgerEntry, auditLog,
    getBalance: () => balance,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BrokerState.adminAllocateCapital — real DB mode", () => {
  it("credits the real WalletAccount atomically instead of overwriting it from the in-memory ledger", async () => {
    const mock  = makeMockPrisma(1_000);
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma: mock.prisma });
    const admin = state.login(ADMIN_EMAIL, ADMIN_PASS)!.principal;

    await state.adminAllocateCapital(admin, { userId: TRADER_ID, amount: 500, note: "wire transfer" });

    // Real balance actually incremented via WalletRepository (findUnique + update
    // inside $transaction), NOT overwritten from the in-memory-only ledger total.
    expect(mock.walletAccount.update).toHaveBeenCalledTimes(1);
    expect(mock.getBalance().toNumber()).toBe(1_500);
  });

  it("writes one real double-entry LedgerEntry with status COMPLETED (not the legacy APPROVED-forever status)", async () => {
    const mock  = makeMockPrisma(1_000);
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma: mock.prisma });
    const admin = state.login(ADMIN_EMAIL, ADMIN_PASS)!.principal;

    await state.adminAllocateCapital(admin, { userId: TRADER_ID, amount: 500, note: "wire transfer" });

    expect(mock.ledgerEntry.create).toHaveBeenCalledTimes(1);
    const entry = mock.ledgerEntry.create.mock.calls[0][0].data;
    expect(entry.type).toBe("ADMIN_CAPITAL_ALLOCATION");
    expect(entry.status).toBe("COMPLETED");
    expect(entry.debitAccount).toBe("BROKER_FLOAT");
    expect(entry.creditAccount).toBe(`CLIENT:${TRADER_ID}`);
  });

  it("emits a wallet.event (feeds Notification + the durable event archive) and increments deposit metrics", async () => {
    const mock  = makeMockPrisma(1_000);
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma: mock.prisma });
    const admin = state.login(ADMIN_EMAIL, ADMIN_PASS)!.principal;

    await state.adminAllocateCapital(admin, { userId: TRADER_ID, amount: 500, note: "wire transfer" });

    expect(mockEmit).toHaveBeenCalledWith("wallet.event", expect.objectContaining({
      userId: TRADER_ID, type: "CREDIT", amount: 500,
    }));
    expect(mockInc).toHaveBeenCalledWith("igfx_deposits_total");
    expect(mockObserve).toHaveBeenCalledWith("igfx_deposit_amount_usd", 500);
  });

  it("propagates WALLET_NOT_FOUND-class failures before touching in-memory/audit state", async () => {
    const mock  = makeMockPrisma(1_000);
    // Force the underlying credit to fail as if the wallet truly doesn't exist.
    mock.walletAccount.findUnique.mockResolvedValueOnce(null as unknown as { balance: Decimal });
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma: mock.prisma });
    const admin = state.login(ADMIN_EMAIL, ADMIN_PASS)!.principal;
    mock.auditLog.create.mockClear(); // drop the login's own auth.login audit row
    mockEmit.mockClear();

    await expect(
      state.adminAllocateCapital(admin, { userId: TRADER_ID, amount: 500, note: "wire transfer" }),
    ).rejects.toThrow(/WALLET_NOT_FOUND/);

    expect(mock.auditLog.create).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe("BrokerState.adminWithdrawCapital — real DB mode", () => {
  it("debits the real WalletAccount atomically", async () => {
    const mock  = makeMockPrisma(1_000);
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma: mock.prisma });
    const admin = state.login(ADMIN_EMAIL, ADMIN_PASS)!.principal;

    await state.adminWithdrawCapital(admin, { userId: TRADER_ID, amount: 300, note: "bank payout" });

    expect(mock.getBalance().toNumber()).toBe(700);
    const entry = mock.ledgerEntry.create.mock.calls[0][0].data;
    expect(entry.type).toBe("WITHDRAW_REQUEST");
    expect(entry.status).toBe("COMPLETED");
    expect(entry.debitAccount).toBe(`CLIENT:${TRADER_ID}`);
    expect(entry.creditAccount).toBe("BROKER_FLOAT");
    expect(mockEmit).toHaveBeenCalledWith("wallet.event", expect.objectContaining({
      userId: TRADER_ID, type: "DEBIT", amount: 300,
    }));
    expect(mockInc).toHaveBeenCalledWith("igfx_withdrawals_total");
  });

  it("rejects a withdrawal exceeding the real balance instead of silently overwriting it with an unchecked figure", async () => {
    const mock  = makeMockPrisma(100); // real balance is only 100
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma: mock.prisma });
    const admin = state.login(ADMIN_EMAIL, ADMIN_PASS)!.principal;
    mock.auditLog.create.mockClear(); // drop the login's own auth.login audit row
    mockEmit.mockClear();
    mockInc.mockClear();

    await expect(
      state.adminWithdrawCapital(admin, { userId: TRADER_ID, amount: 500, note: "bank payout" }),
    ).rejects.toThrow(/INSUFFICIENT_FUNDS/);

    // Balance must be untouched -- the old blind-overwrite path had no such guard at all.
    expect(mock.getBalance().toNumber()).toBe(100);
    expect(mock.ledgerEntry.create).not.toHaveBeenCalled();
    expect(mock.auditLog.create).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockInc).not.toHaveBeenCalled();
  });
});

describe("BrokerState.adminAllocateCapital / adminWithdrawCapital — sandbox mode (no prisma)", () => {
  it("still works via the in-memory ledger only, and never touches the DB-mode side effects", async () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false }); // no prisma
    const admin = state.login(ADMIN_EMAIL, ADMIN_PASS)!.principal;

    const next = await state.adminAllocateCapital(admin, { userId: TRADER_ID, amount: 1_000, note: "sandbox" });

    expect(next.capital.allocated).toBeGreaterThan(0);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockInc).not.toHaveBeenCalled();
  });
});
