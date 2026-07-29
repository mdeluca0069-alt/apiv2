/**
 * deposit.state.machine.amount.mismatch.spec.ts
 *
 * CRITICAL_REMEDIATION Phase 1 (C4, second half) —
 * DepositStateMachine.transitionToCredit().
 *
 * Root cause: creditAmount was taken from the webhook payload
 * (`params.amount`) whenever it was present and positive, falling back to
 * dep.amount only if absent/zero. Since Praxis's webhook signature does not
 * bind the `amount` field (see praxis.adapter.ts's verifyPraxisSignature()
 * docstring for the full C4 writeup — its pin covers only merchant_id +
 * application_key + timestamp + secretKey), a webhook claiming a materially
 * larger amount than what the user actually requested would previously be
 * credited as-is: a forged or malformed webhook could inflate a real, small
 * deposit into an arbitrarily large credit.
 *
 * Fix: the credited amount is now always dep.amount — the value recorded
 * server-side at deposit-request time, before any PSP interaction, and
 * therefore never influenced by the webhook. A webhook amount that
 * disagrees with dep.amount by more than a cent is treated as a fraud/
 * integrity signal and rejected outright rather than trusted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn(), observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

const { DepositStateMachine } = await import("../payment-service/deposit.state.machine.js");

function makeDb(overrides: { status: string; balance: number; amount: number }) {
  const tx = {
    depositTransaction: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        userId: "user-1", status: overrides.status,
        amount: new Decimal(overrides.amount), currency: "USD", psp: "praxis",
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    walletAccount: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ balance: new Decimal(overrides.balance) }),
      update: vi.fn().mockResolvedValue({}),
    },
    ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
    auditLog:    { create: vi.fn().mockResolvedValue({}) },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw:   vi.fn().mockResolvedValue([]),
  };
  type Tx = typeof tx;
  const db = {
    $transaction: vi.fn(async (fn: (txArg: Tx) => Promise<unknown>) => fn(tx)),
  };
  return { db, tx };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DepositStateMachine.transitionToCredit() — CRITICAL_REMEDIATION (C4, second half)", () => {
  it("credits dep.amount (server-recorded), not the webhook-supplied amount, on a normal matching webhook", async () => {
    const { db, tx } = makeDb({ status: "CONFIRMED", balance: 1_000, amount: 100 });
    const machine = new DepositStateMachine(db as never);

    await machine.transitionToCredit("dep-1", { pspRef: "tid-1", amount: 100, currency: "USD" });

    const updateArg = tx.walletAccount.update.mock.calls[0][0] as { data: { balance: { toNumber(): number } } };
    expect(updateArg.data.balance.toNumber()).toBe(1_100); // 1000 + 100, not something else
  });

  it("rejects and credits nothing when the webhook amount is materially larger than dep.amount -- the exact forged-amount-inflation scenario", async () => {
    const { db, tx } = makeDb({ status: "CONFIRMED", balance: 1_000, amount: 10 }); // user requested $10
    const machine = new DepositStateMachine(db as never);

    await expect(
      machine.transitionToCredit("dep-1", { pspRef: "tid-1", amount: 1_000_000, currency: "USD" }), // forged webhook claims $1,000,000
    ).rejects.toThrow(/DEPOSIT_AMOUNT_MISMATCH/);

    expect(tx.walletAccount.update).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it("rejects when the webhook amount is materially smaller than dep.amount too (integrity signal, not just inflation)", async () => {
    const { db, tx } = makeDb({ status: "CONFIRMED", balance: 1_000, amount: 500 });
    const machine = new DepositStateMachine(db as never);

    await expect(
      machine.transitionToCredit("dep-1", { pspRef: "tid-1", amount: 1, currency: "USD" }),
    ).rejects.toThrow(/DEPOSIT_AMOUNT_MISMATCH/);

    expect(tx.walletAccount.update).not.toHaveBeenCalled();
  });

  it("still falls back to dep.amount when the webhook supplies no amount (amount: 0) -- pre-existing, legitimate PSP behavior preserved", async () => {
    const { db, tx } = makeDb({ status: "CONFIRMED", balance: 1_000, amount: 250 });
    const machine = new DepositStateMachine(db as never);

    await machine.transitionToCredit("dep-1", { pspRef: "tid-1", amount: 0, currency: "USD" });

    const updateArg = tx.walletAccount.update.mock.calls[0][0] as { data: { balance: { toNumber(): number } } };
    expect(updateArg.data.balance.toNumber()).toBe(1_250);
  });

  it("tolerates sub-cent floating-point rounding noise without false-rejecting", async () => {
    const { db, tx } = makeDb({ status: "CONFIRMED", balance: 0, amount: 99.99 });
    const machine = new DepositStateMachine(db as never);

    await machine.transitionToCredit("dep-1", { pspRef: "tid-1", amount: 99.995, currency: "USD" });

    expect(tx.walletAccount.update).toHaveBeenCalledTimes(1);
  });
});
