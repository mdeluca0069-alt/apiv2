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

/** Connect and store the singleton. Throws if the server is unreachable. */
export async function initRedis(url: string): Promise<Redis> {
  const client = new Redis(url, {
    lazyConnect:          true,
    enableOfflineQueue:   false,
    maxRetriesPerRequest: 1,
    connectTimeout:       3_000,
  });
  await client.connect();
  _client = client;
  return client;
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
