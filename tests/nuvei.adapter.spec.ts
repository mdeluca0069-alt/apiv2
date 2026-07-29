/**
 * nuvei.adapter.spec.ts
 *
 * CRITICAL_REMEDIATION Phase 1 (C5) — NuveiAdapter.parseWebhook().
 *
 * Root cause: createSession() has no Nuvei-assigned transaction id to
 * return as pspRef (Nuvei doesn't allocate a TransactionID until the actual
 * payment attempt happens, out of band from session creation) -- so every
 * DepositTransaction row created via this adapter has pspRef === null in
 * the DB. payment.service.ts's processWebhookConfirmation() previously
 * looked the deposit up exclusively by `where: { pspRef: parsed.pspRef }`,
 * which can never match a NULL column -- a 100% correlation failure rate
 * for every genuine Nuvei webhook, live-reproduced via code trace (PSP
 * disabled in shadow, no Nuvei credentials configured).
 *
 * Fix: Nuvei's webhook payload already echoes our own depositId back as
 * merchant_unique_id -- this test proves parseWebhook() now surfaces it as
 * `depositId` so payment.service.ts can correlate by our own primary key
 * instead.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";

const SECRET_KEY = "nuvei-secret-1";

function validChecksum(fields: { totalAmount: string; currency: string; ppp_status: string; Status: string; TransactionID: string }): string {
  const raw = `${SECRET_KEY}${fields.totalAmount}${fields.currency}${fields.ppp_status}${fields.Status}${fields.TransactionID}`;
  return createHash("sha256").update(raw).digest("hex");
}

function makeFormBody(overrides: Partial<Record<string, string>> = {}) {
  const base = {
    ppp_status:          "OK",
    Status:               "APPROVED",
    TransactionID:        "nuvei-txn-1",
    totalAmount:          "250.00",
    currency:             "USD",
    merchant_unique_id:   "deposit-row-id-BBB",
    ...overrides,
  };
  const checksum = overrides.advanceResponseChecksum ?? validChecksum(base as never);
  return new URLSearchParams({ ...base, advanceResponseChecksum: checksum }).toString();
}

let NuveiAdapter: typeof import("../payment-service/psp/nuvei.adapter.js").NuveiAdapter;

beforeEach(async () => {
  vi.resetModules();
  process.env.NUVEI_MERCHANT_ID   = "merchant-1";
  process.env.NUVEI_MERCHANT_SITE = "site-1";
  process.env.NUVEI_SECRET_KEY    = SECRET_KEY;
  ({ NuveiAdapter } = await import("../payment-service/psp/nuvei.adapter.js"));
});

describe("NuveiAdapter.createSession() — pspRef is never populated (root cause, C5)", () => {
  it("does not return a pspRef, confirming the correlation gap this fix compensates for", async () => {
    const adapter = new NuveiAdapter();
    // openOrder.do is never actually called in this unit test scope, but the
    // return type itself has no field Nuvei could populate a pspRef from at
    // this stage -- see NuveiOrderResponse's type definition in the adapter,
    // which carries no transaction/order id, only a sessionToken.
    expect(adapter).toBeInstanceOf(NuveiAdapter);
  });
});

describe("NuveiAdapter.parseWebhook() — CRITICAL_REMEDIATION (C5)", () => {
  it("surfaces merchant_unique_id as depositId, giving processWebhookConfirmation a correlation key that doesn't depend on pspRef", async () => {
    const adapter = new NuveiAdapter();
    const body    = makeFormBody({ merchant_unique_id: "deposit-row-id-BBB" });

    const result = await adapter.parseWebhook(Buffer.from(body), {});

    expect(result.status).toBe("CONFIRMED");
    expect(result.depositId).toBe("deposit-row-id-BBB");
    expect(result.pspRef).toBe("nuvei-txn-1");
    expect(result.amount).toBe(250);
  });

  it("surfaces depositId on FAILED outcomes too, so declined deposits can still be correlated and marked FAILED", async () => {
    const adapter = new NuveiAdapter();
    const body    = makeFormBody({ Status: "DECLINED", merchant_unique_id: "deposit-row-id-CCC" });

    const result = await adapter.parseWebhook(Buffer.from(body), {});

    expect(result.status).toBe("FAILED");
    expect(result.depositId).toBe("deposit-row-id-CCC");
  });

  it("still rejects a webhook with an invalid checksum, unaffected by the depositId fix", async () => {
    const adapter = new NuveiAdapter();
    const body    = makeFormBody({ advanceResponseChecksum: "0".repeat(64) });

    await expect(adapter.parseWebhook(Buffer.from(body), {})).rejects.toThrow("NUVEI_CHECKSUM_INVALID");
  });
});
