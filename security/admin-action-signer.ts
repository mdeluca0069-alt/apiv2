/**
 * security/admin-action-signer.ts — Challenge-response HMAC signing for
 * high-privilege admin actions.
 *
 * Flow:
 *   1. Admin calls issueChallenge(adminId, action) → receives { challenge, nonce }
 *   2. Admin signs: signature = HMAC-SHA256(ADMIN_SIGNING_SECRET, challenge)
 *   3. Admin calls verifySignedAction(challenge, signature, adminId)
 *      → Redis GETDEL (atomic one-time nonce) + timing-safe compare
 *
 * All signed actions are defined in SIGNED_ACTIONS — any action not in this
 * set is rejected immediately without touching Redis.
 */

import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { getRedis } from "../shared/redis.js";

export const SIGNED_ACTIONS = new Set([
  "capital.allocate",
  "kill-switch",
  "kyc.approve",
  "kyc.reject",
  "tier.update",
  "risk-policy.update",
  "olos.weights.update",
]);

const NONCE_TTL_S = 5 * 60; // 5 minutes

function getSigningSecret(): string {
  const secret = process.env.ADMIN_SIGNING_SECRET ?? process.env.JWT_SECRET ?? "";
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("[admin-action-signer] ADMIN_SIGNING_SECRET is missing or too short");
    }
  }
  return secret || "admin-signer-dev-key-insecure";
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64")
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export interface AdminChallenge {
  challenge:  string;
  nonce:      string;
  action:     string;
  expiresAt:  number;
}

interface StoredNonce {
  adminId:   string;
  action:    string;
  challenge: string;
  issuedAt:  number;
}

export async function issueChallenge(adminId: string, action: string): Promise<AdminChallenge> {
  if (!SIGNED_ACTIONS.has(action)) {
    throw Object.assign(new Error(`[admin-action-signer] unknown action: ${action}`), { statusCode: 400 });
  }

  const nonce     = base64Url(randomBytes(32));
  const expiresAt = Date.now() + NONCE_TTL_S * 1_000;
  const challenge = base64Url(Buffer.from(JSON.stringify({ nonce, action, adminId, expiresAt })));

  const stored: StoredNonce = { adminId, action, challenge, issuedAt: Date.now() };

  const redis = getRedis();
  if (redis) {
    await redis.setex(`admin:nonce:${nonce}`, NONCE_TTL_S, JSON.stringify(stored));
  }

  return { challenge, nonce, action, expiresAt };
}

export async function verifySignedAction(
  challenge:  string,
  signature:  string,
  adminId:    string,
): Promise<{ ok: boolean; action: string | null; reason?: string }> {
  // Decode challenge to extract nonce
  let decoded: { nonce?: string; action?: string; adminId?: string };
  try {
    decoded = JSON.parse(Buffer.from(challenge.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8")) as { nonce?: string; action?: string; adminId?: string };
  } catch {
    return { ok: false, action: null, reason: "invalid-challenge" };
  }

  const { nonce, action } = decoded;
  if (!nonce || !action) return { ok: false, action: null, reason: "missing-fields" };
  if (!SIGNED_ACTIONS.has(action)) return { ok: false, action, reason: "unknown-action" };

  // Atomic one-time nonce consumption
  const redis = getRedis();
  let stored: StoredNonce | null = null;
  if (redis) {
    const raw = await redis.getdel(`admin:nonce:${nonce}`).catch(() => null);
    if (!raw) return { ok: false, action, reason: "nonce-expired-or-used" };
    stored = JSON.parse(raw) as StoredNonce;
  }

  // Validate nonce ownership
  if (stored && stored.adminId !== adminId) {
    return { ok: false, action, reason: "admin-mismatch" };
  }
  if (stored && stored.challenge !== challenge) {
    return { ok: false, action, reason: "challenge-mismatch" };
  }

  // Verify HMAC signature
  const secret   = getSigningSecret();
  const expected = createHmac("sha256", secret).update(challenge).digest("hex");
  const sigBuf   = Buffer.from(signature.toLowerCase(), "hex");
  const expBuf   = Buffer.from(expected, "hex");

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, action, reason: "invalid-signature" };
  }

  return { ok: true, action };
}

export function generateAdminSignature(challenge: string): string {
  const secret = getSigningSecret();
  return createHmac("sha256", secret).update(challenge).digest("hex");
}
