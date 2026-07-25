/**
 * auth.service.bcrypt.lazy.rehash.spec.ts
 *
 * PRODUCTION CUTOVER Stage 1 — proves the end-to-end login() flow for a
 * migrated v1 user whose `User.password` column still holds a real bcrypt
 * hash: login succeeds with the correct password, the stored hash is
 * silently rehashed to Argon2id in the same request (auth.service.ts's
 * pre-existing lazy-upgrade logic, unmodified — it only depends on
 * needsUpgrade()'s boolean, not on which legacy format triggered it), and
 * a wrong password is still correctly rejected without ever touching the
 * rehash path. Unlike password.hasher.bcrypt.compat.spec.ts (which proves
 * the hashing primitives in isolation), this proves the real bcrypt hash
 * survives the full login() code path unmodified before this fix would
 * have made it unverifiable.
 *
 * Uses the REAL password.hasher.ts (not mocked) so the bcrypt verification
 * itself is genuinely exercised, matching the pattern established for
 * margin.warning.pipeline.spec.ts / signal.telemetry.exit.reason.spec.ts
 * elsewhere in this suite (mock only the DB and unrelated services, keep
 * the module under test real).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const { mockFindUnique, mockUpdate, mockIsAccountLocked, mockTrackLoginAttempt,
        mockUpsertDeviceProfile, mockIsEnabled, mockCreateToken, mockSessionCreate } = vi.hoisted(() => ({
  mockFindUnique:  vi.fn(),
  mockUpdate:      vi.fn().mockResolvedValue({}),
  mockIsAccountLocked: vi.fn().mockResolvedValue(null),
  mockTrackLoginAttempt: vi.fn().mockResolvedValue(undefined),
  mockUpsertDeviceProfile: vi.fn().mockResolvedValue(undefined),
  mockIsEnabled:   vi.fn().mockResolvedValue(false), // no 2FA — isolates the rehash behavior
  mockCreateToken: vi.fn().mockReturnValue("real-access-token"),
  mockSessionCreate: vi.fn().mockResolvedValue("real-refresh-token"),
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: { user: { findUnique: mockFindUnique, update: mockUpdate } },
}));
vi.mock("../auth-service/2fa.service.js", () => ({
  twoFactorService: { isEnabled: mockIsEnabled, verify: vi.fn() },
}));
vi.mock("../security/jwt-key-manager.js", () => ({
  jwtKeyManager: { createToken: mockCreateToken },
}));
vi.mock("../auth-service/session.manager.js", () => ({
  sessionManager: { create: mockSessionCreate },
}));
vi.mock("../security/event-correlator.js", () => ({
  isAccountLocked:   mockIsAccountLocked,
  trackLoginAttempt: mockTrackLoginAttempt,
}));
vi.mock("../security/device-fingerprint.js", () => ({
  upsertDeviceProfile: mockUpsertDeviceProfile,
  computeFingerprintFromParts: vi.fn().mockReturnValue("fp"),
}));
vi.mock("../auth-service/suspicious.login.js", () => ({
  suspiciousLogin: { recordFailedAttempt: vi.fn(), recordSuccess: vi.fn() },
}));
vi.mock("../auth-service/geoip.security.js", () => ({
  geoipSecurity: { check: vi.fn().mockResolvedValue({ isBlocked: false }) },
}));
vi.mock("../auth-service/access.policy.js", () => ({
  accessPolicy: { getPermissionsForRoles: vi.fn().mockReturnValue(["trading:read"]) },
}));
// password.hasher.js is intentionally NOT mocked — the real bcrypt/argon2id
// verification is exactly what this test proves.

const { authService } = await import("../auth-service/auth.service.js");

function migratedV1User(bcryptHash: string) {
  return {
    id: "user-1", email: "migrated@igfxpro.com", password: bcryptHash,
    fullName: "Migrated User", tenantId: "tenant-1", tier: "STANDARD",
    kycStatus: "approved", roles: JSON.stringify(["trader"]), permissions: JSON.stringify(["trading:read"]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAccountLocked.mockResolvedValue(null);
  mockIsEnabled.mockResolvedValue(false);
  mockCreateToken.mockReturnValue("real-access-token");
  mockSessionCreate.mockResolvedValue("real-refresh-token");
});

describe("AuthService.login() — migrated v1 user with a real bcrypt password hash", () => {
  it("logs in successfully with the original (pre-migration) password", async () => {
    const bcryptHash = await bcrypt.hash("OriginalV1Password!", 10);
    mockFindUnique.mockResolvedValue(migratedV1User(bcryptHash));

    const result = await authService.login("migrated@igfxpro.com", "OriginalV1Password!");

    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe("real-access-token");
    expect(result.refreshToken).toBe("real-refresh-token");

    // A bcrypt hash also triggers login()'s fire-and-forget lazy rehash (the
    // dedicated assertions for that are in the next test) -- drain it here
    // too, or the still-in-flight Argon2id hashing/db.update call leaks past
    // this test's end and lands unpredictably during a LATER test instead,
    // corrupting whichever one happens to be running when it resolves.
    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it("lazily rehashes the bcrypt hash to Argon2id on the very first successful login", async () => {
    const bcryptHash = await bcrypt.hash("OriginalV1Password!", 10);
    mockFindUnique.mockResolvedValue(migratedV1User(bcryptHash));

    await authService.login("migrated@igfxpro.com", "OriginalV1Password!");
    // The rehash is fire-and-forget (void hashPassword(...).then(...)) inside
    // login() — real Argon2id hashing takes real wall-clock time (well past
    // a single event-loop tick), so poll instead of assuming one
    // setImmediate is enough; a fixed single-tick wait here previously left
    // the promise still in flight, which then landed mid-way through a
    // LATER test and corrupted its assertions instead.
    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1), { timeout: 5000 });

    const call = mockUpdate.mock.calls[0][0] as { where: { id: string }; data: { password: string } };
    expect(call.where.id).toBe("user-1");
    expect(call.data.password).toMatch(/^\$argon2id\$/);
    // The rehashed value must itself verify against the SAME original password.
    const { verifyPassword } = await import("../auth-service/password.hasher.js");
    await expect(verifyPassword(call.data.password, "OriginalV1Password!")).resolves.toBe(true);
  });

  it("rejects the wrong password and never triggers a rehash", async () => {
    const bcryptHash = await bcrypt.hash("OriginalV1Password!", 10);
    mockFindUnique.mockResolvedValue(migratedV1User(bcryptHash));

    const result = await authService.login("migrated@igfxpro.com", "totally-wrong-password");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("INVALID_CREDENTIALS");
    expect(mockCreateToken).not.toHaveBeenCalled();
    // A wrong password never calls verifyPassword() successfully, so there is
    // no async rehash in flight to wait for here — login() returns before
    // needsUpgrade() is ever reached on this path (see auth.service.ts).
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("on the SECOND login (after rehash), the stored hash is already Argon2id and bcrypt is never consulted again", async () => {
    // Simulate the post-rehash state directly: same user row, now with an
    // Argon2id hash (as the previous test proved gets written).
    const { hashPassword } = await import("../auth-service/password.hasher.js");
    const argon2Hash = await hashPassword("OriginalV1Password!");
    mockFindUnique.mockResolvedValue(migratedV1User(argon2Hash));

    const result = await authService.login("migrated@igfxpro.com", "OriginalV1Password!");

    expect(result.ok).toBe(true);
    // needsUpgrade() is false for a real Argon2id hash, so login() never
    // enters the rehash branch at all on this path — nothing async is
    // in flight to wait for.
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
