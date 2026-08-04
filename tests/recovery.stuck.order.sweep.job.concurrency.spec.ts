/**
 * recovery.stuck.order.sweep.job.concurrency.spec.ts
 *
 * CUTOVER REMEDIATION (Task 3) — completes verification of the
 * recovery-stuck-order-sweep job beyond the registration-completeness
 * static check (tests/main.jobcoordinator.registration.completeness.spec.ts,
 * which caught and proved the original "not registered" bug, fixed in
 * commit 1e5a6cb). This file proves the job's actual runtime behavior
 * once registered:
 *
 *   1. Distributed leader election genuinely serializes concurrent
 *      acquisition attempts for this exact job id (only one "replica"
 *      wins a given tick) -- against the real DistributedJobLock, only
 *      shared/redis.js's getRedis() mocked (same pattern as
 *      job.coordinator.renewal.spec.ts).
 *   2. The full main.ts interval-body shape (tryLead -> try{ sweep }
 *      catch{} finally{ release }) -- replicated exactly here, not
 *      abstracted away -- never rejects/throws, whether tryLead succeeds,
 *      fails to acquire, or the sweep itself throws. This is the concrete
 *      "no unhandled promise rejection" proof: the original bug's failure
 *      mode was tryLead() throwing INSIDE that exact shape, before the
 *      try/catch could ever run.
 *   3. A losing replica can still acquire the lock on the NEXT tick after
 *      the winner releases (no permanent lock leak from the fix).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";

const mockRedis = {
  set:    vi.fn(),
  get:    vi.fn(),
  del:    vi.fn(),
  expire: vi.fn(),
  eval:   vi.fn(),
};
vi.mock("../shared/redis.js", () => ({ getRedis: vi.fn(() => mockRedis) }));

import { JobCoordinator } from "../realtime-infra/job.coordinator.js";
import { getRedis } from "../shared/redis.js";

const getRedisMock = getRedis as Mock;

/** In-memory stand-in for Redis SET NX / GET / DEL / EXPIRE semantics,
 *  shared across "replica" instances so tryLead() genuinely contends for
 *  the same lock, the way two real processes hitting the same Redis
 *  instance would. */
function makeSharedRedisStore() {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      const nx = args.includes("NX");
      if (nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => { const had = store.has(key); store.delete(key); return had ? 1 : 0; }),
    expire: vi.fn(async () => 1),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, leaseId: string) => {
      // Mirrors DistributedJobLock's real release Lua semantics: only
      // delete if the caller still holds the current lease.
      if (store.get(key) === leaseId) { store.delete(key); return 1; }
      return 0;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recovery-stuck-order-sweep — PHASE 3/Task 3: real distributed leader election", () => {
  it("only ONE of two concurrent 'replicas' racing tryLead() for the same tick acquires the lock", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const replicaA = new JobCoordinator();
    const replicaB = new JobCoordinator();
    replicaA.register({ id: "recovery-stuck-order-sweep", ttlSeconds: 100, intervalMs: 120_000, description: "test" });
    replicaB.register({ id: "recovery-stuck-order-sweep", ttlSeconds: 100, intervalMs: 120_000, description: "test" });

    const [wonA, wonB] = await Promise.all([
      replicaA.tryLead("recovery-stuck-order-sweep"),
      replicaB.tryLead("recovery-stuck-order-sweep"),
    ]);

    // Exactly one of the two wins -- real mutual exclusion, not a coincidence
    // of call ordering (Promise.all dispatches both SET NX calls before
    // either resolves, so this genuinely exercises the race).
    expect([wonA, wonB].filter(Boolean)).toHaveLength(1);
  });

  it("a replica that lost the race can acquire the lock on the NEXT tick, once the winner releases", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const replicaA = new JobCoordinator();
    const replicaB = new JobCoordinator();
    replicaA.register({ id: "recovery-stuck-order-sweep", ttlSeconds: 100, intervalMs: 120_000, description: "test" });
    replicaB.register({ id: "recovery-stuck-order-sweep", ttlSeconds: 100, intervalMs: 120_000, description: "test" });

    const wonA = await replicaA.tryLead("recovery-stuck-order-sweep");
    const wonBFirstTry = await replicaB.tryLead("recovery-stuck-order-sweep");
    expect(wonA).toBe(true);
    expect(wonBFirstTry).toBe(false); // A already holds it

    await replicaA.release("recovery-stuck-order-sweep");

    const wonBSecondTry = await replicaB.tryLead("recovery-stuck-order-sweep");
    expect(wonBSecondTry).toBe(true); // now free
  });
});

describe("recovery-stuck-order-sweep — PHASE 3/Task 3: main.ts's exact interval-body shape never rejects", () => {
  // Replicates main.ts's real callback body verbatim (tryLead -> try{ sweep }
  // catch{} finally{ release }) -- this is the exact shape whose tryLead()
  // call used to throw "job ... not registered" before the interval body's
  // own try/catch could run, which is what made it an unhandled rejection.
  async function runIntervalBodyOnce(
    coordinator: JobCoordinator,
    sweep: () => Promise<{ stuckOrdersRejected: number }>,
  ): Promise<{ ran: boolean; error: string | null }> {
    if (!(await coordinator.tryLead("recovery-stuck-order-sweep"))) return { ran: false, error: null };
    try {
      await sweep();
      return { ran: true, error: null };
    } catch (err) {
      return { ran: true, error: (err as Error).message };
    } finally {
      await coordinator.release("recovery-stuck-order-sweep");
    }
  }

  it("resolves cleanly (no throw) on the happy path -- tryLead succeeds, sweep succeeds", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);
    const coordinator = new JobCoordinator();
    coordinator.register({ id: "recovery-stuck-order-sweep", ttlSeconds: 100, intervalMs: 120_000, description: "test" });

    const sweep = vi.fn().mockResolvedValue({ stuckOrdersRejected: 2 });

    await expect(runIntervalBodyOnce(coordinator, sweep)).resolves.toEqual({ ran: true, error: null });
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("resolves cleanly when tryLead() correctly fails to acquire (another replica holds the lock) -- sweep is never called", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);
    // Pre-seed the lock as already held by "another replica".
    await shared.set("job:leader:recovery-stuck-order-sweep", "someone-else", "NX");

    const coordinator = new JobCoordinator();
    coordinator.register({ id: "recovery-stuck-order-sweep", ttlSeconds: 100, intervalMs: 120_000, description: "test" });
    const sweep = vi.fn();

    await expect(runIntervalBodyOnce(coordinator, sweep)).resolves.toEqual({ ran: false, error: null });
    expect(sweep).not.toHaveBeenCalled();
  });

  it("resolves cleanly (caught, not rejected) even when the sweep itself throws -- and still releases the lock", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);
    const coordinator = new JobCoordinator();
    coordinator.register({ id: "recovery-stuck-order-sweep", ttlSeconds: 100, intervalMs: 120_000, description: "test" });

    const sweep = vi.fn().mockRejectedValue(new Error("DB unreachable"));

    await expect(runIntervalBodyOnce(coordinator, sweep)).resolves.toEqual({ ran: true, error: "DB unreachable" });

    // Lock must still be released despite the sweep throwing -- confirmed by
    // being able to re-acquire it immediately.
    const reacquired = await coordinator.tryLead("recovery-stuck-order-sweep");
    expect(reacquired).toBe(true);
  });

  it("REGRESSION GUARD: if this job were ever accidentally unregistered again, tryLead() throws synchronously inside the interval body -- proving why registration must never be dropped", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);
    const coordinator = new JobCoordinator();
    // Deliberately do NOT register "recovery-stuck-order-sweep" -- this
    // reproduces the exact pristine-code bug this whole task closed, at
    // the JobCoordinator level (independent of main.ts's own static
    // registration-completeness check).
    const sweep = vi.fn();

    await expect(runIntervalBodyOnce(coordinator, sweep)).rejects.toThrow(
      'job "recovery-stuck-order-sweep" not registered',
    );
  });
});
