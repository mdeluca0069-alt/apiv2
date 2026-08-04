/**
 * sumsub.webhook.signature.failclosed.spec.ts
 *
 * CUTOVER REMEDIATION (Task 1) — SumsubProvider.verifyWebhookSignature()
 * used to return `true` ("skip verification") whenever SUMSUB_WEBHOOK_SECRET
 * was unset, treating an unconfigured production deployment the same as a
 * legitimate dev/test convenience. Unlike SUMSUB_APP_TOKEN/SUMSUB_SECRET_KEY
 * (the outbound API credentials, which correctly throw and hard-block the
 * whole integration if missing), SUMSUB_WEBHOOK_SECRET is independent --
 * an operator could have outbound KYC submission working perfectly while
 * this one variable was left unset, and every inbound webhook (including a
 * forged "GREEN"/approved decision) would have been silently accepted.
 *
 * This file tests the REAL sumsub.provider.ts implementation directly (not
 * mocked, unlike sumsub.webhook.replay.spec.ts which mocks it away to test
 * kyc.service.ts's separate replay-protection concern) -- every path that
 * must now fail closed, and confirms a genuinely correctly-configured,
 * correctly-signed webhook still succeeds exactly as before.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";

const ORIGINAL_SECRET = process.env.SUMSUB_WEBHOOK_SECRET;

describe("SumsubProvider.verifyWebhookSignature() — fail-closed (Task 1)", () => {
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.SUMSUB_WEBHOOK_SECRET;
    else process.env.SUMSUB_WEBHOOK_SECRET = ORIGINAL_SECRET;
  });

  it("REJECTS when SUMSUB_WEBHOOK_SECRET is not configured, even with a well-formed digest header present", async () => {
    delete process.env.SUMSUB_WEBHOOK_SECRET;
    const { sumsubProvider } = await import("../kyc-service/sumsub.provider.js");

    const body = JSON.stringify({ type: "applicantReviewed" });
    // An attacker-supplied digest of plausible shape/length -- must still be rejected.
    const forgedDigest = createHmac("sha256", "attacker-guessed-secret").update(body).digest("hex");

    expect(sumsubProvider.verifyWebhookSignature(body, forgedDigest)).toBe(false);
  });

  it("REJECTS when SUMSUB_WEBHOOK_SECRET is an empty string", async () => {
    process.env.SUMSUB_WEBHOOK_SECRET = "";
    const { sumsubProvider } = await import("../kyc-service/sumsub.provider.js");

    const body = JSON.stringify({ type: "applicantReviewed" });
    expect(sumsubProvider.verifyWebhookSignature(body, "anything")).toBe(false);
  });

  it("REJECTS when the digest header is missing/empty, even with a real secret configured", async () => {
    process.env.SUMSUB_WEBHOOK_SECRET = "real-webhook-secret";
    const { sumsubProvider } = await import("../kyc-service/sumsub.provider.js");

    expect(sumsubProvider.verifyWebhookSignature("{}", "")).toBe(false);
  });

  it("REJECTS an invalid/mismatched signature when correctly configured", async () => {
    process.env.SUMSUB_WEBHOOK_SECRET = "real-webhook-secret";
    const { sumsubProvider } = await import("../kyc-service/sumsub.provider.js");

    const body = JSON.stringify({ type: "applicantReviewed" });
    const wrongDigest = createHmac("sha256", "wrong-secret").update(body).digest("hex");

    expect(sumsubProvider.verifyWebhookSignature(body, wrongDigest)).toBe(false);
  });

  it("REJECTS a digest of the wrong length (can't even attempt a timing-safe compare)", async () => {
    process.env.SUMSUB_WEBHOOK_SECRET = "real-webhook-secret";
    const { sumsubProvider } = await import("../kyc-service/sumsub.provider.js");

    expect(sumsubProvider.verifyWebhookSignature("{}", "short")).toBe(false);
  });

  it("ACCEPTS a genuinely correctly-signed webhook when SUMSUB_WEBHOOK_SECRET is configured (regression: legitimate webhooks still work)", async () => {
    process.env.SUMSUB_WEBHOOK_SECRET = "real-webhook-secret";
    const { sumsubProvider } = await import("../kyc-service/sumsub.provider.js");

    const body = JSON.stringify({ applicantId: "applicant-1", type: "applicantReviewed" });
    const validDigest = createHmac("sha256", "real-webhook-secret").update(body).digest("hex");

    expect(sumsubProvider.verifyWebhookSignature(body, validDigest)).toBe(true);
  });
});
