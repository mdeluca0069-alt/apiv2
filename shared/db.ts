import { PrismaClient }   from "@prisma/client";
import { queryTelemetry } from "./query.telemetry.js";
import { prismaRead as _replicaRoute } from "./db.replica.js";

/**
 * Database mode is determined at startup from DATABASE_URL.
 *
 * PERSISTENT mode  — DATABASE_URL is set and reachable.
 *                    All writes go to PostgreSQL. Survives restarts.
 *
 * SANDBOX mode     — DATABASE_URL is absent.
 *                    In-memory only. Resets on restart. Dev/demo use only.
 *
 * If DATABASE_URL is set but the server is unreachable, the process will
 * fail fast at connection time — we do NOT silently fall back to in-memory.
 * This prevents silent data loss in production.
 */

const DB_URL = process.env.DATABASE_URL;

// IS_PERSISTENT starts true if DATABASE_URL is set, but is reset to false
// by markDbUnavailable() when the connection test fails at startup.
// Routes must read this at request time (not module-load time) to get the
// correct value after the async DB health check completes.
export let IS_PERSISTENT = Boolean(DB_URL);

/**
 * Called by main.ts when initializePersistence() throws.
 * Resets IS_PERSISTENT and clears DATABASE_URL so every route that checks
 * either will fall back to the in-memory sandbox path consistently.
 */
export function markDbUnavailable(): void {
  IS_PERSISTENT = false;
  process.env.DATABASE_URL = "";
  console.warn("[db] mode=SANDBOX  DB unreachable — all routes using in-memory fallback");
}

if (IS_PERSISTENT) {
  console.log("[db] mode=PERSISTENT  database=postgresql");
} else {
  console.warn("[db] mode=SANDBOX  WARNING: no DATABASE_URL — data will not survive restart");
}

let _prisma: PrismaClient | null = null;

function buildClient(): PrismaClient {
  if (_prisma) return _prisma;

  // Ensure pool_timeout and connect_timeout are set so DB operations fail fast
  // (within ~3s) rather than blocking near the 15-second execution queue timeout.
  // If the URL already has explicit values, we leave them untouched.
  let dbUrl = process.env.DATABASE_URL ?? "";
  if (dbUrl) {
    const sep = dbUrl.includes("?") ? "&" : "?";
    if (!dbUrl.includes("pool_timeout"))    dbUrl += `${sep}pool_timeout=3`;
    if (!dbUrl.includes("connect_timeout")) dbUrl += `&connect_timeout=5`;
    // When routing through PgBouncer (transaction mode), set connection_limit
    // to the number of Prisma replicas × a modest per-process cap.  The default
    // Prisma pool (num_cpus * 2 + 1) can overwhelm PgBouncer under scale-out.
    // DB_POOL_SIZE env allows override; default 10 is safe for most deployments.
    if (!dbUrl.includes("connection_limit")) {
      const poolSize = process.env.DB_POOL_SIZE ?? "10";
      dbUrl += `&connection_limit=${poolSize}`;
    }
    // pgbouncer=true disables prepared statements — required for PgBouncer in
    // transaction mode (prepared statements are session-scoped and incompatible).
    if (!dbUrl.includes("pgbouncer=") && process.env.PGBOUNCER === "true") {
      dbUrl += "&pgbouncer=true";
    }
  }

  _prisma = new PrismaClient({
    datasources: { db: { url: dbUrl || process.env.DATABASE_URL } },
    log: process.env.NODE_ENV === "development"
      ? ["warn", "error"]
      : ["error"],
    errorFormat: "minimal",
  });

  // Wire query telemetry middleware (records timing, captures slow queries)
  _prisma.$use(queryTelemetry.createMiddleware("primary"));

  // Log effective pool config
  const cl = dbUrl.match(/connection_limit=(\d+)/)?.[1] ?? "default";
  const pt = dbUrl.match(/pool_timeout=(\d+)/)?.[1] ?? "3";
  const ct = dbUrl.match(/connect_timeout=(\d+)/)?.[1] ?? "5";
  console.log(`[db] pool config — connection_limit=${cl} pool_timeout=${pt}s connect_timeout=${ct}s`);

  return _prisma;
}

/**
 * Returns the Prisma client in PERSISTENT mode.
 * Returns an empty proxy object in SANDBOX mode — callers that check
 * `prisma?.model` before calling will get undefined and short-circuit.
 */
export const prisma: PrismaClient = IS_PERSISTENT
  ? buildClient()
  : (new Proxy({} as PrismaClient, {
      get(_, prop) {
        // Allow lifecycle methods
        if (prop === "$connect" || prop === "$disconnect") return async () => {};
        return undefined;
      },
    }));

/**
 * Returns the read replica client if configured + healthy, otherwise primary.
 * Use for analytics / reporting queries that can tolerate replica lag.
 * Writes always use the primary `prisma` export directly.
 */
export function prismaRead(): PrismaClient {
  return _replicaRoute(prisma as PrismaClient);
}

export async function connectDatabase(): Promise<void> {
  if (!IS_PERSISTENT) return;
  await (prisma as PrismaClient).$connect();
  console.log("[db] connection established");
}

export async function disconnectDatabase(): Promise<void> {
  if (!IS_PERSISTENT) return;
  await (prisma as PrismaClient).$disconnect();
}
