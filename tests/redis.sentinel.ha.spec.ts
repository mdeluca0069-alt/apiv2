/**
 * redis.sentinel.ha.spec.ts
 *
 * PHASE2_REMEDIATION (H12): a single Redis instance is a single point of
 * failure -- every subsystem it backs (shared/distributed.job.lock.ts's
 * job-coordination locks, realtime-infra/websocket.cluster.ts's node
 * registry, realtime-infra/redis.pubsub.ts's cross-node WS relay, rate
 * limiting) goes down simultaneously across every worker the instant it
 * dies. docker-compose.prod.yml's Redis service was a single container
 * with only `restart: always` (no replica, no failover target if the host
 * itself goes down) -- unlike this workload's other two deploy paths
 * (Kubernetes Redis Cluster mode, Terraform/ElastiCache with
 * automatic_failover_enabled=true/multi_az_enabled=true), which already
 * have real HA and needed no change. docker-compose.prod.yml gained a
 * replica + 3-node Sentinel quorum; this file proves the APPLICATION half
 * of that fix -- shared/redis.ts can actually consume a Sentinel-monitored
 * topology (auto-discovering/following the current primary across a
 * failover) instead of only ever supporting one fixed connection string
 * that a failover would silently strand it on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockConnect, mockRedisCtor } = vi.hoisted(() => {
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockConfig  = vi.fn().mockResolvedValue(["maxmemory-policy", "noeviction"]);
  const mockQuit    = vi.fn().mockResolvedValue(undefined);
  const mockRedisCtor = vi.fn((..._args: unknown[]) => ({ connect: mockConnect, config: mockConfig, quit: mockQuit }));
  return { mockConnect, mockRedisCtor };
});

vi.mock("ioredis", () => ({ Redis: mockRedisCtor }));

const { initRedis, disconnectRedis, resolveRedisTarget } = await import("../shared/redis.js");

beforeEach(() => vi.clearAllMocks());
afterEach(async () => { await disconnectRedis(); });

describe("resolveRedisTarget() — PHASE2_REMEDIATION (H12)", () => {
  it("falls back to the plain single-URL mode when REDIS_SENTINELS is unset (dev / docker-compose.yml)", () => {
    const target = resolveRedisTarget({ REDIS_URL: "redis://myhost:6379" }, "redis://localhost:6379");
    expect(target).toBe("redis://myhost:6379");
  });

  it("falls back to the supplied default URL when neither REDIS_URL nor REDIS_SENTINELS is set", () => {
    const target = resolveRedisTarget({}, "redis://localhost:6379");
    expect(target).toBe("redis://localhost:6379");
  });

  it("parses REDIS_SENTINELS into a sentinels array, taking priority over REDIS_URL", () => {
    const target = resolveRedisTarget(
      {
        REDIS_URL:           "redis://:pw@redis:6379",
        REDIS_SENTINELS:     "sentinel-1:26379,sentinel-2:26379,sentinel-3:26379",
        REDIS_SENTINEL_NAME: "igfxpro-redis",
        REDIS_PASSWORD:      "supersecret",
      },
      "redis://localhost:6379",
    );

    expect(target).toEqual({
      sentinels: [
        { host: "sentinel-1", port: 26379 },
        { host: "sentinel-2", port: 26379 },
        { host: "sentinel-3", port: 26379 },
      ],
      name:     "igfxpro-redis",
      password: "supersecret",
    });
  });

  it("defaults the sentinel master name to igfxpro-redis when REDIS_SENTINEL_NAME is unset", () => {
    const target = resolveRedisTarget({ REDIS_SENTINELS: "s1:26379" }, "redis://localhost:6379");
    expect(target).toMatchObject({ name: "igfxpro-redis" });
  });

  it("tolerates whitespace around comma-separated sentinel entries", () => {
    const target = resolveRedisTarget({ REDIS_SENTINELS: " s1:26379 , s2:26379 " }, "redis://localhost:6379");
    expect(target).toMatchObject({
      sentinels: [{ host: "s1", port: 26379 }, { host: "s2", port: 26379 }],
    });
  });
});

describe("initRedis() — PHASE2_REMEDIATION (H12): Sentinel-mode connection", () => {
  it("constructs the ioredis client with { sentinels, name, password } when given a Sentinel target, not a plain URL", async () => {
    const target = {
      sentinels: [{ host: "sentinel-1", port: 26379 }, { host: "sentinel-2", port: 26379 }],
      name:      "igfxpro-redis",
      password:  "supersecret",
    };

    await initRedis(target);

    expect(mockRedisCtor).toHaveBeenCalledTimes(1);
    const [ctorArg] = mockRedisCtor.mock.calls[0]!;
    expect(ctorArg).toMatchObject({
      sentinels: target.sentinels,
      name:      "igfxpro-redis",
      password:  "supersecret",
    });
  });

  it("still constructs the client with a plain URL string when given the original single-URL target shape", async () => {
    await initRedis("redis://localhost:6379");

    expect(mockRedisCtor).toHaveBeenCalledTimes(1);
    const [urlArg, optsArg] = mockRedisCtor.mock.calls[0]!;
    expect(urlArg).toBe("redis://localhost:6379");
    expect(optsArg).toMatchObject({ lazyConnect: true, enableOfflineQueue: false });
  });

  it("connects successfully via Sentinel mode end-to-end (resolveRedisTarget -> initRedis)", async () => {
    const target = resolveRedisTarget(
      { REDIS_SENTINELS: "sentinel-1:26379,sentinel-2:26379,sentinel-3:26379", REDIS_PASSWORD: "pw" },
      "redis://localhost:6379",
    );
    const client = await initRedis(target);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(client).toBeTruthy();
  });
});
