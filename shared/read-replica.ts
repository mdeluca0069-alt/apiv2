/**
 * Read Replica Client — optional Prisma client targeting a read-only PostgreSQL replica.
 *
 * Usage:
 *   import { getReadPrisma } from "./shared/read-replica.js";
 *   const db = getReadPrisma() ?? prisma;   // falls back to primary if no replica
 *
 * Configuration:
 *   Set READ_REPLICA_URL in .env to the PostgreSQL DSN of a hot-standby replica.
 *   Format is identical to DATABASE_URL.
 *   When absent, getReadPrisma() returns null — callers fall back to the primary.
 *
 *   Example .env:
 *     READ_REPLICA_URL=postgresql://igfxpro:igfxpro@replica.internal:5432/igfxpro?schema=public
 *
 * Replica lag:
 *   Streaming replication typically delivers < 100 ms of lag. Use the primary
 *   client (prisma) for any query that must see freshly-committed data:
 *   – Margin checks before order execution
 *   – Wallet balance debit/credit paths
 *   – KYC / compliance lookups at account open
 *
 *   Safe for replica reads:
 *   – Dashboard analytics (portfolio, P&L summaries)
 *   – Signal history, trade history
 *   – Exposure and VaR reports
 *   – Admin ledger reviews
 *
 * PgBouncer:
 *   If READ_REPLICA_URL points to PgBouncer-fronted replica, append
 *   ?pgbouncer=true&connection_limit=25 to disable prepared statements.
 */

import { PrismaClient } from "@prisma/client";

let _replicaClient: PrismaClient | null = null;
let _replicaHealthy = true;

/** Initialize the read replica Prisma client. Call once at startup in main.ts. */
export function initReadReplica(): boolean {
  const url = process.env.READ_REPLICA_URL;
  if (!url) {
    console.log("[read-replica] READ_REPLICA_URL not set — replica reads will fall back to primary");
    return false;
  }

  try {
    _replicaClient = new PrismaClient({
      datasources: { db: { url } },
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
    console.log("[read-replica] replica client initialised");
    return true;
  } catch (err) {
    console.error("[read-replica] failed to initialise replica client:", (err as Error).message);
    return false;
  }
}

/**
 * Return the read replica Prisma client, or null if unavailable.
 * Callers must fall back to the primary client when null is returned.
 */
export function getReadPrisma(): PrismaClient | null {
  if (!_replicaClient || !_replicaHealthy) return null;
  return _replicaClient;
}

/** Check replication health and return latency ms. */
export async function checkReplicaHealth(): Promise<{
  ok:              boolean;
  latencyMs:       number | null;
  configured:      boolean;
  replicaUrl:      string | null;
  lastCheckedAt:   string;
}> {
  const configured = Boolean(process.env.READ_REPLICA_URL);
  const replicaUrl = configured
    ? (process.env.READ_REPLICA_URL!).replace(/:([^@]+)@/, ":***@")
    : null;

  if (!_replicaClient || !configured) {
    return { ok: false, latencyMs: null, configured, replicaUrl, lastCheckedAt: new Date().toISOString() };
  }

  const t0 = Date.now();
  try {
    await _replicaClient.$queryRaw`SELECT 1`;
    const latencyMs = Date.now() - t0;
    _replicaHealthy = true;
    return { ok: true, latencyMs, configured, replicaUrl, lastCheckedAt: new Date().toISOString() };
  } catch (err) {
    _replicaHealthy = false;
    console.warn("[read-replica] health check failed:", (err as Error).message);
    return { ok: false, latencyMs: null, configured, replicaUrl, lastCheckedAt: new Date().toISOString() };
  }
}

/** Disconnect the replica client gracefully. Call in shutdown(). */
export async function disconnectReadReplica(): Promise<void> {
  if (_replicaClient) {
    try { await _replicaClient.$disconnect(); } catch { /* ignore */ }
    _replicaClient = null;
  }
}
