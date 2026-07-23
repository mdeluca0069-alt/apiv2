/**
 * deposit.state.machine.notification.spec.ts
 *
 * FASE 5.2 (Ledger, Bug #10, LEDGER_FREEZE.md §0.10) — DepositStateMachine
 * .transitionToCredit() -- the live PSP webhook credit path -- wrote
 * Ledger+Wallet+Audit atomically but never fed Notification or Metrics: no
 * eventBus.emit("wallet.event", ...) at all, so the notification.router.ts
 * listener that would tell the client their deposit landed (and which
 * already works for every other subsystem) was simply never fed. The
 * registered igfx_deposits_total / igfx_deposit_amount_usd counters had
 * zero .inc()/.observe() calls anywhere in the repo.
 *
 * Fix: a successful (non-idempotent-replay) credit now emits wallet.event
 * and increments/observes those counters.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockMetricsInc, mockMetricsObserve } = vi.hoisted(() => ({
  mockMetricsInc: vi.fn(), mockMetricsObserve: vi.fn(),
}));
vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: mockMetricsInc, observe: mockMetricsObserve, set: vi.fn(), get: vi.fn() },
}));

const { eventBus } = await import("../events-bus/event.bus.js");
const emitSpy = vi.spyOn(eventBus, "emit");

const { DepositStateMachine } = await import("../payment-service/deposit.state.machine.js");

function makeDb(overrides: { status: string; balance: number; amount: number }) {
  const tx = {
    depositTransaction: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        userId: "user-1", status: overrides.status,
        amount: new Decimal(overrides.amount), currency: "USD", psp: "stripe",
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    walletAccount: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ balance: new Decimal(overrides.balance) }),
      update: vi.fn().mockResolvedValue({}),
    },
    ledgerEntry: { create: vi.fn().mockResolvedValue({}) },
    // findFirst backs immutableAudit.write()'s chain-head lookup;
    // $executeRaw backs its advisory-lock acquisition (pg_advisory_xact_lock
    // returns void, which $queryRaw cannot deserialize) -- deposit.state.
    // machine.ts now routes its AuditLog write through immutableAudit.
    // write(..., tx), passing this same mock transaction client.
    auditLog:    { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
    $executeRaw: vi.fn().mockResolvedValue(0),
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

describe("DepositStateMachine.transitionToCredit() — Bug #10 fix", () => {
  it("emits a wallet.event CREDIT and increments/observes deposit metrics on a genuine credit", async () => {
    const { db } = makeDb({ status: "CONFIRMED", balance: 1_000, amount: 500 });
    const machine = new DepositStateMachine(db as never);

    const result = await machine.transitionToCredit("dep-1", { pspRef: "pi_123", amount: 500, currency: "USD" });

    expect(result.alreadyCredited).toBe(false);
    expect(emitSpy).toHaveBeenCalledWith("wallet.event", expect.objectContaining({
      userId: "user-1", type: "CREDIT", amount: 500, reference: "PSP:pi_123",
    }));
    expect(mockMetricsInc).toHaveBeenCalledWith("igfx_deposits_total");
    expect(mockMetricsObserve).toHaveBeenCalledWith("igfx_deposit_amount_usd", 500);
  });

  it("emits/increments nothing when the deposit was already credited (idempotent webhook replay)", async () => {
    const { db } = makeDb({ status: "CREDITED", balance: 1_500, amount: 500 });
    const machine = new DepositStateMachine(db as never);

    const result = await machine.transitionToCredit("dep-1", { pspRef: "pi_123", amount: 500, currency: "USD" });

    expect(result.alreadyCredited).toBe(true);
    expect(emitSpy).not.toHaveBeenCalled();
    expect(mockMetricsInc).not.toHaveBeenCalled();
    expect(mockMetricsObserve).not.toHaveBeenCalled();
  });

  it("emits/increments nothing when the transition is invalid (throws before any write)", async () => {
    const { db } = makeDb({ status: "REQUESTED", balance: 1_000, amount: 500 });
    const machine = new DepositStateMachine(db as never);

    await expect(
      machine.transitionToCredit("dep-1", { pspRef: "pi_123", amount: 500, currency: "USD" }),
    ).rejects.toThrow("DEPOSIT_INVALID_TRANSITION");

    expect(emitSpy).not.toHaveBeenCalled();
    expect(mockMetricsInc).not.toHaveBeenCalled();
  });
});
