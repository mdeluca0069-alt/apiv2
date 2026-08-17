/**
 * feed.leader.election.spec.ts
 *
 * MULTI-REPLICA TWELVEDATA REMEDIATION — regression coverage for
 * market-data/feed.leader.election.ts, against a real DistributedJobLock
 * with only shared/redis.js's getRedis() mocked (same pattern as
 * tests/recovery.stuck.order.sweep.job.concurrency.spec.ts, whose shared
 * in-memory Redis store this file reuses so leader election genuinely
 * contends for the same lock, the way two real replicas hitting the same
 * Redis instance would).
 *
 * Covers all six scenarios this remediation was required to prove:
 *   1. only one replica can become TwelveData WS leader
 *   2. another replica can take leadership after leader loss
 *   3. followers do not open TwelveData WebSockets (feed.manager.primary.gating.spec.ts)
 *   4. market-data events propagate correctly through Redis (relay.tick.applier.spec.ts)
 *   5. reconnects do not create multiple concurrent leaders (this file, "no double leader")
 *   6. stale-data/health behavior remains correct (relay.tick.applier.spec.ts)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";

const mockRedis = {
  set:    vi.fn(),
  get:    vi.fn(),
  del:    vi.fn(),
  expire: vi.fn(),
  eval:   vi.fn(),
};
vi.mock("../shared/redis.js", () => ({ getRedis: vi.fn(() => mockRedis) }));

import { FeedLeaderElection, FEED_LEADER_JOB_ID } from "../market-data/feed.leader.election.js";
import { getRedis } from "../shared/redis.js";

const getRedisMock = getRedis as Mock;

/** Shared in-memory Redis stand-in — same semantics as the real
 *  SET NX EX / GET / DEL / EXPIRE / Lua-release DistributedJobLock uses,
 *  so two FeedLeaderElection instances pointed at the same store genuinely
 *  race for the same key. */
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
      if (store.get(key) === leaseId) { store.delete(key); return 1; }
      return 0;
    }),
    // Test-only helper — simulates the lease expiring without a clean
    // release (e.g. the leader process crashed).
    __forceExpire(key: string) { store.delete(key); },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FeedLeaderElection — exactly one leader", () => {
  it("only ONE of two concurrent 'replicas' racing for leadership acquires it", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const replicaA = new FeedLeaderElection(FEED_LEADER_JOB_ID, 30, 10, 10);
    const replicaB = new FeedLeaderElection(FEED_LEADER_JOB_ID, 30, 10, 10);

    const becameLeaderA = vi.fn();
    const becameLeaderB = vi.fn();

    // Both attempt to become leader in the same tick — Promise.all-style
    // race, dispatching both SET NX calls before either resolves.
    replicaA.start({ onBecomeLeader: becameLeaderA, onLoseLeadership: vi.fn() });
    replicaB.start({ onBecomeLeader: becameLeaderB, onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0); // let the initial _tick()'s microtasks settle

    const leaderCount = [replicaA.isCurrentLeader(), replicaB.isCurrentLeader()].filter(Boolean).length;
    expect(leaderCount).toBe(1);

    const becameLeaderCount = becameLeaderA.mock.calls.length + becameLeaderB.mock.calls.length;
    expect(becameLeaderCount).toBe(1);

    await replicaA.stop();
    await replicaB.stop();
  });

  it("REGRESSION GUARD (reconnects do not create multiple concurrent leaders): repeated polling ticks never grow the leader count beyond one", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const replicaA = new FeedLeaderElection(FEED_LEADER_JOB_ID, 30, 10, 10);
    const replicaB = new FeedLeaderElection(FEED_LEADER_JOB_ID, 30, 10, 10);
    const replicaC = new FeedLeaderElection(FEED_LEADER_JOB_ID, 30, 10, 10);

    replicaA.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    replicaB.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    replicaC.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);

    // Simulate many poll cycles (each replica's own "reconnect attempt"
    // equivalent — a non-leader retrying tryAcquire() repeatedly).
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      const leaderCount = [replicaA, replicaB, replicaC].filter((r) => r.isCurrentLeader()).length;
      expect(leaderCount).toBeLessThanOrEqual(1);
    }

    await replicaA.stop();
    await replicaB.stop();
    await replicaC.stop();
  });
});

describe("FeedLeaderElection — failover", () => {
  it("a non-leader replica takes over once the leader releases cleanly (graceful shutdown)", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const replicaA = new FeedLeaderElection(FEED_LEADER_JOB_ID, 30, 10, 10);
    const replicaB = new FeedLeaderElection(FEED_LEADER_JOB_ID, 30, 10, 10);
    const becameLeaderB = vi.fn();

    replicaA.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(replicaA.isCurrentLeader()).toBe(true);

    replicaB.start({ onBecomeLeader: becameLeaderB, onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(replicaB.isCurrentLeader()).toBe(false); // A already holds it

    await replicaA.stop(); // clean release — frees the lease immediately

    await vi.advanceTimersByTimeAsync(10_000); // replicaB's next poll tick
    expect(replicaB.isCurrentLeader()).toBe(true);
    expect(becameLeaderB).toHaveBeenCalledTimes(1);

    await replicaB.stop();
  });

  it("a non-leader replica takes over once the leader's lease expires WITHOUT a clean release (crash/kill)", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const replicaA = new FeedLeaderElection(FEED_LEADER_JOB_ID, 30, 10, 10);
    const replicaB = new FeedLeaderElection(FEED_LEADER_JOB_ID, 30, 10, 10);

    replicaA.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(replicaA.isCurrentLeader()).toBe(true);

    replicaB.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);

    // Simulate replicaA's process dying outright — no stop(), no release,
    // its renewal interval simply stops firing in reality. Here we
    // directly force the lease to expire to model that outcome without
    // needing to also freeze replicaA's own (now-irrelevant) timers.
    shared.__forceExpire(`job:leader:${FEED_LEADER_JOB_ID}`);

    await vi.advanceTimersByTimeAsync(10_000); // replicaB's next poll tick
    expect(replicaB.isCurrentLeader()).toBe(true);

    await replicaB.stop();
  });

  it("the demoted leader calls onLoseLeadership exactly once when it discovers it no longer holds the lease", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const replicaA = new FeedLeaderElection(FEED_LEADER_JOB_ID, 30, 10, 10);
    const lostLeadership = vi.fn();

    replicaA.start({ onBecomeLeader: vi.fn(), onLoseLeadership: lostLeadership });
    await vi.advanceTimersByTimeAsync(0);
    expect(replicaA.isCurrentLeader()).toBe(true);

    // Someone else force-took the key underneath replicaA (models a bug
    // elsewhere, or a clock/TTL edge case) — replicaA's own next ownership
    // check must notice and demote itself rather than keep believing it's
    // still leader.
    shared.__forceExpire(`job:leader:${FEED_LEADER_JOB_ID}`);
    await shared.set(`job:leader:${FEED_LEADER_JOB_ID}`, "someone-else-entirely", "NX");

    await vi.advanceTimersByTimeAsync(10_000);

    expect(replicaA.isCurrentLeader()).toBe(false);
    expect(lostLeadership).toHaveBeenCalledTimes(1);

    await replicaA.stop();
  });
});
