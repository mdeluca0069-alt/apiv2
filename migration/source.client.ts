/**
 * migration/source.client.ts — read-only connection to the SOURCE (legacy
 * igfxpro-api v1) Postgres database.
 *
 * Deliberately raw `pg`, not a second Prisma client: v1 and apiv2 are two
 * separate schemas/codebases (PRODUCTION_CUTOVER_REPORT.md §1.5) and
 * generating a second full Prisma client just to read from v1 would be
 * heavier than this ETL needs -- every domain's extractSql is plain,
 * hand-written SQL against v1's actual column names, and the ETL never
 * writes to this connection (SOURCE_DATABASE_URL should be provisioned
 * with a read-only Postgres role for defense in depth, though this client
 * does not depend on that -- it simply never issues a write statement).
 */
import { Pool } from "pg";

export function createSourceClient(connectionString: string): Pool {
  return new Pool({
    connectionString,
    // Conservative pool: this is a batch ETL job, not a request-serving
    // API -- a handful of connections is plenty and avoids competing with
    // v1's own production traffic for connection-limit headroom on the
    // shared Render Postgres instance.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function assertSourceReadOnly(pool: import("pg").Pool): Promise<void> {
  // Best-effort safety check, not a security boundary: confirms this ETL
  // run's connection cannot commit writes, so a bug in a domain's SQL (or
  // a future domain added without care) can never mutate v1's live
  // production data. If the configured role isn't actually read-only,
  // this logs a loud warning rather than blocking -- some hosting setups
  // (e.g. a shared "app" role during initial testing) can't easily
  // provision a dedicated read-only role, and refusing to run at all
  // would make this tool unusable there.
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ in_recovery: boolean }>("SELECT pg_is_in_recovery() AS in_recovery");
    if (rows[0]?.in_recovery) {
      // Connected to a read replica -- writes are structurally impossible. Good.
      return;
    }
    const { rows: txRows } = await client.query<{ default_transaction_read_only: string }>(
      "SHOW default_transaction_read_only",
    );
    if (txRows[0]?.default_transaction_read_only !== "on") {
      console.warn(
        "[migration] WARNING: SOURCE_DATABASE_URL's role is not configured read-only " +
        "(default_transaction_read_only=off) and is not a replica. This ETL's own SQL " +
        "never issues a write, but as defense in depth, provision a read-only role for " +
        "production runs against v1's real database.",
      );
    }
  } finally {
    client.release();
  }
}
