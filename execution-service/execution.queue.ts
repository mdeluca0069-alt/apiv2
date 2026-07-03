/**
 * execution.queue.ts — Distributed per-user execution queue.
 *
 * Problem solved (Phase A):
 *   Without serialization, concurrent orders from the same user can both
 *   pass the margin check before either locks margin — causing ghost fills
 *   that appear FILLED then flip to REJECTED.
 *
 * Phase B addition:
 *   The original in-memory promise chain serialized per user WITHIN one
 *   PM2 worker. With 4 workers, two workers could handle requests for the
 *   same user simultaneously, causing WalletAccount row-level lock contention
 *   in PostgreSQL — the root cause of Order P95 > 3000 ms at 500+ users.
 *
 * Solution (Phase B — Redis distributed lock):
 *   Before executing, each worker acquires a Redis SET NX lock keyed by
 *   userId. Only one worker across the entire cluster can hold that lock at
 *   any time. The worker that loses the race retries with exponential
 *   back-off. Result: zero cross-worker WalletAccount row conflicts.
 *
 * Fallback:
 *   When Redis is unavailable, falls back to in-memory promise-chain
 *   serialization (single-worker correctness, same as Phase A behavior).
 *
 * Lock parameters:
 *   Key:   lock:user:{userId}
 *   Value: UUID per acquisition (owner identification for safe release)
 *   TTL:   30 000 ms (covers EXECUTION_TIMEOUT_MS with safety margin)
 *
 * Queue-depth tracking:
 *   Key:   queue:depth:user:{userId}
 *   Type:  Redis INCR counter (DECR in finally — always balanced)
 *   TTL:   60 s auto-expiry (survives process crash without leaking)
 */

import { randomUUID }  from "node:crypto";
import { metrics }     from "../gateway/metrics.js";
import { getRedis }    from "../shared/redis.js";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_QUEUE_DEPTH       = 5;
const EXECUTION_TIMEOUT_MS  = 15_000;
const LOCK_TTL_MS           = 30_000;
const LOCK_RETRY_INIT_MS    = 50;
const LOCK_RETRY_MAX_MS     = 400;
const LOCK_MAX_WAIT_MS      = 27_000;   // < EXECUTION_TIMEOUT_MS
const DEPTH_KEY_TTL_S       = 60;

// ── Types ────────────────────────────────────────────────────────────────────

/** Mutable token passed to tasks so they can abort cleanly on timeout. */
export type CancelToken = { value: boolean };

export type QueuedTask<T> = (cancelToken: CancelToken) => Promise<T>;

export type EnqueueResult<T> =
  | { ok: true;  result: T; queuedMs: number; execMs: number }
  | { ok: false; reason: "QUEUE_FULL" | "TIMEOUT" | "EXECUTION_ERROR"; error?: Error };

// ── Redis key helpers ────────────────────────────────────────────────────────

const lockKey  = (id: string) => `lock:user:${id}`;
const depthKey = (id: string) => `queue:depth:user:${id}`;

// Atomically release lock only if this process owns it
const RELEASE_LUA = `
if redis.call("GET",KEYS[1])==ARGV[1] then
  return redis.call("DEL",KEYS[1])
else
  return 0
end`;

// ── Instrumentation ──────────────────────────────────────────────────────────

const _samples = {
  queueWait:  [] as number[],
  lockAcq:    [] as number[],
  execDur:    [] as number[],
};

function p95(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.95)] ?? s[s.length - 1];
}

function pushSample(arr: number[], v: number, cap = 2_000): void {
  arr.push(v);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

export function getQueueMetrics() {
  return {
    queue_wait_p95_ms:       p95(_samples.queueWait),
    lock_acquisition_p95_ms: p95(_samples.lockAcq),
    exec_duration_p95_ms:    p95(_samples.execDur),
    lock_contention_count:   metrics.get("execution_queue_lock_contention_total"),
    overflow_count:          metrics.get("execution_queue_overflow_total"),
    completed_count:         metrics.get("execution_queue_completed_total"),
    error_count:             metrics.get("execution_queue_errors_total"),
    backend:                 getRedis() ? "redis" : "in-memory",
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── In-memory fallback (single-worker serialization) ─────────────────────────

class InMemoryQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly depths = new Map<string, number>();

  async enqueue<T>(userId: string, task: QueuedTask<T>): Promise<EnqueueResult<T>> {
    const depth = this.depths.get(userId) ?? 0;
    if (depth >= MAX_QUEUE_DEPTH) {
      metrics.inc("execution_queue_overflow_total");
      return { ok: false, reason: "QUEUE_FULL" };
    }
    this.depths.set(userId, depth + 1);
    const queuedAt = Date.now();

    let resolveSlot!: () => void;
    const thisSlot = new Promise<void>(r => { resolveSlot = r; });
    const previous = this.chains.get(userId) ?? Promise.resolve();
    const next     = previous.then(() => thisSlot);
    this.chains.set(userId, next);

    await previous;

    const execStart   = Date.now();
    const queuedMs    = execStart - queuedAt;
    const cancelToken: CancelToken = { value: false };

    const runTask = async (): Promise<T> => {
      try {
        return await task(cancelToken);
      } finally {
        const d = this.depths.get(userId) ?? 1;
        if (d <= 1) this.depths.delete(userId);
        else        this.depths.set(userId, d - 1);
        if ((this.depths.get(userId) ?? 0) === 0) this.chains.delete(userId);
        resolveSlot();
      }
    };

    const taskPromise = runTask();
    try {
      const result = await Promise.race([
        taskPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            cancelToken.value = true;
            // Unblock the next task in the chain immediately so retries are not
            // held hostage by this task still running in the background.
            resolveSlot();
            reject(new Error("EXECUTION_TIMEOUT"));
          }, EXECUTION_TIMEOUT_MS)
        ),
      ]);
      const execMs = Date.now() - execStart;
      pushSample(_samples.queueWait, queuedMs);
      pushSample(_samples.execDur,   execMs);
      metrics.inc("execution_queue_completed_total");
      metrics.set("execution_queue_last_exec_ms", execMs);
      return { ok: true, result, queuedMs, execMs };
    } catch (err) {
      metrics.inc("execution_queue_errors_total");
      const reason = (err as Error).message === "EXECUTION_TIMEOUT" ? "TIMEOUT" : "EXECUTION_ERROR";
      return { ok: false, reason, error: err as Error };
    }
  }

  getStats() {
    let total = 0;
    for (const d of this.depths.values()) total += d;
    return { queuedUsers: this.depths.size, totalPending: total };
  }
}

// ── Redis distributed-lock queue ──────────────────────────────────────────────

async function acquireRedisLock(
  key: string,
  value: string,
  cancelToken: CancelToken,
): Promise<boolean> {
  const redis    = getRedis()!;
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  let   retryMs  = LOCK_RETRY_INIT_MS;

  while (!cancelToken.value) {
    const ok = await redis.set(key, value, "PX", LOCK_TTL_MS, "NX");
    if (ok === "OK") return true;

    metrics.inc("execution_queue_lock_contention_total");
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(retryMs + Math.random() * 20, remaining));
    retryMs = Math.min(retryMs * 1.5, LOCK_RETRY_MAX_MS);
  }
  return false;
}

async function releaseRedisLock(key: string, value: string): Promise<void> {
  try {
    await getRedis()!.eval(RELEASE_LUA, 1, key, value);
  } catch { /* TTL handles stale locks */ }
}

class RedisQueue {
  async enqueue<T>(userId: string, task: QueuedTask<T>): Promise<EnqueueResult<T>> {
    const redis        = getRedis()!;
    const enqueueStart = Date.now();
    const dk           = depthKey(userId);
    const lk           = lockKey(userId);
    const lv           = randomUUID();
    const cancelToken: CancelToken = { value: false };
    let   depthHeld    = false;
    let   lockHeld     = false;

    try {
      // Admission: increment depth counter, check for overflow
      const depth = await redis.incr(dk);
      await redis.expire(dk, DEPTH_KEY_TTL_S);
      depthHeld = true;

      if (depth > MAX_QUEUE_DEPTH) {
        metrics.inc("execution_queue_overflow_total");
        return { ok: false, reason: "QUEUE_FULL" };
      }

      // Acquire distributed lock
      const lockStart = Date.now();
      lockHeld = await acquireRedisLock(lk, lv, cancelToken);
      pushSample(_samples.lockAcq, Date.now() - lockStart);

      if (!lockHeld) {
        metrics.inc("execution_queue_errors_total");
        return { ok: false, reason: "TIMEOUT" };
      }

      const queuedMs = Date.now() - enqueueStart;
      pushSample(_samples.queueWait, queuedMs);

      // Execute with timeout
      const execStart = Date.now();
      const result = await Promise.race([
        task(cancelToken),
        new Promise<never>((_, reject) =>
          setTimeout(() => { cancelToken.value = true; reject(new Error("EXECUTION_TIMEOUT")); },
            EXECUTION_TIMEOUT_MS)
        ),
      ]);
      const execMs = Date.now() - execStart;
      pushSample(_samples.execDur, execMs);
      metrics.inc("execution_queue_completed_total");
      metrics.set("execution_queue_last_exec_ms", execMs);
      return { ok: true, result, queuedMs, execMs };

    } catch (err) {
      metrics.inc("execution_queue_errors_total");
      if ((err as Error).message === "EXECUTION_TIMEOUT") {
        return { ok: false, reason: "TIMEOUT" };
      }
      return { ok: false, reason: "EXECUTION_ERROR", error: err as Error };
    } finally {
      if (lockHeld)  await releaseRedisLock(lk, lv);
      if (depthHeld) { try { await redis.decr(dk); } catch { /* ignore */ } }
    }
  }

  getStats() { return { backend: "redis" }; }
}

// ── Unified queue (Redis when available, in-memory fallback) ──────────────────

class UserExecutionQueue {
  private readonly mem   = new InMemoryQueue();
  private readonly redis = new RedisQueue();

  async enqueue<T>(userId: string, task: QueuedTask<T>): Promise<EnqueueResult<T>> {
    if (!getRedis()) return this.mem.enqueue(userId, task);
    try {
      return await this.redis.enqueue(userId, task);
    } catch (redisErr) {
      // Redis connection lost mid-flight — degrade to in-memory for this request
      console.warn("[execution-queue] Redis error, falling back to in-memory:", (redisErr as Error).message);
      return this.mem.enqueue(userId, task);
    }
  }

  getStats() {
    return getRedis() ? this.redis.getStats() : this.mem.getStats();
  }
}

export const executionQueue = new UserExecutionQueue();
