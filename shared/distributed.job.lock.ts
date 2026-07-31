/**
 * DistributedJobLock — Redis-based leader election for background jobs.
 *
 * Ensures exactly ONE worker across the cluster runs a given job per TTL window.
 * Pattern: SET key leaseId NX EX ttlSeconds (atomic, no race).
 *
 * Degraded mode: when Redis is unavailable getRedis() returns null.
 * In that case tryAcquire() returns true so all workers run — the job's own
 * idempotency guards (SwapAccrual unique constraint, DailySnapshot upsert, etc.)
 * prevent double-processing.
 *
 * Usage:
 *   const lock = new DistributedJobLock("swap-accrual");
 *   if (!(await lock.tryAcquire(300))) return; // another worker won
 *   const renewal = lock.startRenewal(90);
 *   try {
 *     await doWork();
 *   } finally {
 *     clearInterval(renewal);
 *     await lock.release();
 *   }
 */

import { randomUUID } from "node:crypto";
import { getRedis }   from "./redis.js";

const KEY = (jobId: string) => `job:leader:${jobId}`;

const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

export class DistributedJobLock {
  private readonly key: string;
  private leaseId: string | null = null;

  constructor(
    private readonly jobId:      string,
    private readonly ttlSeconds: number = 300,
  ) {
    this.key = KEY(jobId);
  }

  /**
   * Attempt to become the leader for this job window.
   * Returns true if acquired (this worker should run the job).
   * Returns false if another worker holds the lock.
   * Returns true if Redis is unavailable (graceful degradation).
   *
   * CRITICAL_REMEDIATION (C17): the `!redis` branch below only covers
   * Redis never having been configured/initialized at all. A Redis
   * OUTAGE after a successful start -- the case this class's own
   * docstring ("Degraded mode: when Redis is unavailable getRedis()
   * returns null") and jobCoordinator.tryLead()'s docstring ("When Redis
   * is unavailable, always returns true") both claim to handle -- left
   * getRedis() returning the same non-null client object it always did;
   * only the actual `redis.set(...)` call below would reject. That
   * rejection was never caught here (unlike startRenewal()/release() in
   * this same class, which both already wrap their Redis calls in
   * try/catch for exactly this reason), so it propagated straight out of
   * tryAcquire() -> jobCoordinator.tryLead() as an unhandled rejection.
   * Every documented call site (`if (!(await jobCoordinator.tryLead(...)))
   * return;`) calls tryLead() BEFORE its own try/finally block, so this
   * uncaught throw skipped the job entirely, every single cycle, for the
   * full duration of any Redis outage -- stop-out scan, liquidation
   * watchdog, pending-order-expiry, and every other job.coordinator.ts-
   * registered job. The documented "fail open" contract was correct in
   * intent and correct for the "never configured" case; it just never
   * reached the "was working, now erroring" case, which is what an actual
   * outage looks like.
   */
  async tryAcquire(): Promise<boolean> {
    const redis = getRedis();
    if (!redis) {
      console.warn(`[dist-lock] Redis unavailable — job "${this.jobId}" running without coordination`);
      return true;
    }

    this.leaseId = randomUUID();
    let result: string | null;
    try {
      result = await redis.set(this.key, this.leaseId, "EX", this.ttlSeconds, "NX");
    } catch (err) {
      this.leaseId = null;
      console.warn(`[dist-lock] job "${this.jobId}" — Redis error acquiring lock, running without coordination:`, (err as Error).message);
      return true;
    }
    const acquired = result === "OK";

    if (!acquired) {
      this.leaseId = null;
      console.log(`[dist-lock] job "${this.jobId}" — another leader holds the lock, skipping`);
    } else {
      console.log(`[dist-lock] job "${this.jobId}" — acquired lease ${this.leaseId.slice(0, 8)}…`);
    }

    return acquired;
  }

  /**
   * Start periodic TTL renewal so long-running jobs don't lose the lock.
   * Call clearInterval() on the returned handle in the finally block.
   */
  startRenewal(intervalSeconds: number): ReturnType<typeof setInterval> {
    const redis   = getRedis();
    const leaseId = this.leaseId;
    const key     = this.key;
    const ttl     = this.ttlSeconds;

    if (!redis || !leaseId) return setInterval(() => { /* no-op */ }, 2_147_483_647);

    return setInterval(async () => {
      try {
        const current = await redis.get(key);
        if (current === leaseId) {
          await redis.expire(key, ttl);
        }
      } catch {
        // Non-fatal: if renewal fails, lock will expire naturally and another worker picks up.
      }
    }, intervalSeconds * 1_000);
  }

  /**
   * Release the lock.  Only deletes the key if this process still holds it
   * (atomic Lua script prevents releasing a lock acquired by a different worker
   * after a TTL expiry + re-acquisition).
   */
  async release(): Promise<void> {
    const redis   = getRedis();
    const leaseId = this.leaseId;
    if (!redis || !leaseId) return;

    try {
      await redis.eval(RELEASE_SCRIPT, 1, this.key, leaseId);
      console.log(`[dist-lock] job "${this.jobId}" — released`);
    } catch (err) {
      console.warn(`[dist-lock] job "${this.jobId}" — release failed (non-fatal):`, (err as Error).message);
    } finally {
      this.leaseId = null;
    }
  }
}
