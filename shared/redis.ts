/**
 * shared/redis.ts — Singleton Redis client for the process.
 *
 * All subsystems (rate-limiter, distributed execution queue) share one
 * connection. initRedis() is called once in main.ts before any subsystem
 * that needs it. getRedis() returns null if Redis is unavailable — callers
 * must handle the null case (graceful degradation).
 */

import { Redis } from "ioredis";
import type { ChainableCommander } from "ioredis";

let _client: Redis | null = null;

/**
 * PHASE2_REMEDIATION (H12): a single Redis instance/container is a real
 * single point of failure -- every subsystem it backs (distributed job
 * locks, WS cluster registry, cross-node WS relay, rate limiting) goes
 * down simultaneously, across every worker, the instant it does. This
 * repo's docker-compose.prod.yml deploy path had no replica/Sentinel at
 * all (unlike the Kubernetes self-hosted path, which already uses Redis
 * Cluster's built-in automatic failover, and the Terraform/ElastiCache
 * path, which already has automatic_failover_enabled=true/multi_az_enabled
 * =true) -- see that file's Redis Sentinel service definitions for the
 * infra half of this fix. This type lets the app actually consume a
 * Sentinel-monitored topology (host:port pairs discovered/promoted by
 * Sentinel, not a fixed host the app would otherwise keep talking to
 * after a failover moves the primary elsewhere) instead of only ever
 * supporting a single fixed connection string.
 */
export type RedisConnectTarget =
  | string
  | { sentinels: Array<{ host: string; port: number }>; name: string; password?: string };

/** Connect and store the singleton. Throws if the server is unreachable. */
export async function initRedis(target: RedisConnectTarget): Promise<Redis> {
  const baseOptions = {
    lazyConnect:          true,
    enableOfflineQueue:   false,
    maxRetriesPerRequest: 1,
    connectTimeout:       3_000,
  } as const;

  const client =
    typeof target === "string"
      ? new Redis(target, baseOptions)
      : new Redis({
          sentinels: target.sentinels,
          name:      target.name,
          password:  target.password,
          ...baseOptions,
        });

  await client.connect();
  _client = client;
  void _warnIfEvictionUnsafe(client);
  return client;
}

/**
 * PHASE2_REMEDIATION (H12): builds the connect target for initRedis() from
 * environment variables -- Sentinel-monitored mode when REDIS_SENTINELS is
 * set (format: "host1:port1,host2:port2,host3:port3", as configured for
 * docker-compose.prod.yml's sentinel containers), otherwise the existing
 * single-URL mode (REDIS_URL / a supplied default). Kept separate from
 * initRedis() itself so the parsing logic has its own unit coverage
 * without needing a live/mocked Redis connection.
 */
export function resolveRedisTarget(env: NodeJS.ProcessEnv, defaultUrl: string): RedisConnectTarget {
  const sentinelsRaw = env.REDIS_SENTINELS;
  if (!sentinelsRaw) return env.REDIS_URL ?? defaultUrl;

  const sentinels = sentinelsRaw.split(",").map((entry) => {
    const [host, port] = entry.trim().split(":");
    return { host, port: Number(port) };
  });

  return {
    sentinels,
    name:     env.REDIS_SENTINEL_NAME ?? "igfxpro-redis",
    password: env.REDIS_PASSWORD,
  };
}

/**
 * PHASE2_REMEDIATION (H11): defense-in-depth startup check. This process's
 * Redis instance is shared by both genuinely-evictable cache data
 * (realtime-infra/cache.layer.ts) and correctness-critical mutual-exclusion
 * locks (shared/distributed.job.lock.ts's `job:leader:*`,
 * realtime-infra/websocket.cluster.ts's node registry) -- an `allkeys-*`
 * eviction policy lets Redis evict a lock key under memory pressure
 * exactly as if it had naturally expired, letting a second worker acquire
 * the same lock with no error anywhere (silent double-execution of a
 * scheduled job, not a visible incident). All three deploy surfaces
 * (docker-compose.prod.yml, infrastructure/kubernetes/redis/
 * redis-cluster.yaml, infrastructure/terraform/modules/elasticache/
 * main.tf) were fixed to `noeviction`, but three separately-maintained IaC
 * files can drift out of sync with each other or with a manually-managed
 * Redis instance -- this check makes that drift loud (a startup log
 * warning) instead of silently reintroducing the bug in whichever
 * environment falls out of sync. Deliberately non-fatal: some managed
 * Redis providers restrict the CONFIG command entirely, and this must not
 * prevent the app from starting against a Redis it can't introspect.
 */
async function _warnIfEvictionUnsafe(client: Redis): Promise<void> {
  try {
    const [, policy] = (await client.config("GET", "maxmemory-policy")) as [string, string];
    if (policy && policy !== "noeviction") {
      console.warn(
        `[redis] UNSAFE maxmemory-policy="${policy}" -- distributed lock keys ` +
        `(job:leader:*, ws cluster registry) can be silently evicted under memory ` +
        `pressure, indistinguishable from natural TTL expiry. Set "noeviction" on ` +
        `this Redis instance (see docker-compose.prod.yml / infrastructure/kubernetes/` +
        `redis/redis-cluster.yaml / infrastructure/terraform/modules/elasticache/main.tf).`,
      );
    }
  } catch {
    // CONFIG command unavailable/restricted (common on managed Redis) —
    // non-fatal, this check is best-effort defense-in-depth only.
  }
}

/** Return the connected client, or null if initRedis was never called / failed. */
export function getRedis(): Redis | null {
  return _client;
}

/**
 * Execute multiple Redis commands in a single network round-trip.
 * Returns null if Redis is not available (graceful degradation).
 *
 * Usage:
 *   await redisPipeline((p) => {
 *     p.set("key", "val");
 *     p.incr("counter");
 *   });
 */
export async function redisPipeline(
  fn: (pipeline: ChainableCommander) => void,
): Promise<Array<[Error | null, unknown]> | null> {
  if (!_client) return null;
  const pipeline = _client.pipeline();
  fn(pipeline);
  return pipeline.exec() as Promise<Array<[Error | null, unknown]>>;
}

/**
 * Batch GET multiple keys in one round-trip. Returns an array of string|null
 * aligned with the input keys array. Returns [] if Redis is unavailable.
 */
export async function redisMget(keys: string[]): Promise<Array<string | null>> {
  if (!_client || keys.length === 0) return keys.map(() => null);
  return _client.mget(...keys).catch(() => keys.map(() => null));
}

export async function disconnectRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}
