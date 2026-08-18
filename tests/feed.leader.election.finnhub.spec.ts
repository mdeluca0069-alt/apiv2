/**
 * feed.leader.election.finnhub.spec.ts
 *
 * STAGING ONLY — market-data/feed.leader.election.ts is NOT modified by
 * the Finnhub work (FeedLeaderElection already accepted `jobId` as its
 * first constructor parameter before this change). This file proves the
 * class's existing, unmodified guarantees hold identically for a second,
 * independent job id ("market-data-finnhub" — see main.ts), mirroring
 * feed.leader.election.spec.ts's exact scenarios:
 *   1. only one replica becomes Finnhub leader
 *   2. failover to another replica after a clean release
 *   3. failover to another replica after an unclean crash (lease expiry)
 *   4. reconnects/repeated polling never grow the leader count beyond one
 *   5. NEW: a "market-data-finnhub" election and a "market-data-twelvedata-
 *      leader" election running concurrently against the SAME shared Redis
 *      store never collide — each can independently have its own leader,
 *      proving the two lease keys are genuinely separate (no shared lock).
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

const FINNHUB_JOB_ID = "market-data-finnhub";

/** Same in-memory Redis stand-in as feed.leader.election.spec.ts. */
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

describe("FeedLeaderElection(\"market-data-finnhub\") — exactly one leader", () => {
  it("only ONE of three concurrent 'replicas' racing for Finnhub leadership acquires it", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const replicaA = new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10);
    const replicaB = new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10);
    const replicaC = new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10);

    const becameLeader = [vi.fn(), vi.fn(), vi.fn()];
    replicaA.start({ onBecomeLeader: becameLeader[0], onLoseLeadership: vi.fn() });
    replicaB.start({ onBecomeLeader: becameLeader[1], onLoseLeadership: vi.fn() });
    replicaC.start({ onBecomeLeader: becameLeader[2], onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const leaderCount = [replicaA, replicaB, replicaC].filter((r) => r.isCurrentLeader()).length;
    expect(leaderCount).toBe(1);
    expect(becameLeader.reduce((n, fn) => n + fn.mock.calls.length, 0)).toBe(1);

    await replicaA.stop();
    await replicaB.stop();
    await replicaC.stop();
  });

  it("REGRESSION GUARD: repeated polling/reconnect ticks never grow the Finnhub leader count beyond one", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const replicas = [
      new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10),
      new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10),
      new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10),
    ];
    for (const r of replicas) r.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      const leaderCount = replicas.filter((r) => r.isCurrentLeader()).length;
      expect(leaderCount).toBeLessThanOrEqual(1);
    }

    for (const r of replicas) await r.stop();
  });
});

describe("FeedLeaderElection(\"market-data-finnhub\") — failover", () => {
  it("a follower replica takes over once the Finnhub leader releases cleanly (graceful shutdown)", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const replicaA = new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10);
    const replicaB = new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10);
    const becameLeaderB = vi.fn();

    replicaA.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(replicaA.isCurrentLeader()).toBe(true);

    replicaB.start({ onBecomeLeader: becameLeaderB, onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(replicaB.isCurrentLeader()).toBe(false); // A already holds it — B is a follower

    await replicaA.stop(); // clean release

    await vi.advanceTimersByTimeAsync(10_000);
    expect(replicaB.isCurrentLeader()).toBe(true);
    expect(becameLeaderB).toHaveBeenCalledTimes(1);

    await replicaB.stop();
  });

  it("a follower replica takes over once the Finnhub leader's lease expires WITHOUT a clean release (crash/kill)", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const replicaA = new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10);
    const replicaB = new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10);

    replicaA.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(replicaA.isCurrentLeader()).toBe(true);

    replicaB.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);

    // Model the leader's process dying outright — no stop(), no release.
    shared.__forceExpire(`job:leader:${FINNHUB_JOB_ID}`);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(replicaB.isCurrentLeader()).toBe(true);

    await replicaB.stop();
  });

  it("no two Finnhub leaders are ever simultaneously current after a takeover (single-leader invariant across the transition)", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const replicaA = new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10);
    const replicaB = new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10);
    const lostLeadership = vi.fn();

    replicaA.start({ onBecomeLeader: vi.fn(), onLoseLeadership: lostLeadership });
    replicaB.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);

    await replicaA.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(replicaA.isCurrentLeader()).toBe(false);
    const leaderCount = [replicaA, replicaB].filter((r) => r.isCurrentLeader()).length;
    expect(leaderCount).toBeLessThanOrEqual(1);

    await replicaB.stop();
  });
});

describe("FeedLeaderElection — TwelveData and Finnhub elections never collide (separate jobId, same Redis store)", () => {
  it("each job id gets its own independent leader when raced concurrently against the same shared store", async () => {
    const shared = makeSharedRedisStore();
    getRedisMock.mockReturnValue(shared);

    const twelvedataA = new FeedLeaderElection(FEED_LEADER_JOB_ID, 30, 10, 10);
    const twelvedataB = new FeedLeaderElection(FEED_LEADER_JOB_ID, 30, 10, 10);
    const finnhubA     = new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10);
    const finnhubB     = new FeedLeaderElection(FINNHUB_JOB_ID, 30, 10, 10);

    twelvedataA.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    twelvedataB.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    finnhubA.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    finnhubB.start({ onBecomeLeader: vi.fn(), onLoseLeadership: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Exactly one TwelveData leader AND exactly one (independent) Finnhub
    // leader — the two job families never contend for the same lock.
    const twelvedataLeaders = [twelvedataA, twelvedataB].filter((r) => r.isCurrentLeader()).length;
    const finnhubLeaders    = [finnhubA, finnhubB].filter((r) => r.isCurrentLeader()).length;
    expect(twelvedataLeaders).toBe(1);
    expect(finnhubLeaders).toBe(1);

    // Underlying Redis keys are genuinely distinct.
    expect(shared.set).toHaveBeenCalledWith(
      `job:leader:${FEED_LEADER_JOB_ID}`, expect.any(String), "EX", 30, "NX",
    );
    expect(shared.set).toHaveBeenCalledWith(
      `job:leader:${FINNHUB_JOB_ID}`, expect.any(String), "EX", 30, "NX",
    );

    // Losing Finnhub leadership must not affect the TwelveData leader.
    const finnhubLeader = [finnhubA, finnhubB].find((r) => r.isCurrentLeader())!;
    await finnhubLeader.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect([twelvedataA, twelvedataB].filter((r) => r.isCurrentLeader()).length).toBe(1);

    await twelvedataA.stop();
    await twelvedataB.stop();
    await finnhubA.stop();
    await finnhubB.stop();
  });
});
