/**
 * virus.scan.webhook.spec.ts
 *
 * Milestone 1 / Fix #5 — the virus-scan callback (POST /documents/scan-result)
 * used to have no authentication of any kind despite a code comment claiming
 * an HMAC check existed. Proves verifyWebhookSignature() fails closed in
 * every case except a genuinely correctly-signed body: no secret configured,
 * no signature header, wrong secret, tampered body, and the happy path.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../document-storage/virus-scan.hook.js";

function sign(body: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const SECRET = "test-webhook-secret";
const BODY = Buffer.from(JSON.stringify({ documentId: "doc-1", status: "CLEAN", scannedAt: new Date().toISOString() }));

describe("verifyWebhookSignature", () => {
  it("accepts a correctly-signed body", () => {
    const sig = sign(BODY, SECRET);
    expect(verifyWebhookSignature(BODY, sig, SECRET)).toBe(true);
  });

  it("rejects when no secret is configured (fail-closed, not open)", () => {
    const sig = sign(BODY, SECRET);
    expect(verifyWebhookSignature(BODY, sig, undefined)).toBe(false);
  });

  it("rejects when no signature header is sent", () => {
    expect(verifyWebhookSignature(BODY, undefined, SECRET)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const sig = sign(BODY, "a-different-secret");
    expect(verifyWebhookSignature(BODY, sig, SECRET)).toBe(false);
  });

  it("rejects when the body has been tampered with after signing", () => {
    const sig = sign(BODY, SECRET);
    const tampered = Buffer.from(JSON.stringify({ documentId: "doc-1", status: "INFECTED", scannedAt: new Date().toISOString() }));
    expect(verifyWebhookSignature(tampered, sig, SECRET)).toBe(false);
  });

  it("rejects a garbage (non-hex) signature without throwing", () => {
    expect(() => verifyWebhookSignature(BODY, "not-valid-hex!!", SECRET)).not.toThrow();
    expect(verifyWebhookSignature(BODY, "not-valid-hex!!", SECRET)).toBe(false);
  });
});
