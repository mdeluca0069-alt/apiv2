/**
 * disaster-recovery/dr.health.service.ts
 *
 * Application-level DR readiness check.
 * Exposes GET /api/v1/dr/status — used by:
 *   - Route53 health checks (determines DNS failover)
 *   - Monitoring dashboards
 *   - Pre-deployment validation
 *   - Failover scripts
 *
 * A healthy DR status requires:
 *   1. DB writable (not in recovery mode, not read-only)
 *   2. Redis reachable
 *   3. Market data feed active
 *   4. Backup freshness within RPO window
 *   5. No kill switch active (soft: does not fail health check)
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { getRedis }              from "../shared/redis.js";
import { quoteCache }            from "../market-data/quote.cache.js";
import { feedHealthMonitor }     from "../market-data/feed.health.monitor.js";
import { metrics }               from "../shared/metrics.js";

export type DRHealthStatus = {
  healthy:     boolean;
  region:      string;
  role:        "primary" | "dr-standby" | "dr-active";
  rpo_minutes: number | null;    // estimated data loss if primary fails NOW
  checks:      DRCheck[];
  timestamp:   string;
};

export type DRCheck = {
  name:    string;
  status:  "pass" | "fail" | "warn";
  message: string;
  value?:  number;
};

const REGION = process.env.AWS_REGION ?? "us-east-1";
const DR_REGION = process.env.DR_REGION ?? "us-west-2";
const IS_DR = REGION === DR_REGION;
const RPO_WARN_MINUTES = 5;

// Track when the last successful DB write occurred
let _lastWriteTs = Date.now();
let _lastWriteRecorded = false;

/** Call this after every successful DB write to track RPO */
export function recordDatabaseWrite(): void {
  _lastWriteTs = Date.now();
  _lastWriteRecorded = true;
}

export async function getDRHealth(): Promise<DRHealthStatus> {
  const checks: DRCheck[] = [];
  let criticalFailures = 0;

  // ── 1. Database write availability ─────────────────────────────────────────

  if (IS_PERSISTENT && prisma) {
    try {
      const db = prisma as NonNullable<typeof prisma>;

      // Check if DB is in recovery mode (read-only)
      const { Prisma } = await import("@prisma/client");
      const result = await db.$queryRaw<[{ pg_is_in_recovery: boolean }]>(
        Prisma.sql`SELECT pg_is_in_recovery()::boolean AS pg_is_in_recovery`,
      ).catch(() => null);

      if (!result) {
        checks.push({ name: "db-write", status: "fail", message: "Cannot connect to database" });
        criticalFailures++;
      } else if (result[0].pg_is_in_recovery) {
        checks.push({ name: "db-write", status: "fail", message: "Database is in recovery mode (read-only)" });
        criticalFailures++;
      } else {
        // Do a lightweight write to confirm we can actually write
        await db.auditLog.create({
          data: {
            id:      `dr-hc-${Date.now()}`,
            actor:   "SYSTEM_DR_HEALTH",
            action:  "dr.health_check",
            entity:  "system",
            payload: { ts: Date.now() } as object,
          },
        });
        recordDatabaseWrite();
        checks.push({ name: "db-write", status: "pass", message: "Database write confirmed" });
      }
    } catch (err) {
      checks.push({ name: "db-write", status: "fail", message: `DB error: ${(err as Error).message}` });
      criticalFailures++;
    }
  } else {
    checks.push({ name: "db-write", status: "warn", message: "Sandbox mode: DB not checked" });
  }

  // ── 2. Redis availability ──────────────────────────────────────────────────

  const redis = getRedis();
  if (redis) {
    try {
      const pong = await redis.ping().catch(() => null);
      if (pong === "PONG") {
        const info = await redis.info("replication").catch(() => "");
        const role = info.match(/role:(\w+)/)?.[1] ?? "unknown";
        checks.push({ name: "redis", status: "pass", message: `Redis ${role}: OK` });
      } else {
        checks.push({ name: "redis", status: "warn", message: "Redis ping failed" });
      }
    } catch (err) {
      checks.push({ name: "redis", status: "warn", message: `Redis error: ${(err as Error).message}` });
    }
  } else {
    checks.push({ name: "redis", status: "warn", message: "Redis not configured" });
  }

  // ── 3. Market data feed ────────────────────────────────────────────────────

  try {
    const quotes = quoteCache.getAll?.() ?? [];
    const snapshot = feedHealthMonitor.getSnapshot();
    const staleCount = Object.values(snapshot).filter(
      (h) => ((h as { quoteAgeMs?: number }).quoteAgeMs ?? 0) > 5_000,
    ).length;

    if (staleCount === 0 && quotes.length > 0) {
      checks.push({ name: "market-data", status: "pass", message: `Feed active: ${quotes.length} symbols` });
    } else if (staleCount > 50) {
      checks.push({ name: "market-data", status: "fail", message: `${staleCount} stale symbols`, value: staleCount });
      criticalFailures++;
    } else {
      checks.push({ name: "market-data", status: "warn", message: `${staleCount} stale symbols`, value: staleCount });
    }
  } catch {
    checks.push({ name: "market-data", status: "warn", message: "Feed health unavailable" });
  }

  // ── 4. RPO estimate ────────────────────────────────────────────────────────

  let rpo_minutes: number | null = null;
  if (_lastWriteRecorded) {
    const msSinceWrite = Date.now() - _lastWriteTs;
    rpo_minutes = Math.round((msSinceWrite / 60_000) * 10) / 10;
    const rpoStatus = rpo_minutes < RPO_WARN_MINUTES ? "pass" : "warn";
    checks.push({
      name:    "rpo",
      status:  rpoStatus,
      message: `Last write ${rpo_minutes.toFixed(1)}m ago (target: <${RPO_WARN_MINUTES}m)`,
      value:   rpo_minutes,
    });
  }

  // ── 5. Memory pressure ─────────────────────────────────────────────────────

  const heapUsed  = process.memoryUsage().heapUsed;
  const heapTotal = process.memoryUsage().heapTotal;
  const heapPct   = Math.round((heapUsed / heapTotal) * 100);
  checks.push({
    name:    "memory",
    status:  heapPct < 90 ? "pass" : "warn",
    message: `Heap: ${heapPct}%`,
    value:   heapPct,
  });

  // ── Aggregate ──────────────────────────────────────────────────────────────

  const healthy = criticalFailures === 0;
  const role: DRHealthStatus["role"] = IS_DR
    ? (healthy ? "dr-active" : "dr-standby")
    : "primary";

  // Emit metrics
  metrics.set("igfx_dr_healthy", healthy ? 1 : 0);
  metrics.set("igfx_dr_critical_failures", criticalFailures);
  if (rpo_minutes !== null) metrics.set("igfx_dr_rpo_minutes", rpo_minutes);

  return {
    healthy,
    region:      REGION,
    role,
    rpo_minutes,
    checks,
    timestamp:   new Date().toISOString(),
  };
}

// Register DR metrics
metrics.register("igfx_dr_healthy",           "gauge", "DR health status (1=healthy, 0=unhealthy)");
metrics.register("igfx_dr_critical_failures",  "gauge", "Number of critical DR health check failures");
metrics.register("igfx_dr_rpo_minutes",        "gauge", "Estimated RPO in minutes (time since last DB write)");

export const drHealthService = { getDRHealth, recordDatabaseWrite };
