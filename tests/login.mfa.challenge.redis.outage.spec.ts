/**
 * login.mfa.challenge.redis.outage.spec.ts
 *
 * PHASE E (failure-injection audit): getRedis() only reflects whether Redis
 * is CONFIGURED, not whether it's currently reachable -- issueLoginMfaChallenge()/
 * consumeLoginMfaChallenge() called `redis.setex`/`redis.get` directly and
 * uncaught. A live Redis outage on an otherwise-configured instance (as
 * opposed to "never configured", which already had a working in-memory
 * fallback via memChallenges) threw straight out of both functions --
 * blocking login entirely for every MFA-enrolled user platform-wide, even
 * though the password step had already succeeded.
 *
 * Fix: both functions now catch a live Redis failure and fall back to the
 * same in-memory store already used for the "never configured" case.
 *
 * This uses the real module (not the shared/redis.js mock's happy path) --
 * `getRedis()` is mocked to return a Redis-shaped object whose methods
 * reject, simulating a live outage on an otherwise-configured client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedis = {
  setex: vi.fn(),
  get:   vi.fn(),
  del:   vi.fn(),
};
vi.mock("../shared/redis.js", () => ({ getRedis: vi.fn(() => mockRedis) }));

const {
  issueLoginMfaChallenge,
  consumeLoginMfaChallenge,
} = await import("../auth-service/login.mfa.challenge.js");

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("login.mfa.challenge.ts — PHASE E: live Redis outage falls back to in-memory store", () => {
  it("issueLoginMfaChallenge() does NOT throw when redis.setex() rejects -- falls back and still returns a usable token", async () => {
    mockRedis.setex.mockRejectedValue(new Error("ECONNREFUSED"));

    const token = await issueLoginMfaChallenge("user-1");

    expect(token).toEqual(expect.any(String));
    expect(token.length).toBeGreaterThan(0);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Redis setex failed"),
      expect.any(String),
    );
  });

  it("a challenge issued during the Redis outage can be consumed later, also during the outage (both hit the in-memory fallback)", async () => {
    mockRedis.setex.mockRejectedValue(new Error("ECONNREFUSED"));
    mockRedis.get.mockRejectedValue(new Error("ECONNREFUSED"));

    const token = await issueLoginMfaChallenge("user-2");
    const userId = await consumeLoginMfaChallenge(token);

    expect(userId).toBe("user-2");
  });

  it("consumeLoginMfaChallenge() does NOT throw when redis.get() rejects -- falls back, returns null for an unknown token instead of propagating", async () => {
    mockRedis.get.mockRejectedValue(new Error("ECONNRESET"));

    const userId = await consumeLoginMfaChallenge("some-random-token-never-issued-locally");

    expect(userId).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Redis get failed"),
      expect.any(String),
    );
  });

  it("a consumed in-memory-fallback challenge cannot be replayed (still single-use across the fallback path)", async () => {
    mockRedis.setex.mockRejectedValue(new Error("down"));
    mockRedis.get.mockRejectedValue(new Error("down"));

    const token = await issueLoginMfaChallenge("user-3");
    const first  = await consumeLoginMfaChallenge(token);
    const second = await consumeLoginMfaChallenge(token);

    expect(first).toBe("user-3");
    expect(second).toBeNull();
  });

  it("healthy Redis path is unaffected: no fallback log, uses the real client", async () => {
    mockRedis.setex.mockResolvedValue("OK");
    mockRedis.get.mockResolvedValue("user-4");
    mockRedis.del.mockResolvedValue(1);

    const token = await issueLoginMfaChallenge("user-4");
    const userId = await consumeLoginMfaChallenge(token);

    expect(userId).toBe("user-4");
    expect(mockRedis.setex).toHaveBeenCalledTimes(1);
    expect(mockRedis.get).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
