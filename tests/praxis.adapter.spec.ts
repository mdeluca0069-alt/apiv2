/**
 * praxis.adapter.spec.ts
 *
 * CRITICAL_REMEDIATION Phase 1 (C4/C5) — PraxisAdapter.parseWebhook().
 *
 * C4: verifyPraxisSignature() previously accepted a webhook's (timestamp,
 * pin) pair with no freshness check at all. Since Praxis's documented pin
 * formula (MD5(merchant_id + application_key + timestamp + secretKey)) does
 * not bind transaction_id/order_id/amount/status, a single captured valid
 * pair remained forgeable-with-arbitrary-payload forever. Fixed by rejecting
 * timestamps outside a 15-minute window.
 *
 * C5 (defense-in-depth): order_id (our own depositId) is now surfaced as
 * `depositId` on the parsed result, mirroring the Nuvei fix, so correlation
 * doesn't depend solely on tid/pspRef ever having been captured.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";

const MERCHANT_ID = "merchant-1";
const APP_KEY      = "app-key-1";
const SECRET_KEY   = "secret-1";

function validPin(timestamp: string): string {
  return createHash("md5").update(`${MERCHANT_ID}${APP_KEY}${timestamp}${SECRET_KEY}`).digest("hex");
}

function makePayload(overrides: Partial<Record<string, string>> = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const base = {
    merchant_id:        MERCHANT_ID,
    application_key:    APP_KEY,
    timestamp,
    transaction_id:     "txn-1",
    tid:                "tid-1",
    transaction_type:   "deposit",
    transaction_status: "approved",
    amount:             "10000", // cents -> $100.00
    currency:            "USD",
    order_id:            "deposit-row-id-AAA",
    ...overrides,
  };
  return { ...base, pin: overrides.pin ?? validPin(base.timestamp) };
}

let PraxisAdapter: typeof import("../payment-service/psp/praxis.adapter.js").PraxisAdapter;

beforeEach(async () => {
  vi.resetModules();
  process.env.PRAXIS_MERCHANT_ID = MERCHANT_ID;
  process.env.PRAXIS_APP_KEY     = APP_KEY;
  process.env.PRAXIS_SECRET_KEY  = SECRET_KEY;
  ({ PraxisAdapter } = await import("../payment-service/psp/praxis.adapter.js"));
});

describe("PraxisAdapter.parseWebhook() — signature + replay window (C4)", () => {
  it("accepts a webhook with a valid, fresh signature", async () => {
    const adapter = new PraxisAdapter();
    const payload = makePayload();

    const result = await adapter.parseWebhook(Buffer.from(JSON.stringify(payload)), {});

    expect(result.status).toBe("CONFIRMED");
    expect(result.amount).toBe(100);
  });

  it("rejects a webhook whose pin does not match the expected MD5 signature", async () => {
    const adapter = new PraxisAdapter();
    const payload = makePayload({ pin: "0".repeat(32) });

    await expect(adapter.parseWebhook(Buffer.from(JSON.stringify(payload)), {}))
      .rejects.toThrow(/PRAXIS_TIMESTAMP_OUT_OF_WINDOW|PRAXIS_SIGNATURE_INVALID/);
  });

  it("CRITICAL_REMEDIATION (C4): rejects a stale timestamp+pin pair replayed outside the freshness window, even though the signature itself is mathematically valid for that timestamp", async () => {
    const adapter        = new PraxisAdapter();
    const staleTimestamp = (Math.floor(Date.now() / 1000) - 3600).toString(); // 1h old
    const payload         = makePayload({ timestamp: staleTimestamp, pin: validPin(staleTimestamp) });

    await expect(adapter.parseWebhook(Buffer.from(JSON.stringify(payload)), {}))
      .rejects.toThrow("PRAXIS_TIMESTAMP_OUT_OF_WINDOW");
  });

  it("accepts a timestamp just inside the 15-minute window", async () => {
    const adapter    = new PraxisAdapter();
    const timestamp  = (Math.floor(Date.now() / 1000) - 14 * 60).toString();
    const payload    = makePayload({ timestamp, pin: validPin(timestamp) });

    const result = await adapter.parseWebhook(Buffer.from(JSON.stringify(payload)), {});
    expect(result.status).toBe("CONFIRMED");
  });

  it("CRITICAL_REMEDIATION (C5, defense-in-depth): surfaces order_id as depositId so correlation doesn't depend solely on tid", async () => {
    const adapter = new PraxisAdapter();
    const payload  = makePayload({ order_id: "deposit-row-id-AAA" });

    const result = await adapter.parseWebhook(Buffer.from(JSON.stringify(payload)), {});

    expect(result.depositId).toBe("deposit-row-id-AAA");
    expect(result.pspRef).toBe("tid-1");
  });
});
