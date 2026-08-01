/**
 * job.coordinator.renewal.spec.ts
 *
 * PHASE2_REMEDIATION (H14): every job registered via jobCoordinator.
 * register() (the 10-job inventory table in job.coordinator.ts's own
 * header comment -- stop-out-scan, liquidation-watchdog, pending-order-
 * expiry, etc. -- everything except daily-snapshot-eod/swap-accrual-
 * nightly, which construct DistributedJobLock directly and already call
 * lock.startRenewal() themselves) had NO renewal at all. ttlSeconds is
 * deliberately shorter than the schedule interval (JobSpec.ttlSeconds's
 * own doc comment: "must be < schedule interval"), on the assumption a
 * run always finishes well inside its TTL window -- true in the common
 * case, but if a run's actual duration ever approaches or exceeds
 * ttlSeconds (DB contention, a large position/order count, load --
 * exactly the conditions most likely during a real incident), the lock
 * silently expired mid-run with nothing renewing it, and the next
 * scheduled tick (this worker or another) could acquire the same now-free
 * lock and run the SAME job again concurrently with the still-in-flight
 * first run.
 *
 * Fix: tryLead() now starts the SAME startRenewal() mechanism the two
 * settlement jobs already used, at half the job's TTL; release()/
 * releaseWithError() stop it. These tests exercise the real
 * DistributedJobLock (only shared/redis.js's getRedis() is mocked), so
 * they prove the coordinator+lock integration, not just a mocked-away
 * call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";

const mockRedis = {
  set:    vi.fn(),
  get:    vi.fn(),
  expire: vi.fn(),
  eval:   vi.fn(),
};

vi.mock("../shared/redis.js", () => ({ getRedis: vi.fn(() => mockRedis) }));

import { JobCoordinator } from "../realtime-infra/job.coordinator.js";
import { getRedis } from "../shared/redis.js";

const getRedisMock = getRedis as Mock;

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

describe("JobCoordinator — PHASE2_REMEDIATION (H14): automatic TTL renewal for long-running jobs", () => {
  it("starts renewing the lock (via the real DistributedJobLock.startRenewal) once tryLead() acquires it", async () => {
    const coordinator = new JobCoordinator();
    coordinator.register({ id: "stop-out-scan", ttlSeconds: 25, intervalMs: 30_000, description: "test" });

    const acquired = await coordinator.tryLead("stop-out-scan");
    expect(acquired).toBe(true);

    const leaseId = mockRedis.set.mock.calls[0]![1];
    mockRedis.get.mockResolvedValue(leaseId); // still holds the lease

    // Renewal interval = ttlSeconds/2 = 12.5s -> floor to 12s.
    await vi.advanceTimersByTimeAsync(12_001);

    expect(mockRedis.get).toHaveBeenCalledWith("job:leader:stop-out-scan");
    expect(mockRedis.expire).toHaveBeenCalledWith("job:leader:stop-out-scan", 25);
  });

  it("keeps renewing past the original TTL for a run that takes longer than ttlSeconds -- the exact scenario that used to double-execute", async () => {
    const coordinator = new JobCoordinator();
    coordinator.register({ id: "liquidation-watchdog", ttlSeconds: 25, intervalMs: 30_000, description: "test" });

    await coordinator.tryLead("liquidation-watchdog");
    const leaseId = mockRedis.set.mock.calls[0]![1];
    mockRedis.get.mockResolvedValue(leaseId);

    // Simulate a run that takes 40s -- longer than the 25s TTL. Under the
    // OLD behavior (no renewal at all) the lock would have silently
    // expired at t=25s, well before this. With renewal every 12s, it
    // should have renewed at least 3 times by t=40s.
    await vi.advanceTimersByTimeAsync(40_000);

    expect(mockRedis.expire.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("stops renewing once release() is called (no wasted Redis calls for the common fast-finishing case)", async () => {
    const coordinator = new JobCoordinator();
    coordinator.register({ id: "pending-order-expiry", ttlSeconds: 25, intervalMs: 30_000, description: "test" });

    await coordinator.tryLead("pending-order-expiry");
    await coordinator.release("pending-order-expiry");

    mockRedis.expire.mockClear();
    mockRedis.get.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it("stops renewing on releaseWithError() too", async () => {
    const coordinator = new JobCoordinator();
    coordinator.register({ id: "outbox-retry-sweep", ttlSeconds: 25, intervalMs: 30_000, description: "test" });

    await coordinator.tryLead("outbox-retry-sweep");
    await coordinator.releaseWithError("outbox-retry-sweep", new Error("boom"));

    mockRedis.expire.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it("does NOT start a renewal timer when tryLead() fails to acquire the lock (another worker holds it)", async () => {
    const coordinator = new JobCoordinator();
    coordinator.register({ id: "audit-outbox-consumer", ttlSeconds: 8, intervalMs: 10_000, description: "test" });

    mockRedis.set.mockResolvedValue(null); // SET NX fails — already locked
    const acquired = await coordinator.tryLead("audit-outbox-consumer");
    expect(acquired).toBe(false);

    mockRedis.get.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it("survives a full acquire -> renew -> release cycle for a subsequent run without leaking timers (re-registration-free reuse)", async () => {
    const coordinator = new JobCoordinator();
    coordinator.register({ id: "reconciliation-sweep", ttlSeconds: 240, intervalMs: 300_000, description: "test" });

    // Run 1
    await coordinator.tryLead("reconciliation-sweep");
    let leaseId = mockRedis.set.mock.calls[0]![1];
    mockRedis.get.mockResolvedValue(leaseId);
    await coordinator.release("reconciliation-sweep");

    // Run 2 — a brand new lease; if run 1's timer were still alive using
    // the OLD leaseId, its next GET would find a mismatch and correctly
    // no-op, but it should not exist at all after release().
    mockRedis.set.mockClear();
    mockRedis.expire.mockClear();
    await coordinator.tryLead("reconciliation-sweep");
    leaseId = mockRedis.set.mock.calls[0]![1];
    mockRedis.get.mockResolvedValue(leaseId);

    await vi.advanceTimersByTimeAsync(120_001); // one renewal interval (240/2=120s)

    // Exactly one renewal timer active (run 2's), not two stacked ones.
    expect(mockRedis.expire).toHaveBeenCalledTimes(1);
  });
});
