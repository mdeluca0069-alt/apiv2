import { scryptSync, timingSafeEqual } from "node:crypto";
import { hash, verify, argon2id } from "argon2";

const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 65536,  // 64 MiB — OWASP recommended minimum
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
} as const;

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
  // Legacy scrypt path — format: salt:hexHash
  return verifyScrypt(stored, plain);
}

// Returns true when the stored hash should be re-hashed with Argon2id.
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
