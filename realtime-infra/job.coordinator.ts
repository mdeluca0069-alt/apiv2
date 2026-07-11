/**
 * JobCoordinator — distributed job registry and leader election wrapper.
 *
 * Every background job must register here. Registration enforces:
 *   - A unique job ID (prevents accidental duplicate registrations)
 *   - A Redis TTL matched to the schedule interval
 *   - Crash recovery semantics (lock expires naturally if the leader dies)
 *
 * Usage:
 *   import { jobCoordinator } from "./realtime-infra/job.coordinator.js";
 *
 *   // At startup — register once
 *   jobCoordinator.register({ id: "stop-out-scan", ttlSeconds: 25, intervalMs: 30_000 });
 *
 *   // In the interval callback
 *   setInterval(async () => {
 *     if (!(await jobCoordinator.tryLead("stop-out-scan"))) return;
 *     try { await stopOutEngine.scanAll(); }
 *     finally { await jobCoordinator.release("stop-out-scan"); }
 *   }, 30_000);
 *
 * Service Inventory (maintained here as canonical source-of-truth):
 *
 *   ┌─────────────────────────────────┬──────────────────┬────────────┬──────────────┬──────────────────────┐
 *   │ Job ID                          │ Schedule         │ TTL        │ Idempotency  │ Prior state          │
 *   ├─────────────────────────────────┼──────────────────┼────────────┼──────────────┼──────────────────────┤
 *   │ stop-out-scan                   │ every 30s        │ 25s        │ DB tx lock   │ ALL workers ran      │
 *   │ liquidation-watchdog            │ every 30s        │ 25s        │ close-error  │ new (FASE 2.5)       │
 *   │ pending-order-expiry            │ every 30s        │ 25s        │ markTriggered│ ALL workers ran      │
 *   │ outbox-retry-sweep              │ every 30s        │ 25s        │ WS re-push   │ ALL workers ran      │
 *   │ audit-outbox-consumer           │ every 10s        │ 8s         │ tx-per-event │ new (FASE 2.4)       │
 *   │ notification-outbox-consumer    │ every 15s        │ 12s        │ upsert       │ new (FASE 2.6)       │
 *   │ symbol-circuit-breaker-recovery │ every 30s        │ 25s        │ ownership map│ new (FASE 3.2)       │
 *   │ outbox-cleanup                  │ every 15min      │ 13min      │ deleteMany   │ ALL workers ran OK   │
 *   │ signal-generator                │ every 60s        │ 50s        │ 4h cooldown  │ ALL workers ran      │
 *   │ reconciliation-sweep            │ every 5min       │ 4min       │ read-only    │ ✓ already locked     │
 *   │ daily-snapshot-eod              │ 22:00 UTC / 24h  │ 15min      │ upsert       │ ✓ already locked     │
 *   │ swap-accrual-nightly            │ 22:00 UTC / 24h  │ 10min      │ unique const │ ✓ already locked     │
 *   └─────────────────────────────────┴──────────────────┴────────────┴──────────────┴──────────────────────┘
 *
 * Jobs marked "✓ already locked" already use DistributedJobLock internally.
 * This coordinator adds locks to the remaining jobs that previously ran on
 * ALL workers simultaneously, multiplying CPU + DB load by worker count.
 */

import { DistributedJobLock } from "../shared/distributed.job.lock.js";

export type JobSpec = {
  id:          string;   // unique job identifier
  ttlSeconds:  number;   // lock TTL — must be < schedule interval
  intervalMs:  number;   // schedule interval for documentation purposes
  description: string;   // human-readable description for the service inventory
};

export type JobRegistration = JobSpec & {
  lock:          DistributedJobLock;
  registered:    boolean;
  runCount:      number;
  skippedCount:  number;
  lastRunAt:     Date | null;
  lastSkippedAt: Date | null;
  lastError:     string | null;
};

class JobCoordinator {
  private readonly registry = new Map<string, JobRegistration>();

  /**
   * Register a job. Must be called once at startup before the first interval fires.
   * Throws if a job with the same ID is already registered (programming error).
   */
  register(spec: JobSpec): void {
    if (this.registry.has(spec.id)) {
      throw new Error(`[job-coordinator] duplicate job registration: "${spec.id}"`);
    }

    this.registry.set(spec.id, {
      ...spec,
      lock:          new DistributedJobLock(spec.id, spec.ttlSeconds),
      registered:    true,
      runCount:      0,
      skippedCount:  0,
      lastRunAt:     null,
      lastSkippedAt: null,
      lastError:     null,
    });

    console.log(`[job-coordinator] registered job "${spec.id}" ttl=${spec.ttlSeconds}s interval=${spec.intervalMs / 1_000}s`);
  }

  /**
   * Attempt to become the leader for this job window.
   * Returns true if this worker should run the job.
   * Returns false if another worker holds the lock (skip this cycle).
   *
   * When Redis is unavailable, always returns true (graceful degradation).
   * The job's own idempotency guards (DB unique constraints, markTriggered, etc.)
   * prevent double-processing in that scenario.
   */
  async tryLead(jobId: string): Promise<boolean> {
    const entry = this._get(jobId);
    const acquired = await entry.lock.tryAcquire();

    if (!acquired) {
      entry.skippedCount++;
      entry.lastSkippedAt = new Date();
    }

    return acquired;
  }

  /**
   * Release the lock after the job completes.
   * Always call in a `finally` block to ensure the lock is released even on error.
   */
  async release(jobId: string): Promise<void> {
    const entry = this._get(jobId);
    await entry.lock.release();
    entry.runCount++;
    entry.lastRunAt = new Date();
  }

  /**
   * Mark that the current run completed with an error.
   * Still releases the lock so the next cycle can try again.
   */
  async releaseWithError(jobId: string, err: Error): Promise<void> {
    const entry = this._get(jobId);
    entry.lastError = err.message;
    await this.release(jobId);
  }

  /** Returns a snapshot of all registered jobs for admin/monitoring endpoints. */
  getInventory(): Array<Omit<JobRegistration, "lock">> {
    return [...this.registry.values()].map(({ lock: _lock, ...rest }) => rest);
  }

  private _get(jobId: string): JobRegistration {
    const entry = this.registry.get(jobId);
    if (!entry) throw new Error(`[job-coordinator] job "${jobId}" not registered — call register() first`);
    return entry;
  }
}

export const jobCoordinator = new JobCoordinator();
export default jobCoordinator;
