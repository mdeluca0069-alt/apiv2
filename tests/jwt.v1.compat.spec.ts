/**
 * jwt.v1.compat.spec.ts
 *
 * PRODUCTION CUTOVER Stage 1 — verifies the specific compatibility
 * requirement the migration plan depends on: a JWT issued by legacy
 * igfxpro-api (v1) must verify successfully against apiv2's
 * jwt-key-manager.ts, so a user who logged into v1 minutes before cutover
 * isn't forced to re-login the instant the frontend starts talking to
 * apiv2.
 *
 * v1 signs with `jose`'s SignJWT: alg=HS256, header `{alg,typ}` (no `kid`),
 * payload `{sub,email,tenantId,roles,permissions,exp}`, HMAC-SHA256 over
 * `base64url(header).base64url(payload)`. This constructs that exact wire
 * format by hand (apiv2 has no `jose` dependency to import) using the same
 * primitives jwt-key-manager.ts itself uses, so this is a real
 * interop proof, not a mock.
 *
 * Also proves the negative: apiv2 must stay in HS256 mode (no
 * JWT_PRIVATE_KEY/JWT_PUBLIC_KEY set) for the cutover window, matching
 * PRODUCTION_CUTOVER_REPORT.md's Stage 1 requirement — if apiv2 were ever
 * deployed in RS256 mode before the transition window ends, every v1 token
 * silently stops working. Guards that operational requirement with a real
 * assertion instead of a code comment alone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { jwtKeyManager } from "../security/jwt-key-manager.js";

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Mirrors exactly what igfxpro-api (v1)'s `jose`-based SignJWT produces. */
function signV1StyleToken(secret: string, payload: Record<string, unknown>, ttlSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" })); // no `kid` — jose doesn't add one unless told to
  const body   = base64Url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1_000) + ttlSeconds }));
  const sigInput = `${header}.${body}`;
  const signature = base64Url(createHmac("sha256", secret).update(sigInput).digest());
  return `${sigInput}.${signature}`;
}

const SHARED_SECRET = "shared-production-jwt-secret-at-least-32-bytes-long";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("jwt-key-manager.ts — v1 token interop (HS256, shared secret)", () => {
  it("verifies a v1-shaped token (no kid, jose-style HS256) when apiv2 is configured with the SAME JWT_SECRET", () => {
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;
    process.env.JWT_SECRET = SHARED_SECRET;
    jwtKeyManager.init();

    const v1Token = signV1StyleToken(SHARED_SECRET, {
      sub: "user-1", email: "trader@igfxpro.com", tenantId: "tenant-1",
      roles: ["trader"], permissions: ["trading:read"],
    }, 3600);

    const result = jwtKeyManager.verifyToken(v1Token);

    expect(result).not.toBeNull();
    expect(result?.sub).toBe("user-1");
    expect(result?.email).toBe("trader@igfxpro.com");
    expect(result?.roles).toEqual(["trader"]);
  });

  it("rejects a v1-shaped token signed with a DIFFERENT secret than apiv2 is configured with", () => {
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;
    process.env.JWT_SECRET = SHARED_SECRET;
    jwtKeyManager.init();

    const wrongSecretToken = signV1StyleToken("a-completely-different-secret-value-32bytes", {
      sub: "user-1", email: "trader@igfxpro.com", tenantId: "tenant-1", roles: ["trader"], permissions: [],
    }, 3600);

    expect(jwtKeyManager.verifyToken(wrongSecretToken)).toBeNull();
  });

  it("rejects an expired v1-shaped token even with the correct secret", () => {
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;
    process.env.JWT_SECRET = SHARED_SECRET;
    jwtKeyManager.init();

    const expiredToken = signV1StyleToken(SHARED_SECRET, {
      sub: "user-1", email: "trader@igfxpro.com", tenantId: "tenant-1", roles: ["trader"], permissions: [],
    }, -60); // expired 60s ago

    expect(jwtKeyManager.verifyToken(expiredToken)).toBeNull();
  });

  it("OPERATIONAL GUARD: a v1 HS256 token stops verifying the instant apiv2 is configured for RS256 -- proves why Stage 1 requires pinning apiv2 to HS256 for the cutover window", () => {
    process.env.JWT_SECRET = SHARED_SECRET; // still set, but RSA keys take priority when present
    process.env.JWT_PRIVATE_KEY =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n-----END PRIVATE KEY-----";
    process.env.JWT_PUBLIC_KEY =
      "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCo1adjWzs\n-----END PUBLIC KEY-----";
    // jwt-key-manager.ts's real RSA path requires an actual valid keypair to
    // sign/verify with -- generating one here isn't the point of this test
    // (the primitive itself is already exercised elsewhere in this repo).
    // The property under test is purely the mode SWITCH: once real-looking
    // PEM material is present, jwt-key-manager.ts's init() selects RS256 as
    // the primary slot's algorithm, and verifyWithSlot() never falls back to
    // treating an HS256-shaped token as valid for an RS256 slot -- so a v1
    // token, still HMAC-signed, cannot possibly verify against it regardless
    // of whether the RSA keys themselves are well-formed.
    jwtKeyManager.init();

    const v1Token = signV1StyleToken(SHARED_SECRET, {
      sub: "user-1", email: "trader@igfxpro.com", tenantId: "tenant-1", roles: ["trader"], permissions: [],
    }, 3600);

    expect(jwtKeyManager.getPrimarySlot().algorithm).toBe("RS256");
    expect(jwtKeyManager.verifyToken(v1Token)).toBeNull();
  });
});
