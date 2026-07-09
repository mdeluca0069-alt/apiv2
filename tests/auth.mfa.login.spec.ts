/**
 * auth.mfa.login.spec.ts
 *
 * Milestone 1 / Fix #3 — password alone must never be sufficient to obtain a
 * full session for an account with 2FA enrolled. Proves:
 *   1. login() with 2FA disabled issues real tokens immediately (unchanged
 *      behaviour for the common case).
 *   2. login() with 2FA enabled issues NO tokens — only a requiresMfa
 *      challenge.
 *   3. completeMfaLogin() with a valid challenge + correct TOTP code is the
 *      only path that then mints real tokens.
 *   4. A wrong code fails, and — because the challenge is single-use — a
 *      second attempt with the SAME challenge token and the CORRECT code
 *      also fails (no replay), forcing the client back through login().
 *   5. An unknown/expired challenge token is rejected outright.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockFindUnique, mockUpdate,
  mockVerifyPassword, mockNeedsUpgrade,
  mockIsEnabled, mockVerify,
  mockCreateToken,
  mockSessionCreate,
  mockIsAccountLocked, mockTrackLoginAttempt,
  mockUpsertDeviceProfile,
} = vi.hoisted(() => ({
  mockFindUnique:  vi.fn(),
  mockUpdate:      vi.fn().mockResolvedValue({}),
  mockVerifyPassword: vi.fn(),
  mockNeedsUpgrade:   vi.fn().mockReturnValue(false),
  mockIsEnabled:   vi.fn(),
  mockVerify:      vi.fn(),
  mockCreateToken: vi.fn().mockReturnValue("real-access-token"),
  mockSessionCreate: vi.fn().mockResolvedValue("real-refresh-token"),
  mockIsAccountLocked: vi.fn().mockResolvedValue(null),
  mockTrackLoginAttempt: vi.fn().mockResolvedValue(undefined),
  mockUpsertDeviceProfile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: { user: { findUnique: mockFindUnique, update: mockUpdate } },
}));
vi.mock("./password.hasher.js", () => ({
  verifyPassword: mockVerifyPassword,
  needsUpgrade:   mockNeedsUpgrade,
  hashPassword:   vi.fn().mockResolvedValue("hashed"),
}));
vi.mock("../auth-service/password.hasher.js", () => ({
  verifyPassword: mockVerifyPassword,
  needsUpgrade:   mockNeedsUpgrade,
  hashPassword:   vi.fn().mockResolvedValue("hashed"),
}));
vi.mock("../auth-service/2fa.service.js", () => ({
  twoFactorService: { isEnabled: mockIsEnabled, verify: mockVerify },
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

const { authService } = await import("../auth-service/auth.service.js");

const USER = {
  id: "user-mfa-1",
  email: "trader@example.com",
  password: "argon2-hash",
  fullName: "Test Trader",
  tenantId: "tenant-1",
  tier: "STANDARD",
  kycStatus: "approved",
  roles: JSON.stringify(["trader"]),
  permissions: JSON.stringify(["trading:read"]),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUnique.mockResolvedValue(USER);
  mockVerifyPassword.mockResolvedValue(true);
  mockNeedsUpgrade.mockReturnValue(false);
  mockIsAccountLocked.mockResolvedValue(null);
});

describe("authService.login — 2FA gating", () => {
  it("issues real tokens immediately when 2FA is not enabled", async () => {
    mockIsEnabled.mockResolvedValue(false);

    const result = await authService.login("trader@example.com", "correct-password");

    expect(result.ok).toBe(true);
    expect(result.requiresMfa).toBeFalsy();
    expect(result.accessToken).toBe("real-access-token");
    expect(result.refreshToken).toBe("real-refresh-token");
  });

  it("issues NO tokens when 2FA is enabled — only a requiresMfa challenge", async () => {
    mockIsEnabled.mockResolvedValue(true);

    const result = await authService.login("trader@example.com", "correct-password");

    expect(result.ok).toBe(true);
    expect(result.requiresMfa).toBe(true);
    expect(result.mfaToken).toBeTruthy();
    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
    // The password step must never itself mint a usable session.
    expect(mockCreateToken).not.toHaveBeenCalled();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("still rejects on wrong password before ever reaching the 2FA check", async () => {
    mockVerifyPassword.mockResolvedValue(false);
    mockIsEnabled.mockResolvedValue(true);

    const result = await authService.login("trader@example.com", "wrong-password");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("INVALID_CREDENTIALS");
    expect(mockIsEnabled).not.toHaveBeenCalled();
  });
});

describe("authService.completeMfaLogin", () => {
  it("mints real tokens for a valid challenge + correct code", async () => {
    mockIsEnabled.mockResolvedValue(true);
    const challenge = await authService.login("trader@example.com", "correct-password");
    expect(challenge.mfaToken).toBeTruthy();

    mockVerify.mockResolvedValue({ valid: true });
    const result = await authService.completeMfaLogin(challenge.mfaToken!, "123456");

    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe("real-access-token");
    expect(result.refreshToken).toBe("real-refresh-token");
  });

  it("rejects a wrong code and does not allow replaying the same challenge afterward", async () => {
    mockIsEnabled.mockResolvedValue(true);
    const challenge = await authService.login("trader@example.com", "correct-password");

    mockVerify.mockResolvedValue({ valid: false });
    const wrong = await authService.completeMfaLogin(challenge.mfaToken!, "000000");
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toBe("INVALID_MFA_CODE");

    // Challenge tokens are single-use: even the *right* code now fails,
    // because the token was already consumed by the attempt above.
    mockVerify.mockResolvedValue({ valid: true });
    const replay = await authService.completeMfaLogin(challenge.mfaToken!, "123456");
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe("MFA_CHALLENGE_INVALID_OR_EXPIRED");
  });

  it("rejects an unknown/expired challenge token outright", async () => {
    const result = await authService.completeMfaLogin("not-a-real-token", "123456");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("MFA_CHALLENGE_INVALID_OR_EXPIRED");
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
