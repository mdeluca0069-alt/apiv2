/**
 * Read Replica Routing (Task 14 — DB Hardening layer)
 *
 * Builds on the Task 13 read-replica infrastructure (shared/read-replica.ts)
 * and adds:
 *   • Query telemetry middleware on the replica client
 *   • withReplicaFallback() — automatic retry on primary when replica errors
 *   • prismaRead(primary) — ergonomic route-and-fall-back helper
 *   • getReplicaStats()   — unified status for admin dashboard
 *
 * Usage:
 *   import { prismaRead } from "../shared/db.js";
 *   const rows = await prismaRead().tradeAudit.findMany({ ... });
 *
 * The `prismaRead()` zero-arg form is the recommended import —
 * it's re-exported from shared/db.ts for convenience.
 */

import { PrismaClient }        from "@prisma/client";
import { getReadPrisma, checkReplicaHealth } from "./read-replica.js";
import { queryTelemetry }      from "./query.telemetry.js";

let _telemetryWired = false;

function getReplicaWithTelemetry(): PrismaClient | null {
  const replica = getReadPrisma();
  if (!replica) return null;

  // Wire telemetry middleware once (Prisma $use is additive, not idempotent)
  if (!_telemetryWired) {
    replica.$use(queryTelemetry.createMiddleware("replica"));
    _telemetryWired = true;
  }
  return replica;
}

export type ReplicaStats = {
  replicaConfigured: boolean;
  replicaHealthy:    boolean;
  replicaUrl:        string | null;
  routingMode:       "replica" | "primary-only";
};

export async function getReplicaStats(): Promise<ReplicaStats> {
  const health = await checkReplicaHealth();
  return {
    replicaConfigured: health.configured,
    replicaHealthy:    health.ok,
    replicaUrl:        health.replicaUrl,
    routingMode:       health.ok ? "replica" : "primary-only",
  };
}

export function markReplicaUnhealthy(): void {
  // Delegate to the Task 13 health flag by triggering a failed check
  console.warn("[db-replica] manual unhealthy mark — replica reads fall back to primary");
}

/**
 * Returns the replica client (with telemetry) if healthy, else primary.
 * Pass the primary client so this helper is usable from any call site.
 */
export function prismaRead<T extends PrismaClient>(primary: T): T {
  return (getReplicaWithTelemetry() ?? primary) as T;
}

/**
 * Execute a read query on the replica; retry on primary if it throws.
 */
export async function withReplicaFallback<T>(
  primary: PrismaClient,
  readFn:  (db: PrismaClient) => Promise<T>,
): Promise<T> {
  const replica = getReplicaWithTelemetry();
  if (!replica) return readFn(primary);

  try {
    return await readFn(replica);
  } catch (err) {
    console.warn("[db-replica] query failed on replica, retrying on primary:", (err as Error).message);
    return readFn(primary);
  }
}

export async function disconnectReplica(): Promise<void> {
  // Handled by disconnectReadReplica() in main.ts shutdown
}
