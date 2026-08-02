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
    try {
      await redis.setex(redisKey(token), CHALLENGE_TTL_SECONDS, userId);
      return token;
    } catch (err) {
      // PHASE E (failure-injection audit): getRedis() only reflects whether
      // Redis is CONFIGURED, not whether it's currently reachable -- a live
      // outage on an otherwise-configured Redis threw here uncaught,
      // blocking login entirely for every MFA-enrolled user platform-wide
      // (password already verified, but no challenge token could be issued
      // to proceed to the TOTP step), even though the in-memory fallback
      // below already exists and works fine for the "never configured"
      // case. Falls back to it here too. This loses the fallback's one
      // known limitation -- cross-worker consumption -- for the duration
      // of the outage (a token issued on this worker can only be consumed
      // on this same worker), which is an acceptable, self-healing
      // degradation compared to blocking login platform-wide.
      console.error("[login-mfa-challenge] Redis setex failed, falling back to in-memory store:", (err as Error).message);
    }
  }
  memChallenges.set(token, { userId, expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000 });
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
    try {
      const userId = await redis.get(redisKey(token));
      await redis.del(redisKey(token)).catch(() => undefined);
      return userId;
    } catch (err) {
      // See issueLoginMfaChallenge's docstring -- same live-outage fallback.
      // If the challenge was originally issued while Redis was still up, it
      // won't be found in the in-memory store either; the client simply
      // sees an invalid/expired challenge and must restart the login flow,
      // which will then consistently use the in-memory path on both ends
      // for as long as the outage lasts.
      console.error("[login-mfa-challenge] Redis get failed, falling back to in-memory store:", (err as Error).message);
    }
  }
  const entry = memChallenges.get(token);
  memChallenges.delete(token);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.userId;
}
