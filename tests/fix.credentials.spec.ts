/**
 * fix.credentials.spec.ts
 *
 * Milestone 1 / Fix #4 — FIX 4.4 Logon must verify real credentials, not
 * just accept a claimed Account field. Proves verifyFixCredentials():
 * rejects when persistence is unavailable, rejects an unknown username,
 * rejects a wrong password, and returns the real userId on success.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockFindUnique, mockVerifyPassword } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockVerifyPassword: vi.fn(),
}));

let isPersistent = true;

vi.mock("../shared/db.js", () => ({
  get IS_PERSISTENT() { return isPersistent; },
  prisma: { user: { findUnique: mockFindUnique } },
}));
vi.mock("../auth-service/password.hasher.js", () => ({
  verifyPassword: mockVerifyPassword,
}));

const { verifyFixCredentials } = await import("../fix-gateway/fix.credentials.js");

beforeEach(() => {
  isPersistent = true;
  mockFindUnique.mockReset();
  mockVerifyPassword.mockReset();
});

describe("verifyFixCredentials", () => {
  it("returns null when the platform is not persistent (sandbox mode)", async () => {
    isPersistent = false;
    const result = await verifyFixCredentials("trader@example.com", "whatever");
    expect(result).toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("returns null for an unknown username", async () => {
    mockFindUnique.mockResolvedValue(null);
    const result = await verifyFixCredentials("nobody@example.com", "whatever");
    expect(result).toBeNull();
    expect(mockVerifyPassword).not.toHaveBeenCalled();
  });

  it("returns null for a wrong password", async () => {
    mockFindUnique.mockResolvedValue({ id: "user-1", email: "trader@example.com", password: "hash" });
    mockVerifyPassword.mockResolvedValue(false);
    const result = await verifyFixCredentials("trader@example.com", "wrong-password");
    expect(result).toBeNull();
  });

  it("returns the real userId on correct credentials", async () => {
    mockFindUnique.mockResolvedValue({ id: "user-1", email: "trader@example.com", password: "hash" });
    mockVerifyPassword.mockResolvedValue(true);
    const result = await verifyFixCredentials("trader@example.com", "correct-password");
    expect(result).toBe("user-1");
  });

  it("looks up the username case-insensitively", async () => {
    mockFindUnique.mockResolvedValue({ id: "user-1", email: "trader@example.com", password: "hash" });
    mockVerifyPassword.mockResolvedValue(true);
    await verifyFixCredentials("Trader@Example.com  ", "correct-password");
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { email: "trader@example.com" } });
  });
});
