/**
 * redis.eviction.policy.guard.spec.ts
 *
 * PHASE2_REMEDIATION (H11): allkeys-lru let Redis evict ANY key under
 * memory pressure -- including shared/distributed.job.lock.ts's
 * `job:leader:*` mutual-exclusion locks and realtime-infra/
 * websocket.cluster.ts's node-registry keys. An evicted lock is
 * indistinguishable from natural TTL expiry to its holder, so a second
 * worker's `SET NX` could succeed and double-run a scheduled job with no
 * error anywhere. All three IaC deploy surfaces (docker-compose.prod.yml,
 * infrastructure/kubernetes/redis/redis-cluster.yaml, infrastructure/
 * terraform/modules/elasticache/main.tf) were changed to `noeviction`, but
 * since those are three independently-maintained files (or a manually
 * managed Redis instance in some environments), initRedis() now does a
 * best-effort startup check and logs a loud warning if the CONNECTED
 * instance's actual maxmemory-policy isn't noeviction -- catching drift
 * between the IaC and the real running Redis instead of only trusting the
 * config files to stay in sync forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockConfig   = vi.fn();
const mockQuit     = vi.fn().mockResolvedValue(undefined);
const mockRedisCtor = vi.fn(() => ({
  connect: mockConnect,
  config:  mockConfig,
  quit:    mockQuit,
}));

vi.mock("ioredis", () => ({ Redis: mockRedisCtor }));

const { initRedis, disconnectRedis } = await import("../shared/redis.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
});

afterEach(async () => {
  await disconnectRedis();
});

describe("initRedis() — PHASE2_REMEDIATION (H11): eviction-policy startup guard", () => {
  it("logs a loud warning when the connected Redis instance's maxmemory-policy is allkeys-lru", async () => {
    mockConfig.mockResolvedValue(["maxmemory-policy", "allkeys-lru"]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await initRedis("redis://localhost:6379");
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('UNSAFE maxmemory-policy="allkeys-lru"'));
    warnSpy.mockRestore();
  });

  it("does NOT warn when the policy is correctly set to noeviction", async () => {
    mockConfig.mockResolvedValue(["maxmemory-policy", "noeviction"]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await initRedis("redis://localhost:6379");
    await mockConfig.mock.results[0]?.value; // let the async check settle

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not throw, and does not crash startup, when CONFIG is unavailable/restricted (e.g. some managed Redis providers)", async () => {
    mockConfig.mockRejectedValue(new Error("ERR unknown command 'CONFIG'"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(initRedis("redis://localhost:6379")).resolves.toBeTruthy();
    // Give the un-awaited background check a tick to settle without throwing.
    await new Promise((r) => setTimeout(r, 10));

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("UNSAFE"));
    warnSpy.mockRestore();
  });

  it("also flags other unsafe eviction-all policies (e.g. allkeys-lfu, allkeys-random), not just allkeys-lru", async () => {
    mockConfig.mockResolvedValue(["maxmemory-policy", "allkeys-random"]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await initRedis("redis://localhost:6379");
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('maxmemory-policy="allkeys-random"'));
    warnSpy.mockRestore();
  });
});
