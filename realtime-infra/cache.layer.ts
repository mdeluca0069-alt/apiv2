/**
 * Distributed Cache Layer — L1 (in-process) + L2 (Redis).
 *
 * Read path:
 *   1. L1 check (Map<key, {value, expiresAt}>) — sub-millisecond
 *   2. L2 check (Redis GET)                    — ~0.5ms
 *   3. Fetcher call (DB / external API)        — variable
 *   Stores the result in both L1 and L2 before returning.
 *
 * Invalidation:
 *   del(key) / flush(prefix?) removes from L1 immediately and from Redis.
 *   It also publishes to igfx:cache:invalidate so other nodes clear their L1.
 *
 * L1 eviction:
 *   The L1 store is bounded to MAX_L1_ENTRIES. Expired entries are lazily
 *   evicted on read. A background sweep runs every 60 s to clear stale entries
 *   and prevent unbounded Map growth in long-running processes.
 *
 * Graceful degradation:
 *   When Redis is unavailable, L2 is skipped. L1 still caches within the node.
 *   Invalidation messages from other nodes won't arrive, but TTLs bound staleness.
 */

import { getRedis } from "../shared/redis.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const INVALIDATE_CHANNEL = "igfx:cache:invalidate";
const REDIS_KEY          = (key: string) => `igfx:cache:${key}`;
const MAX_L1_ENTRIES     = 10_000;
const L1_SWEEP_MS        = 60_000;

// ── Types ─────────────────────────────────────────────────────────────────────
type L1Entry = { value: unknown; expiresAt: number };

export type CacheStats = {
  l1Size:    number;
  l1Hits:    number;
  l2Hits:    number;
  misses:    number;
  fetches:   number;
  sets:      number;
  deletes:   number;
  hitRate:   number;
};

// ─────────────────────────────────────────────────────────────────────────────

class DistributedCache {
  private readonly l1 = new Map<string, L1Entry>();
  private sweepTimer: NodeJS.Timeout | null = null;

  // Stats counters
  private _l1Hits  = 0;
  private _l2Hits  = 0;
  private _misses  = 0;
  private _fetches = 0;
  private _sets    = 0;
  private _deletes = 0;

  /**
   * Start the background L1 sweep and subscribe to cross-node invalidations.
   * Call once at startup after Redis is available.
   */
  async start(): Promise<void> {
    this.sweepTimer = setInterval(() => this._sweepL1(), L1_SWEEP_MS);

    const redis = getRedis();
    if (!redis) return;

    // Separate subscriber connection — Redis SUBscribe connections cannot issue
    // any other commands (GET, SET, PUBLISH, etc.).
    const sub = redis.duplicate();
    sub.on("error", () => { /* non-fatal */ });
    // PRODUCTION CUTOVER Stage 3 — see control.channel.ts / redis.pubsub.ts:
    // duplicate() inherits lazyConnect:true from the base client, so the
    // socket must be explicitly connected before subscribe() can succeed
    // (enableOfflineQueue is false, so a pre-connect subscribe fails
    // instantly instead of queuing) -- this silently disabled cross-node L1
    // cache invalidation on every boot.
    await sub.connect().catch(() => {});
    await sub.subscribe(INVALIDATE_CHANNEL).catch(() => {});

    sub.on("message", (_ch: string, raw: string) => {
      // raw is the key (or "prefix:*" for prefix-based invalidation)
      if (raw.endsWith(":*")) {
        const prefix = raw.slice(0, -2);
        for (const key of this.l1.keys()) {
          if (key.startsWith(prefix)) this.l1.delete(key);
        }
      } else {
        this.l1.delete(raw);
      }
    });
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Get a cached value, fetching and caching it if absent.
   *
   * @param key       Cache key (scoped to this cache namespace)
   * @param ttlMs     Time-to-live in milliseconds
   * @param fetcher   Called on cache miss; result is stored in L1 + L2
   */
  async get<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    // ── L1 ──────────────────────────────────────────────────────────────────
    const l1Entry = this.l1.get(key);
    if (l1Entry && l1Entry.expiresAt > Date.now()) {
      this._l1Hits++;
      return l1Entry.value as T;
    }
    if (l1Entry) this.l1.delete(key); // expired entry

    // ── L2 (Redis) ──────────────────────────────────────────────────────────
    const redis = getRedis();
    if (redis) {
      try {
        const raw = await redis.get(REDIS_KEY(key));
        if (raw !== null) {
          const value = JSON.parse(raw) as T;
          this._setL1(key, value, ttlMs);
          this._l2Hits++;
          return value;
        }
      } catch { /* Redis blip — fall through to fetcher */ }
    }

    // ── Fetcher ──────────────────────────────────────────────────────────────
    this._misses++;
    this._fetches++;
    const value = await fetcher();
    await this.set(key, value, ttlMs);
    return value;
  }

  /** Write a value to L1 + L2 without checking for an existing entry. */
  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    this._sets++;
    this._setL1(key, value, ttlMs);

    const redis = getRedis();
    if (redis) {
      const ttlSeconds = Math.ceil(ttlMs / 1_000);
      try {
        await redis.setex(REDIS_KEY(key), ttlSeconds, JSON.stringify(value));
      } catch { /* non-fatal — L1 still cached */ }
    }
  }

  /** Remove a key from L1 + L2 and notify other nodes to evict their L1. */
  async del(key: string): Promise<void> {
    this._deletes++;
    this.l1.delete(key);
    const redis = getRedis();
    if (redis) {
      try {
        await redis.del(REDIS_KEY(key));
        await redis.publish(INVALIDATE_CHANNEL, key);
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Flush all keys matching a prefix from L1 + L2.
   * Notifies other nodes via the invalidation channel.
   */
  async flush(prefix?: string): Promise<void> {
    if (!prefix) {
      this.l1.clear();
    } else {
      for (const key of this.l1.keys()) {
        if (key.startsWith(prefix)) this.l1.delete(key);
      }
    }

    const redis = getRedis();
    if (!redis) return;

    try {
      if (!prefix) {
        // Flush all igfx:cache:* keys with SCAN (non-blocking)
        let cursor = "0";
        do {
          const [next, keys] = await redis.scan(cursor, "MATCH", "igfx:cache:*", "COUNT", "200");
          cursor = next;
          if (keys.length) await redis.del(...keys);
        } while (cursor !== "0");
        await redis.publish(INVALIDATE_CHANNEL, "*:*");
      } else {
        let cursor = "0";
        do {
          const [next, keys] = await redis.scan(cursor, "MATCH", `igfx:cache:${prefix}*`, "COUNT", "200");
          cursor = next;
          if (keys.length) await redis.del(...keys);
        } while (cursor !== "0");
        await redis.publish(INVALIDATE_CHANNEL, `${prefix}:*`);
      }
    } catch { /* non-fatal */ }
  }

  /** Cache statistics for admin monitoring. */
  getStats(): CacheStats {
    const total = this._l1Hits + this._l2Hits + this._misses;
    return {
      l1Size:  this.l1.size,
      l1Hits:  this._l1Hits,
      l2Hits:  this._l2Hits,
      misses:  this._misses,
      fetches: this._fetches,
      sets:    this._sets,
      deletes: this._deletes,
      hitRate: total > 0 ? Math.round(((this._l1Hits + this._l2Hits) / total) * 1_000) / 10 : 0,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _setL1(key: string, value: unknown, ttlMs: number): void {
    if (this.l1.size >= MAX_L1_ENTRIES) {
      // Evict the oldest entry (first key in insertion order)
      const oldest = this.l1.keys().next().value;
      if (oldest !== undefined) this.l1.delete(oldest);
    }
    this.l1.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  private _sweepL1(): void {
    const now = Date.now();
    for (const [key, entry] of this.l1.entries()) {
      if (entry.expiresAt <= now) this.l1.delete(key);
    }
  }
}

export const distributedCache = new DistributedCache();
export default distributedCache;
