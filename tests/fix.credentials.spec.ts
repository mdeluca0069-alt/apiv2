/**
 * fix.credentials.spec.ts
 *
 * Milestone 1 / Fix #4 — FIX 4.4 Logon must verify real credentials, not
 * just accept a claimed Account field. Proves verifyFixCredentials():
 * rejects when persistence is unavailable, rejects an unknown username,
 * rejects a wrong password, and returns the real userId on success.
 *
 * FIX GATEWAY HARDENING — verifyFixCredentials() now takes a required `ip`
 * parameter and integrates with the platform's existing SIEM lockout
 * (security/event-correlator.ts) and failed-attempt tracking
 * (auth-service/suspicious.login.ts), mirroring auth-service/auth.service.ts's
 * login() exactly: check the lockout first, record every failed attempt
 * (unknown username OR wrong password) via both trackLoginAttempt() and
 * suspiciousLogin.recordFailedAttempt(), record success via
 * suspiciousLogin.recordSuccess(). This file proves that integration, not
 * just the original credential-matching logic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockFindUnique, mockVerifyPassword, mockIsAccountLocked, mockTrackLoginAttempt, mockRecordFailedAttempt, mockRecordSuccess } = vi.hoisted(() => ({
  mockFindUnique:        vi.fn(),
  mockVerifyPassword:    vi.fn(),
  mockIsAccountLocked:   vi.fn(),
  mockTrackLoginAttempt: vi.fn(),
  mockRecordFailedAttempt: vi.fn(),
  mockRecordSuccess:       vi.fn(),
}));

let isPersistent = true;

vi.mock("../shared/db.js", () => ({
  get IS_PERSISTENT() { return isPersistent; },
  prisma: { user: { findUnique: mockFindUnique } },
}));
vi.mock("../auth-service/password.hasher.js", () => ({
  verifyPassword: mockVerifyPassword,
}));
vi.mock("../security/event-correlator.js", () => ({
  isAccountLocked:   mockIsAccountLocked,
  trackLoginAttempt: mockTrackLoginAttempt,
}));
vi.mock("../auth-service/suspicious.login.js", () => ({
  suspiciousLogin: {
    recordFailedAttempt: mockRecordFailedAttempt,
    recordSuccess:       mockRecordSuccess,
  },
}));

const { verifyFixCredentials } = await import("../fix-gateway/fix.credentials.js");

const IP = "203.0.113.7";

beforeEach(() => {
  isPersistent = true;
  mockFindUnique.mockReset();
  mockVerifyPassword.mockReset();
  mockIsAccountLocked.mockReset().mockResolvedValue(null); // not locked, by default
  mockTrackLoginAttempt.mockReset().mockResolvedValue(null);
  mockRecordFailedAttempt.mockReset().mockResolvedValue(undefined);
  mockRecordSuccess.mockReset().mockResolvedValue(undefined);
});

describe("verifyFixCredentials", () => {
  it("returns null when the platform is not persistent (sandbox mode)", async () => {
    isPersistent = false;
    const result = await verifyFixCredentials("trader@example.com", "whatever", IP);
    expect(result).toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockIsAccountLocked).not.toHaveBeenCalled();
  });

  it("returns null for an unknown username, and records the failed attempt", async () => {
    mockFindUnique.mockResolvedValue(null);
    const result = await verifyFixCredentials("nobody@example.com", "whatever", IP);
    expect(result).toBeNull();
    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(mockRecordFailedAttempt).toHaveBeenCalledWith(IP, "nobody@example.com");
    expect(mockTrackLoginAttempt).toHaveBeenCalledWith(IP, "nobody@example.com", true);
  });

  it("returns null for a wrong password, and records the failed attempt", async () => {
    mockFindUnique.mockResolvedValue({ id: "user-1", email: "trader@example.com", password: "hash" });
    mockVerifyPassword.mockResolvedValue(false);
    const result = await verifyFixCredentials("trader@example.com", "wrong-password", IP);
    expect(result).toBeNull();
    expect(mockRecordFailedAttempt).toHaveBeenCalledWith(IP, "trader@example.com");
    expect(mockTrackLoginAttempt).toHaveBeenCalledWith(IP, "trader@example.com", true);
  });

  it("returns the real userId on correct credentials, and records success (not a failed attempt)", async () => {
    mockFindUnique.mockResolvedValue({ id: "user-1", email: "trader@example.com", password: "hash" });
    mockVerifyPassword.mockResolvedValue(true);
    const result = await verifyFixCredentials("trader@example.com", "correct-password", IP);
    expect(result).toBe("user-1");
    expect(mockRecordSuccess).toHaveBeenCalledWith("user-1", IP, "FIX/4.4");
    expect(mockRecordFailedAttempt).not.toHaveBeenCalled();
    expect(mockTrackLoginAttempt).not.toHaveBeenCalled();
  });

  it("looks up the username case-insensitively", async () => {
    mockFindUnique.mockResolvedValue({ id: "user-1", email: "trader@example.com", password: "hash" });
    mockVerifyPassword.mockResolvedValue(true);
    await verifyFixCredentials("Trader@Example.com  ", "correct-password", IP);
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { email: "trader@example.com" } });
  });

  describe("account lockout integration (REGRESSION GUARD)", () => {
    it("rejects immediately when the SIEM correlator reports the account locked, WITHOUT checking the password", async () => {
      mockIsAccountLocked.mockResolvedValue("BRUTE_FORCE");
      const result = await verifyFixCredentials("locked@example.com", "whatever-password", IP);
      expect(result).toBeNull();
      expect(mockVerifyPassword).not.toHaveBeenCalled();
      expect(mockFindUnique).toHaveBeenCalled(); // lookup still happens, mirroring auth.service.ts's own ordering
    });

    it("rejects immediately when locked even if the password given is actually correct", async () => {
      mockFindUnique.mockResolvedValue({ id: "user-1", email: "trader@example.com", password: "hash" });
      mockIsAccountLocked.mockResolvedValue("BRUTE_FORCE");
      mockVerifyPassword.mockResolvedValue(true); // would have succeeded if not locked
      const result = await verifyFixCredentials("trader@example.com", "correct-password", IP);
      expect(result).toBeNull();
      expect(mockRecordSuccess).not.toHaveBeenCalled();
    });

    it("does not reject when isAccountLocked() itself throws — fails open on the lockout check only, not on the credential check itself", async () => {
      mockFindUnique.mockResolvedValue({ id: "user-1", email: "trader@example.com", password: "hash" });
      mockIsAccountLocked.mockRejectedValue(new Error("redis unavailable"));
      mockVerifyPassword.mockResolvedValue(true);
      const result = await verifyFixCredentials("trader@example.com", "correct-password", IP);
      expect(result).toBe("user-1");
    });

    it("every failed-attempt call site feeds the SAME correlation functions the web login path uses (auth-service/auth.service.ts)", async () => {
      // Not a behavioral assertion beyond what's already covered above --
      // documents WHY this file mocks security/event-correlator.js and
      // auth-service/suspicious.login.js at all: verifyFixCredentials must
      // never invent its own separate tracking mechanism that the SIEM
      // correlator doesn't see, or FIX brute-forcing would go undetected
      // even after this hardening pass.
      mockFindUnique.mockResolvedValue(null);
      await verifyFixCredentials("someone@example.com", "x", IP);
      expect(mockTrackLoginAttempt).toHaveBeenCalledTimes(1);
      expect(mockRecordFailedAttempt).toHaveBeenCalledTimes(1);
    });
  });
});
