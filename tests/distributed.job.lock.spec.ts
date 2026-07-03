/**
 * distributed.job.lock.spec.ts
 *
 * Unit tests for DistributedJobLock — Redis-backed leader election that ensures
 * exactly one worker per cluster runs a given background job within a TTL window.
 *
 * Isolation strategy:
 *   - getRedis() is mocked via vi.mock — returns a fake Redis client by default
 *   - Individual tests override the mock inline when testing degraded / outage modes
 *   - No live Redis connection required
 *
 * Coverage:
 *   1.  tryAcquire() — success: Redis SET NX returns "OK" → true
 *   2.  tryAcquire() — already locked: Redis SET NX returns null → false
 *   3.  tryAcquire() — Redis unavailable (getRedis() returns null) → true (graceful degradation)
 *   4.  tryAcquire() — correct key format: job:leader:{jobId}
 *   5.  tryAcquire() — correct TTL passed to SET EX
 *   6.  tryAcquire() — leaseId is a UUID set on the instance when acquired
 *   7.  tryAcquire() — leaseId stays null when lock not acquired
 *   8.  release() — calls Lua eval with correct key and leaseId
 *   9.  release() — no-op when Redis unavailable
 *  10.  release() — no-op when leaseId is null (lock not held)
 *  11.  release() — non-fatal on Redis eval error (does not throw)
 *  12.  release() — clears leaseId after call (allows re-acquire)
 *  13.  startRenewal() — renews TTL when leaseId still matches
 *  14.  startRenewal() — does NOT renew when Redis returns different leaseId
 *  15.  startRenewal() — returns no-op interval when Redis unavailable
 *  16.  startRenewal() — renewal error is non-fatal
 *  17.  Full workflow: acquire → do work → release → key deleted
 *  18.  Two lock instances on same jobId: second acquire fails while first holds
 *  19.  Custom TTL is respected (not hardcoded to 300)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";

// ── Mock Redis client ─────────────────────────────────────────────────────────

const mockRedis = {
  set:    vi.fn(),
  get:    vi.fn(),
  expire: vi.fn(),
  eval:   vi.fn(),
};

vi.mock("../shared/redis.js", () => ({
  getRedis: vi.fn(() => mockRedis),
}));

// Import after mocks
import { DistributedJobLock } from "../shared/distributed.job.lock.js";
import { getRedis } from "../shared/redis.js";

const getRedisMock = getRedis as Mock;

// ─── 1. tryAcquire — success ──────────────────────────────────────────────────

describe("tryAcquire() — success", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    getRedisMock.mockReturnValue(mockRedis);
    mockRedis.set.mockResolvedValue("OK");
  });

  it("returns true when Redis SET NX returns OK", async () => {
    const lock = new DistributedJobLock("test-job");
    const acquired = await lock.tryAcquire();
    expect(acquired).toBe(true);
  });

  it("calls SET with NX and EX flags", async () => {
    const lock = new DistributedJobLock("test-job", 300);
    await lock.tryAcquire();

    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.any(String), // key
      expect.any(String), // leaseId
      "EX",
      300,
      "NX",
    );
  });

  it("uses correct key format: job:leader:{jobId}", async () => {
    const lock = new DistributedJobLock("swap-accrual");
    await lock.tryAcquire();

    const [key] = mockRedis.set.mock.calls[0];
    expect(key).toBe("job:leader:swap-accrual");
  });

  it("respects custom TTL", async () => {
    const lock = new DistributedJobLock("my-job", 600);
    await lock.tryAcquire();

    const callArgs = mockRedis.set.mock.calls[0];
    expect(callArgs).toContain(600);
  });

  it("leaseId is non-null UUID-like string after acquisition", async () => {
    const lock = new DistributedJobLock("test-job");
    await lock.tryAcquire();

    // leaseId is private — verify it was sent to Redis
    const leaseIdPassedToRedis = mockRedis.set.mock.calls[0][1];
    expect(leaseIdPassedToRedis).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

// ─── 2. tryAcquire — failure (lock held by other) ────────────────────────────

describe("tryAcquire() — lock held by another worker", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    getRedisMock.mockReturnValue(mockRedis);
    mockRedis.set.mockResolvedValue(null); // NX set fails
  });

  it("returns false when Redis SET NX returns null", async () => {
    const lock = new DistributedJobLock("test-job");
    const acquired = await lock.tryAcquire();
    expect(acquired).toBe(false);
  });

  it("leaseId is NOT set when acquisition fails", async () => {
    const lock = new DistributedJobLock("test-job");
    await lock.tryAcquire();

    // If leaseId were set, release() would call eval — verify it does NOT
    mockRedis.eval.mockResolvedValue(0);
    await lock.release();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });
});

// ─── 3. tryAcquire — Redis unavailable (graceful degradation) ────────────────

describe("tryAcquire() — Redis unavailable", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    getRedisMock.mockReturnValue(null); // simulate Redis down
  });

  it("returns true when getRedis() returns null", async () => {
    const lock = new DistributedJobLock("test-job");
    const acquired = await lock.tryAcquire();
    expect(acquired).toBe(true);
  });

  it("does NOT call redis.set when Redis is unavailable", async () => {
    const lock = new DistributedJobLock("test-job");
    await lock.tryAcquire();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });
});

// ─── 4. release() ─────────────────────────────────────────────────────────────

describe("release()", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    getRedisMock.mockReturnValue(mockRedis);
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);
  });

  it("calls eval with Lua script, key, and leaseId when lock held", async () => {
    const lock = new DistributedJobLock("test-job");
    await lock.tryAcquire();
    const leaseId = mockRedis.set.mock.calls[0][1];

    await lock.release();

    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call"),  // Lua script
      1,
      "job:leader:test-job",
      leaseId,
    );
  });

  it("is a no-op when Redis unavailable", async () => {
    getRedisMock.mockReturnValue(null);
    const lock = new DistributedJobLock("test-job");
    // Acquire while Redis unavailable (returns true without leaseId)
    await lock.tryAcquire();

    getRedisMock.mockReturnValue(null); // still down
    await lock.release();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it("is a no-op when lock was never acquired (leaseId is null)", async () => {
    const lock = new DistributedJobLock("test-job");
    // Never called tryAcquire()
    await lock.release();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it("is a no-op when tryAcquire() failed (leaseId not set)", async () => {
    mockRedis.set.mockResolvedValue(null); // failed acquire
    const lock = new DistributedJobLock("test-job");
    await lock.tryAcquire();

    await lock.release();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it("does not throw when eval fails (non-fatal)", async () => {
    const lock = new DistributedJobLock("test-job");
    await lock.tryAcquire();
    mockRedis.eval.mockRejectedValue(new Error("Redis connection closed"));

    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("clears leaseId after release (allows re-acquire)", async () => {
    const lock = new DistributedJobLock("test-job");
    await lock.tryAcquire();
    await lock.release();

    // After release, a second release should be a no-op (leaseId cleared)
    mockRedis.eval.mockClear();
    await lock.release();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });
});

// ─── 5. startRenewal() ────────────────────────────────────────────────────────

describe("startRenewal()", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    getRedisMock.mockReturnValue(mockRedis);
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extends TTL when leaseId still matches", async () => {
    const lock = new DistributedJobLock("test-job", 300);
    await lock.tryAcquire();
    const leaseId = mockRedis.set.mock.calls[0][1];

    mockRedis.get.mockResolvedValue(leaseId); // still our lease

    const handle = lock.startRenewal(90); // renew every 90 seconds

    await vi.advanceTimersByTimeAsync(90_001);

    expect(mockRedis.get).toHaveBeenCalledWith("job:leader:test-job");
    expect(mockRedis.expire).toHaveBeenCalledWith("job:leader:test-job", 300);

    clearInterval(handle);
  });

  it("does NOT extend TTL when leaseId has changed (another worker re-acquired)", async () => {
    const lock = new DistributedJobLock("test-job", 300);
    await lock.tryAcquire();

    // Simulate: our lock expired, different worker took it
    mockRedis.get.mockResolvedValue("foreign-lease-id");

    const handle = lock.startRenewal(90);
    await vi.advanceTimersByTimeAsync(90_001);

    expect(mockRedis.get).toHaveBeenCalled();
    expect(mockRedis.expire).not.toHaveBeenCalled(); // no extension

    clearInterval(handle);
  });

  it("returns a no-op interval when Redis is unavailable", async () => {
    // Acquire when Redis is down (returns true without leaseId)
    getRedisMock.mockReturnValue(null);
    const lock = new DistributedJobLock("test-job", 300);
    await lock.tryAcquire();

    const handle = lock.startRenewal(90);

    await vi.advanceTimersByTimeAsync(90_001);

    // No Redis calls made
    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(mockRedis.expire).not.toHaveBeenCalled();

    clearInterval(handle);
  });

  it("renewal error is non-fatal (does not throw)", async () => {
    const lock = new DistributedJobLock("test-job", 300);
    await lock.tryAcquire();
    const leaseId = mockRedis.set.mock.calls[0][1];

    mockRedis.get.mockResolvedValue(leaseId);
    mockRedis.expire.mockRejectedValue(new Error("Redis timeout"));

    const handle = lock.startRenewal(90);

    // Should not throw even when expire fails — just advance the clock
    await vi.advanceTimersByTimeAsync(90_001);

    clearInterval(handle);
  });

  it("renews multiple times across intervals", async () => {
    const lock = new DistributedJobLock("test-job", 300);
    await lock.tryAcquire();
    const leaseId = mockRedis.set.mock.calls[0][1];
    mockRedis.get.mockResolvedValue(leaseId);

    const handle = lock.startRenewal(90);

    await vi.advanceTimersByTimeAsync(270_001); // 3 intervals

    expect(mockRedis.expire.mock.calls.length).toBeGreaterThanOrEqual(3);

    clearInterval(handle);
  });
});

// ─── 6. Full workflow ──────────────────────────────────────────────────────────

describe("Full workflow: acquire → work → release", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    getRedisMock.mockReturnValue(mockRedis);
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);
  });

  it("complete happy-path: acquire, renew, release", async () => {
    vi.useFakeTimers();
    try {
      const lock = new DistributedJobLock("swap-accrual", 300);
      const acquired = await lock.tryAcquire();
      expect(acquired).toBe(true);

      const leaseId = mockRedis.set.mock.calls[0][1];
      mockRedis.get.mockResolvedValue(leaseId);

      const renewal = lock.startRenewal(90);

      // Simulate work
      await vi.advanceTimersByTimeAsync(90_001);
      expect(mockRedis.expire).toHaveBeenCalledOnce();

      clearInterval(renewal);
      await lock.release();

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call"),
        1,
        "job:leader:swap-accrual",
        leaseId,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("two instances same jobId: second acquire fails while first holds", async () => {
    const lockA = new DistributedJobLock("daily-snapshot", 300);
    const lockB = new DistributedJobLock("daily-snapshot", 300);

    // A acquires
    mockRedis.set.mockResolvedValueOnce("OK");
    const acquiredA = await lockA.tryAcquire();

    // B tries — NX fails (key already set)
    mockRedis.set.mockResolvedValueOnce(null);
    const acquiredB = await lockB.tryAcquire();

    expect(acquiredA).toBe(true);
    expect(acquiredB).toBe(false);
  });

  it("after release, a new acquire on same job succeeds", async () => {
    const lock = new DistributedJobLock("test-job", 300);

    mockRedis.set.mockResolvedValue("OK");
    await lock.tryAcquire();

    mockRedis.eval.mockResolvedValue(1);
    await lock.release();

    // After release, another acquire should be possible
    mockRedis.set.mockResolvedValue("OK");
    const reacquired = await lock.tryAcquire();
    expect(reacquired).toBe(true);
  });

  it("Redis down during work but acquired before outage: release is graceful", async () => {
    const lock = new DistributedJobLock("test-job", 300);
    await lock.tryAcquire(); // acquired when Redis was up

    // Redis goes down mid-job
    getRedisMock.mockReturnValue(null);

    await expect(lock.release()).resolves.toBeUndefined(); // should not throw
  });
});

// ─── 7. Custom TTL and job naming ─────────────────────────────────────────────

describe("Configuration", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    getRedisMock.mockReturnValue(mockRedis);
    mockRedis.set.mockResolvedValue("OK");
  });

  it("default TTL is 300 seconds", async () => {
    const lock = new DistributedJobLock("default-ttl-job");
    await lock.tryAcquire();

    const callArgs = mockRedis.set.mock.calls[0];
    expect(callArgs).toContain(300);
  });

  it("custom TTL of 60 seconds is passed correctly", async () => {
    const lock = new DistributedJobLock("short-job", 60);
    await lock.tryAcquire();

    const callArgs = mockRedis.set.mock.calls[0];
    expect(callArgs).toContain(60);
  });

  it("custom TTL of 3600 seconds for long-running jobs", async () => {
    const lock = new DistributedJobLock("long-job", 3600);
    await lock.tryAcquire();

    const callArgs = mockRedis.set.mock.calls[0];
    expect(callArgs).toContain(3600);
  });

  it("different jobIds produce different keys", async () => {
    const lockA = new DistributedJobLock("job-alpha");
    const lockB = new DistributedJobLock("job-beta");

    await lockA.tryAcquire();
    await lockB.tryAcquire();

    const keyA = mockRedis.set.mock.calls[0][0];
    const keyB = mockRedis.set.mock.calls[1][0];

    expect(keyA).toBe("job:leader:job-alpha");
    expect(keyB).toBe("job:leader:job-beta");
    expect(keyA).not.toBe(keyB);
  });

  it("two acquisitions generate different leaseIds (UUID)", async () => {
    const lock = new DistributedJobLock("test-job");
    await lock.tryAcquire();
    mockRedis.eval.mockResolvedValue(1);
    await lock.release();

    await lock.tryAcquire();

    const leaseId1 = mockRedis.set.mock.calls[0][1];
    const leaseId2 = mockRedis.set.mock.calls[1][1];

    expect(leaseId1).not.toBe(leaseId2);
  });
});

// ─── 8. Lua release script correctness ───────────────────────────────────────

describe("Lua release script", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    getRedisMock.mockReturnValue(mockRedis);
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.eval.mockResolvedValue(1);
  });

  it("Lua script checks ownership before delete (GET then DEL)", async () => {
    const lock = new DistributedJobLock("test-job");
    await lock.tryAcquire();
    await lock.release();

    const [script] = mockRedis.eval.mock.calls[0];
    expect(script).toContain('redis.call("GET"');
    expect(script).toContain('redis.call("DEL"');
  });

  it("eval is called with KEYS[1] arity=1 (single key)", async () => {
    const lock = new DistributedJobLock("test-job");
    await lock.tryAcquire();
    await lock.release();

    const [, keysCount] = mockRedis.eval.mock.calls[0];
    expect(keysCount).toBe(1);
  });

  it("eval returns 0 when leaseId does not match (already expired)", async () => {
    const lock = new DistributedJobLock("test-job");
    await lock.tryAcquire();

    mockRedis.eval.mockResolvedValue(0); // script returns 0 (did not delete)
    await expect(lock.release()).resolves.toBeUndefined(); // still non-fatal
  });
});
