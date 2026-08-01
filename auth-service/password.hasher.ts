import { scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { hash, verify, argon2id } from "argon2";
import bcrypt from "bcryptjs";

// PHASE2_REMEDIATION (H10): see verifyScrypt()'s docstring below.
const scryptAsync = promisify(scrypt);

const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 65536,  // 64 MiB — OWASP recommended minimum
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
} as const;

// PRODUCTION CUTOVER Stage 1: legacy igfxpro-api (v1) hashes every password
// with bcryptjs (cost 10, `$2a$`/`$2b$`/`$2y$` prefix) -- a format this
// module never had a verify branch for, only a scrypt one. A straight
// `User` table migration from v1 would make every existing password
// unverifiable (bcrypt hashes don't parse as scrypt's `salt:hexHash`
// shape, so verifyScrypt() fails closed on them) -- this regex is what
// routes those rows to a real bcrypt verification instead. Temporary by
// design: once every migrated user has logged in at least once,
// needsUpgrade() will have rehashed all of them to Argon2id and this
// branch stops being exercised, but it's left in place (not removed on a
// timer) since there's no harm in a dead branch that never matches.
const BCRYPT_HASH_RE = /^\$2[aby]\$/;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  if (stored.startsWith("$argon2id$")) {
    try {
      return await verify(stored, plain);
    } catch {
      return false;
    }
  }
  if (BCRYPT_HASH_RE.test(stored)) {
    try {
      return await bcrypt.compare(plain, stored);
    } catch {
      return false;
    }
  }
  // Legacy scrypt path — format: salt:hexHash
  return await verifyScrypt(stored, plain);
}

// Returns true when the stored hash should be re-hashed with Argon2id.
// True for both the pre-existing scrypt legacy format and (Production
// Cutover Stage 1) migrated v1 bcrypt hashes -- either way the caller's
// existing lazy-upgrade-on-login logic (auth.service.ts) already handles
// re-hashing correctly with no changes needed there: it only depends on
// this function's boolean result, not on which legacy format triggered it.
export function needsUpgrade(stored: string): boolean {
  return !stored.startsWith("$argon2id$");
}

/**
 * PHASE2_REMEDIATION (H10): was scryptSync, which blocks the entire shared
 * Node.js event loop for the full KDF computation (~50-100ms at Node's
 * default N=16384 cost factor) -- this single-process app has no
 * worker-thread offload anywhere, so every hit of this legacy branch
 * stalled all concurrent request/WS handling for that duration. Reachable
 * on production DB-backed auth for any user whose stored hash is still the
 * pre-Argon2id `salt:hexHash` scrypt format (shrinking via needsUpgrade()'s
 * lazy rehash, but nonzero until each such user logs in once) -- including
 * via fix-gateway/fix.credentials.ts's FIX 4.4 Logon handler, a second hot
 * path that reaches this same function for institutional trading session
 * setup. Switched to the async `crypto.scrypt` (libuv threadpool), matching
 * the fix applied to shared/state.ts's sandbox-mode equivalent.
 */
async function verifyScrypt(stored: string, plain: string): Promise<boolean> {
  const colon = stored.indexOf(":");
  if (colon < 1) return false;
  const salt = stored.slice(0, colon);
  const hash = stored.slice(colon + 1);
  try {
    const derived = ((await scryptAsync(plain, salt, 64)) as Buffer).toString("hex");
    if (hash.length !== derived.length) return false;
    return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derived, "hex"));
  } catch {
    return false;
  }
}
