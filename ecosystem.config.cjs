/**
 * ecosystem.config.cjs — PM2 production cluster configuration
 *
 * Architecture:
 *   - exec_mode: "cluster" uses Node.js cluster module to fork workers.
 *     All workers share the same server socket; the OS distributes incoming
 *     TCP connections across them — eliminating the single-process event-loop
 *     bottleneck observed at 400+ concurrent connections.
 *
 * Important notes for this stateful architecture:
 *   - Each worker maintains its own in-memory positionPriceMonitor cache.
 *     New positions are monitored by whichever worker handled the open request.
 *     All workers receive ALL market data ticks, so SL/TP is processed correctly
 *     as long as the opening worker remains alive.
 *   - For full HA with zero state loss on worker restart, add Redis pub/sub:
 *     emit "position.opened" / "position.closed" events to all workers via Redis.
 *   - TwelveData WebSocket: each worker connects independently. On the free plan
 *     (8 symbols limit), all workers subscribe to the same 8 symbols. Ensure the
 *     API key has enough stream credits (workers × symbols).
 *
 * Connection pool per worker:
 *   DATABASE_URL includes connection_limit=10 → 10 × max_workers connections total.
 *   PostgreSQL default max_connections=100; 4 workers × 10 = 40 connections (safe).
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs          # start all workers
 *   pm2 reload ecosystem.config.cjs         # zero-downtime rolling reload
 *   pm2 stop   ecosystem.config.cjs         # graceful stop
 *   pm2 delete ecosystem.config.cjs         # remove from PM2 registry
 *   pm2 logs   igfxpro-api                  # stream logs
 *   pm2 monit                               # real-time CPU/RAM per worker
 */

"use strict";

const path       = require("path");
const os         = require("os");
const cpuCount   = os.cpus().length;          // 8 on this machine
const APP_DIR    = __dirname;

// ── Connection pool URL — routed through PgBouncer (session pooling) ────────
// Traffic path: Prisma → PgBouncer :6432 → PostgreSQL :5432 (igfxpro-net)
//
// Session pooling: each Prisma pool connection maps to a dedicated PostgreSQL
// server connection. Prepared statements work correctly (no cross-connection
// contamination), giving near-direct-connection performance.
//
// connection_limit=60 — Prisma pool per worker; 4 × 60 = 240 connections to
//                   PgBouncer → 240 server connections in PostgreSQL (session mode).
//                   max_connections=500; 240+~20 overhead = ~260 active backends (safe).
//                   Previous 120/worker (480 total) hit FATAL: too many clients at 500 VUs;
//                   60/worker gives each worker sufficient parallelism without overwhelming
//                   the PostgreSQL lock manager, WAL writer, and shared buffer pool.
const baseUrl    = process.env.DATABASE_URL
  || "postgresql://igfxpro:igfxpro@localhost:6432/igfxpro?schema=public";

// Strip any existing pool/pgbouncer params then apply canonical values
const baseWithoutPool = baseUrl
  .replace(/&?connection_limit=\d+/g, "")
  .replace(/&?pool_timeout=\d+/g, "")
  .replace(/&?connect_timeout=\d+/g, "")
  .replace(/&?pgbouncer=[^&]*/g, "")
  .replace(/&?statement_cache_size=\d+/g, "");

const dbUrl = baseWithoutPool +
  (baseWithoutPool.includes("?") ? "&" : "?") +
  "connection_limit=100&pool_timeout=30&connect_timeout=15";

module.exports = {
  apps: [
    {
      name:            "igfxpro-api",
      script:          path.join(APP_DIR, "dist", "main.js"),

      // ── Cluster mode — all workers share one OS-level TCP socket ──────────
      exec_mode:       "cluster",
      // Use min(cpus, 4) to keep total DB connections ≤ 40 (4 × 10)
      instances:       Math.min(cpuCount, 4),

      // ── Node.js runtime ───────────────────────────────────────────────────
      interpreter:     "node",
      // dist/main.js is ES modules (package.json "type":"module")
      // No extra flags needed for Node.js 18+ ESM cluster workers

      // ── Environment ───────────────────────────────────────────────────────
      env: {
        NODE_ENV:              "production",
        PORT:                  3000,
        DATABASE_URL:          dbUrl,
        LIVE_TRADING_ENABLED:  "true",
        QUOTE_INTERVAL_MS:     "1000",
        SIGNAL_INTERVAL_MS:    "60000",
        // Expand libuv thread pool for crypto/bcrypt under high concurrency.
        // Default is 4; 16 prevents thread starvation at 1000 VUs.
        UV_THREADPOOL_SIZE:    "16",
      },

      // ── Graceful shutdown ─────────────────────────────────────────────────
      // wait_ready: the app calls process.send("ready") once HTTP server is up.
      // listen_timeout: max ms to wait for "ready" before forcing start.
      // kill_timeout: ms to allow the process to finish in-flight requests before SIGKILL.
      wait_ready:      true,
      listen_timeout:  15_000,
      kill_timeout:    10_000,
      shutdown_with_message: true,             // sends "shutdown" IPC before SIGINT

      // ── Restart / crash policy ────────────────────────────────────────────
      max_restarts:    10,
      min_uptime:      "10s",                  // don't count restarts < 10s as crashes
      restart_delay:   1_000,                  // ms between auto-restarts

      // ── Log management ────────────────────────────────────────────────────
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file:      path.join(APP_DIR, "logs", "igfxpro-error.log"),
      out_file:        path.join(APP_DIR, "logs", "igfxpro-out.log"),
      merge_logs:      true,

      // ── Memory guard ──────────────────────────────────────────────────────
      max_memory_restart: "2G",                // restart worker if it leaks above 2 GB

      // ── Health check (PM2 Plus) ───────────────────────────────────────────
      // GET /health returns 200 → worker is healthy; any other status triggers restart
      // (requires PM2 Plus / pm2-health module; set to false to disable)
      health_check_interval: 30_000,
    },
  ],
};
