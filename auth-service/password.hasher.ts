import { scryptSync, timingSafeEqual } from "node:crypto";
import { hash, verify, argon2id } from "argon2";
import bcrypt from "bcryptjs";

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
  return verifyScrypt(stored, plain);
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

function verifyScrypt(stored: string, plain: string): boolean {
  const colon = stored.indexOf(":");
  if (colon < 1) return false;
  const salt = stored.slice(0, colon);
  const hash = stored.slice(colon + 1);
  try {
    const derived = scryptSync(plain, salt, 64).toString("hex");
    if (hash.length !== derived.length) return false;
    return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derived, "hex"));
  } catch {
    return false;
  }
}
