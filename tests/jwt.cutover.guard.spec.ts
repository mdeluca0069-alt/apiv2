/**
 * jwt.cutover.guard.spec.ts
 *
 * CUTOVER REMEDIATION (Task 2) — checkJwtCutoverConfig() is the actual
 * enforcement mechanism behind JWT_CUTOVER_MODE: an explicit, opt-in
 * startup guard that fails the process outright if the current JWT
 * configuration would break legacy v1 HS256 token compatibility.
 * tests/jwt.v1.compat.spec.ts already proved the underlying danger is
 * real (a v1 token instantly stops verifying once RSA key material is
 * present); this file proves the NEW prevention mechanism -- main.ts's
 * startup-validation IIFE calling this function and exiting on failure --
 * behaves correctly for every input combination, without needing to
 * actually spawn a process (main.ts itself can't be imported directly, the
 * same constraint noted throughout this program's test suite).
 */
import { describe, it, expect } from "vitest";
import { checkJwtCutoverConfig, fingerprintJwtSecret, type JwtCutoverCheckEnv } from "../security/jwt.cutover.guard.js";

const VALID_SECRET = "a-shared-production-jwt-secret-at-least-32-bytes-long";

describe("checkJwtCutoverConfig() — JWT_CUTOVER_MODE not set: no restriction at all", () => {
  it("is a no-op (ok, cutoverModeActive:false) when JWT_CUTOVER_MODE is unset, even with RSA keys present", () => {
    const env: JwtCutoverCheckEnv = {
      JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      JWT_PUBLIC_KEY:  "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
    };
    const result = checkJwtCutoverConfig(env);
    expect(result).toEqual({ ok: true, cutoverModeActive: false });
  });

  it("is a no-op when JWT_CUTOVER_MODE is any value other than the exact string \"true\"", () => {
    const env: JwtCutoverCheckEnv = { JWT_CUTOVER_MODE: "1", JWT_SECRET: VALID_SECRET };
    expect(checkJwtCutoverConfig(env)).toEqual({ ok: true, cutoverModeActive: false });
  });
});

describe("checkJwtCutoverConfig() — JWT_CUTOVER_MODE=true: enforces HS256-only", () => {
  it("REJECTS when both JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are set (would force RS256)", () => {
    const env: JwtCutoverCheckEnv = {
      JWT_CUTOVER_MODE: "true",
      JWT_SECRET:       VALID_SECRET,
      JWT_PRIVATE_KEY:  "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      JWT_PUBLIC_KEY:   "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
    };
    const result = checkJwtCutoverConfig(env);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("RS256");
  });

  it("REJECTS when only JWT_PRIVATE_KEY is set but not JWT_PUBLIC_KEY (matches jwt-key-manager.ts's own useRSA check -- both must be present to trigger RSA mode, so this alone must NOT be treated as the RSA violation)", () => {
    const env: JwtCutoverCheckEnv = {
      JWT_CUTOVER_MODE: "true",
      JWT_SECRET:       VALID_SECRET,
      JWT_PRIVATE_KEY:  "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
    };
    // Only one of the pair is set -> jwt-key-manager.ts's useRSA stays
    // false -> this must pass (not a false-positive RSA rejection).
    expect(checkJwtCutoverConfig(env)).toEqual({ ok: true, cutoverModeActive: true });
  });

  it("REJECTS when JWT_SECRET is missing", () => {
    const env: JwtCutoverCheckEnv = { JWT_CUTOVER_MODE: "true" };
    const result = checkJwtCutoverConfig(env);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("JWT_SECRET");
  });

  it("REJECTS when JWT_SECRET is shorter than 32 chars", () => {
    const env: JwtCutoverCheckEnv = { JWT_CUTOVER_MODE: "true", JWT_SECRET: "too-short" };
    const result = checkJwtCutoverConfig(env);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("JWT_SECRET");
  });

  it("ACCEPTS a valid HS256-only configuration (no RSA keys, real-length secret, no fingerprint check requested)", () => {
    const env: JwtCutoverCheckEnv = { JWT_CUTOVER_MODE: "true", JWT_SECRET: VALID_SECRET };
    expect(checkJwtCutoverConfig(env)).toEqual({ ok: true, cutoverModeActive: true });
  });

  it("REJECTS when JWT_SECRET_V1_FINGERPRINT is provided but does not match the configured JWT_SECRET's real hash", () => {
    const env: JwtCutoverCheckEnv = {
      JWT_CUTOVER_MODE: "true",
      JWT_SECRET: VALID_SECRET,
      JWT_SECRET_V1_FINGERPRINT: "0000000000000000000000000000000000000000000000000000000000000000",
    };
    const result = checkJwtCutoverConfig(env);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("does not hash to the expected fingerprint");
    // Neither the real secret nor the wrong fingerprint should leak into the error text.
    expect((result as { error: string }).error).not.toContain(VALID_SECRET);
  });

  it("ACCEPTS when JWT_SECRET_V1_FINGERPRINT genuinely matches the configured JWT_SECRET's hash -- proves the fingerprint mechanism works both ways, not just fail-closed", () => {
    const realFingerprint = fingerprintJwtSecret(VALID_SECRET);
    const env: JwtCutoverCheckEnv = {
      JWT_CUTOVER_MODE: "true",
      JWT_SECRET: VALID_SECRET,
      JWT_SECRET_V1_FINGERPRINT: realFingerprint,
    };
    expect(checkJwtCutoverConfig(env)).toEqual({ ok: true, cutoverModeActive: true });
  });
});

describe("fingerprintJwtSecret()", () => {
  it("is deterministic (same input -> same fingerprint)", () => {
    expect(fingerprintJwtSecret(VALID_SECRET)).toBe(fingerprintJwtSecret(VALID_SECRET));
  });

  it("produces a 64-hex-char SHA-256 digest", () => {
    const fp = fingerprintJwtSecret(VALID_SECRET);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different secrets produce different fingerprints", () => {
    expect(fingerprintJwtSecret(VALID_SECRET)).not.toBe(fingerprintJwtSecret("a-completely-different-secret-value-here"));
  });
});
