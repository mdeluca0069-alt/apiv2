/**
 * login.mfa.challenge.ts — short-lived, single-use challenge token binding
 * an in-progress login (password already verified) to the TOTP step that
 * must complete it.
 *
 * Milestone 1 / Fix #3. Mirrors the Redis-backed, single-use pattern already
 * used for step-up MFA (security/mfa.enforcer.ts), so this degrades the same
 * way in sandbox/no-Redis environments and works correctly across a
 * multi-worker deployment (the challenge issued by whichever worker handled
 * the password step can be consumed by whichever worker handles the TOTP
 * step).
 */

import { randomBytes } from "node:crypto";
import { getRedis } from "../shared/redis.js";

const CHALLENGE_TTL_SECONDS = Number(process.env.MFA_LOGIN_CHALLENGE_TTL_SECONDS ?? 300);

function redisKey(token: string): string {
  return `mfa:login-challenge:${token}`;
}

// Fallback store for sandbox/no-Redis environments only.
const memChallenges = new Map<string, { userId: string; expiresAt: number }>();

export function loginMfaChallengeTtlSeconds(): number {
  return CHALLENGE_TTL_SECONDS;
}

/** Issues a new single-use challenge token for a user who passed the password step. */
export async function issueLoginMfaChallenge(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const redis = getRedis();
  if (redis) {
    await redis.setex(redisKey(token), CHALLENGE_TTL_SECONDS, userId);
  } else {
    memChallenges.set(token, { userId, expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000 });
  }
  return token;
}

/**
 * Consumes a challenge token, returning the userId it was issued for, or
 * null if the token is missing/expired/already used. Always single-use,
 * whether the lookup succeeds or not, so a leaked/guessed token can't be
 * replayed even against a wrong TOTP code.
 */
export async function consumeLoginMfaChallenge(token: string): Promise<string | null> {
  const redis = getRedis();
  if (redis) {
    const userId = await redis.get(redisKey(token));
    await redis.del(redisKey(token)).catch(() => undefined);
    return userId;
  }
  const entry = memChallenges.get(token);
  memChallenges.delete(token);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.userId;
}
