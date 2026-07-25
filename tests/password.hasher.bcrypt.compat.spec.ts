/**
 * password.hasher.bcrypt.compat.spec.ts
 *
 * PRODUCTION CUTOVER Stage 1 — legacy igfxpro-api (v1) hashes passwords with
 * bcryptjs (`$2a$`/`$2b$`/`$2y$`), a format this module previously had no
 * verify branch for; the only non-Argon2id path was a scrypt one that
 * bcrypt hashes fail against by construction (they don't parse as scrypt's
 * `salt:hexHash` shape). A straight `User` table migration from v1 would
 * have made every existing password unverifiable. This proves the new
 * bcrypt branch verifies real bcrypt hashes correctly, the pre-existing
 * Argon2id and scrypt paths are unchanged, and needsUpgrade() correctly
 * flags every non-Argon2id format for lazy rehashing.
 *
 * Runs against the REAL module (no mocks) since these are pure hashing
 * functions — the only meaningful proof is exercising the real crypto.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import { scryptSync } from "node:crypto";
import { hashPassword, verifyPassword, needsUpgrade } from "../auth-service/password.hasher.js";

describe("password.hasher.ts — bcrypt compatibility (v1 migration)", () => {
  it("verifies a real bcrypt hash (v1's format) with the correct password", async () => {
    const bcryptHash = await bcrypt.hash("Correct-Horse-1", 10);
    expect(bcryptHash).toMatch(/^\$2[aby]\$/);

    await expect(verifyPassword(bcryptHash, "Correct-Horse-1")).resolves.toBe(true);
  });

  it("rejects a bcrypt hash with the wrong password", async () => {
    const bcryptHash = await bcrypt.hash("Correct-Horse-1", 10);

    await expect(verifyPassword(bcryptHash, "wrong-password")).resolves.toBe(false);
  });

  it("recognizes all three real bcrypt prefix variants ($2a$/$2b$/$2y$)", async () => {
    for (const prefix of ["$2a$", "$2b$", "$2y$"] as const) {
      const real = await bcrypt.hash("SamePassword1", 10);
      const relabeled = prefix + real.slice(4); // swap only the prefix, hash body still valid for bcrypt's own compare
      await expect(verifyPassword(relabeled, "SamePassword1")).resolves.toBe(true);
    }
  });

  it("never throws on a malformed/truncated bcrypt-looking string — fails closed", async () => {
    await expect(verifyPassword("$2b$10$not-a-real-hash", "anything")).resolves.toBe(false);
  });

  it("flags a bcrypt hash as needing upgrade to Argon2id", () => {
    expect(needsUpgrade("$2b$10$abcdefghijklmnopqrstuv")).toBe(true);
  });
});

describe("password.hasher.ts — pre-existing Argon2id path is unchanged", () => {
  it("hashPassword() produces a verifiable Argon2id hash", async () => {
    const hashed = await hashPassword("MyRealPassword9");
    expect(hashed).toMatch(/^\$argon2id\$/);

    await expect(verifyPassword(hashed, "MyRealPassword9")).resolves.toBe(true);
    await expect(verifyPassword(hashed, "WrongPassword")).resolves.toBe(false);
  });

  it("does not flag a real Argon2id hash as needing upgrade", async () => {
    const hashed = await hashPassword("AnyPassword1");
    expect(needsUpgrade(hashed)).toBe(false);
  });
});

describe("password.hasher.ts — pre-existing legacy scrypt path is unchanged", () => {
  function scryptHashOf(plain: string): string {
    const salt = "fixed-test-salt";
    const derived = scryptSync(plain, salt, 64).toString("hex");
    return `${salt}:${derived}`;
  }

  it("verifies a legacy scrypt hash with the correct password", async () => {
    const stored = scryptHashOf("LegacyPassword1");
    await expect(verifyPassword(stored, "LegacyPassword1")).resolves.toBe(true);
  });

  it("rejects a legacy scrypt hash with the wrong password", async () => {
    const stored = scryptHashOf("LegacyPassword1");
    await expect(verifyPassword(stored, "wrong")).resolves.toBe(false);
  });

  it("flags a scrypt hash as needing upgrade", () => {
    expect(needsUpgrade(scryptHashOf("x"))).toBe(true);
  });

  it("never throws and fails closed on a malformed scrypt-shaped string (no colon)", async () => {
    await expect(verifyPassword("not-a-valid-format-at-all", "anything")).resolves.toBe(false);
  });
});
