/**
 * payment.service.webhook.correlation.spec.ts
 *
 * CRITICAL_REMEDIATION Phase 1 (C5) — PaymentService.processWebhookConfirmation().
 *
 * Root cause (full writeup in tests/nuvei.adapter.spec.ts): the deposit
 * lookup was `where: { pspRef: parsed.pspRef }` only. For Nuvei, pspRef is
 * never populated on the DepositTransaction row at session-creation time,
 * so this lookup always missed -- a 100% correlation failure for every
 * genuine Nuvei webhook. Fix: correlate by parsed.depositId (the PSP's
 * echo of our own DepositTransaction id) first, falling back to pspRef.
 *
 * These tests exercise PaymentService directly with a mocked PSP adapter
 * and a mocked Prisma client, so they don't depend on real Praxis/Nuvei
 * credentials or network access.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockParseWebhook } = vi.hoisted(() => ({ mockParseWebhook: vi.fn() }));
vi.mock("../payment-service/psp/psp.adapter.js", () => ({
  getPsp: () => ({ name: "NUVEI", parseWebhook: mockParseWebhook, createSession: vi.fn() }),
  listPsps: () => ["NUVEI"],
}));

const { PaymentService } = await import("../payment-service/payment.service.js");

function makeDb(overrides: { depositRow: unknown }) {
  return {
    depositTransaction: {
      findFirst: vi.fn().mockResolvedValue(overrides.depositRow),
      update:    vi.fn().mockResolvedValue({}),
    },
    // Unused by processWebhookConfirmation directly, but constructed by
    // DepositStateMachine/WalletRepository in the PaymentService constructor.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PaymentService.processWebhookConfirmation() — correlation (C5)", () => {
  it("looks the deposit up by depositId (id) when the PSP payload supplies one, not by pspRef", async () => {
    mockParseWebhook.mockResolvedValue({
      pspRef: "nuvei-txn-1", depositId: "deposit-row-id-BBB", status: "FAILED", failReason: "declined",
    });
    const db = makeDb({ depositRow: { id: "deposit-row-id-BBB", userId: "user-1", status: "PENDING", currency: "USD" } });
    const service = new PaymentService(db as never);

    await service.processWebhookConfirmation("NUVEI", Buffer.from("{}"), {});

    expect(db.depositTransaction.findFirst).toHaveBeenCalledWith({ where: { id: "deposit-row-id-BBB" } });
  });

  it("falls back to pspRef lookup when the PSP payload has no depositId (pre-existing Praxis/Stripe path, unaffected)", async () => {
    mockParseWebhook.mockResolvedValue({ pspRef: "tid-1", status: "FAILED", failReason: "declined" });
    const db = makeDb({ depositRow: { id: "deposit-row-id-AAA", userId: "user-1", status: "PENDING", currency: "USD" } });
    const service = new PaymentService(db as never);

    await service.processWebhookConfirmation("NUVEI", Buffer.from("{}"), {});

    expect(db.depositTransaction.findFirst).toHaveBeenCalledWith({ where: { pspRef: "tid-1" } });
  });

  it("CRITICAL_REMEDIATION (C5): throws WEBHOOK_NO_DEPOSIT_FOR_PSPREF, not a silent no-op, when neither correlation path finds a row", async () => {
    mockParseWebhook.mockResolvedValue({ pspRef: "nuvei-txn-1", depositId: "no-such-row", status: "FAILED" });
    const db = makeDb({ depositRow: null });
    const service = new PaymentService(db as never);

    await expect(service.processWebhookConfirmation("NUVEI", Buffer.from("{}"), {}))
      .rejects.toThrow("WEBHOOK_NO_DEPOSIT_FOR_PSPREF:no-such-row");
  });
});
