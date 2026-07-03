/**
 * PgBouncer Health Service — queries the PgBouncer admin console for pool stats.
 *
 * PgBouncer exposes a virtual "pgbouncer" database that accepts SQL commands:
 *   SHOW POOLS;     — per-database, per-user pool stats
 *   SHOW STATS;     — aggregate request/error counters
 *   SHOW CLIENTS;   — connected client sessions
 *   SHOW SERVERS;   — server-side connections to PostgreSQL
 *
 * This service connects directly to the PgBouncer admin interface using node-postgres
 * (pg) rather than Prisma because Prisma can't issue raw psql admin commands to
 * the special "pgbouncer" database on port 6432.
 *
 * Graceful degradation:
 *   If PgBouncer is not configured (PGBOUNCER_URL not set), all methods return
 *   a "not configured" response so the admin endpoint remains non-fatal.
 */

import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

type PgClient = {
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
  end:   () => Promise<void>;
};

type PgConstructor = new (options: {
  connectionString: string;
  connectionTimeoutMillis: number;
  statement_timeout: number;
}) => PgClient;

// ── Types ─────────────────────────────────────────────────────────────────────
export type PoolStat = {
  database:    string;
  user:        string;
  clActive:    number;   // client active connections
  clWaiting:   number;   // client connections waiting for a server
  svActive:    number;   // server active connections
  svIdle:      number;   // server idle connections
  svUsed:      number;   // server connections used (outstanding query)
  svTested:    number;   // connections being tested
  svLogin:     number;   // connections logging in
  maxwait:     number;   // longest waiting time (seconds)
};

export type PgBouncerStats = {
  configured:   boolean;
  url:          string | null;
  pools:        PoolStat[];
  totalClients: number;
  totalServers: number;
  totalWaiting: number;
  maxWaitSec:   number;
  checkedAt:    string;
};

// ─────────────────────────────────────────────────────────────────────────────

class PgBouncerHealth {
  private readonly pgbouncerUrl: string | null;

  constructor() {
    const adminUrl = process.env.PGBOUNCER_ADMIN_URL;
    this.pgbouncerUrl = adminUrl ?? null;
  }

  /** Query PgBouncer SHOW POOLS and return aggregated stats. */
  async getStats(): Promise<PgBouncerStats> {
    if (!this.pgbouncerUrl) {
      return {
        configured:   false,
        url:          null,
        pools:        [],
        totalClients: 0,
        totalServers: 0,
        totalWaiting: 0,
        maxWaitSec:   0,
        checkedAt:    new Date().toISOString(),
      };
    }

    let PgLib: PgConstructor | null = null;
    try {
      // Dynamic require — pg is a devDependency in some setups; don't crash if absent
      const pgModule = _require("pg") as { Client: PgConstructor };
      PgLib = pgModule.Client;
    } catch {
      return this._unavailable("pg package not installed");
    }

    const client = new PgLib({
      connectionString:        this.pgbouncerUrl,
      connectionTimeoutMillis: 3_000,
      statement_timeout:       5_000,
    });

    try {
      await (client as unknown as { connect(): Promise<void> }).connect();
      const result = await client.query("SHOW POOLS");
      const pools  = this._parsePools(result.rows);

      const totalClients = pools.reduce((s, p) => s + p.clActive + p.clWaiting, 0);
      const totalServers = pools.reduce((s, p) => s + p.svActive + p.svIdle + p.svUsed, 0);
      const totalWaiting = pools.reduce((s, p) => s + p.clWaiting, 0);
      const maxWaitSec   = Math.max(0, ...pools.map((p) => p.maxwait));

      return {
        configured:   true,
        url:          this._sanitizeUrl(this.pgbouncerUrl),
        pools,
        totalClients,
        totalServers,
        totalWaiting,
        maxWaitSec,
        checkedAt:    new Date().toISOString(),
      };
    } catch (err) {
      return this._unavailable((err as Error).message);
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** Whether PgBouncer admin URL is configured. */
  isConfigured(): boolean {
    return this.pgbouncerUrl !== null;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _parsePools(rows: Record<string, unknown>[]): PoolStat[] {
    return rows.map((r) => ({
      database:  String(r["database"] ?? ""),
      user:      String(r["user"] ?? ""),
      clActive:  Number(r["cl_active"]  ?? 0),
      clWaiting: Number(r["cl_waiting"] ?? 0),
      svActive:  Number(r["sv_active"]  ?? 0),
      svIdle:    Number(r["sv_idle"]    ?? 0),
      svUsed:    Number(r["sv_used"]    ?? 0),
      svTested:  Number(r["sv_tested"]  ?? 0),
      svLogin:   Number(r["sv_login"]   ?? 0),
      maxwait:   Number(r["maxwait"]    ?? 0),
    }));
  }

  private _unavailable(reason: string): PgBouncerStats {
    return {
      configured:   true,
      url:          this.pgbouncerUrl ? this._sanitizeUrl(this.pgbouncerUrl) : null,
      pools:        [],
      totalClients: 0,
      totalServers: 0,
      totalWaiting: 0,
      maxWaitSec:   0,
      checkedAt:    new Date().toISOString(),
      ...(({ error: reason }) as unknown as object),
    } as PgBouncerStats & { error?: string };
  }

  private _sanitizeUrl(url: string): string {
    // Remove password from URL for safe logging/display
    return url.replace(/:([^@]+)@/, ":***@");
  }
}

export const pgbouncerHealth = new PgBouncerHealth();
export default pgbouncerHealth;
