/**
 * observability/db.metrics.ts
 *
 * Database + Redis metrics:
 *   - Query duration histograms by model + operation
 *   - Slow query counts
 *   - Connection pool utilization
 *   - Redis command rates + memory
 *   - Replication lag (if replica configured)
 */

import { metrics }     from "../shared/metrics.js";
import { getRedis }    from "../shared/redis.js";

// ── Database query instrumentation ────────────────────────────────────────────

/** Called by query.telemetry.ts Prisma middleware */
export function recordDbQuery(
  model:      string,
  operation:  string,
  durationMs: number,
  isSlow:     boolean,
): void {
  metrics.incL("igfx_db_queries_total",       { model, operation });
  metrics.observeL("igfx_db_query_duration_ms", { model, operation }, durationMs);
  metrics.observe("db_query_duration_ms", durationMs);
  metrics.inc("db_queries_total");

  if (isSlow) {
    metrics.incL("igfx_db_slow_queries_total", { model, operation });
    metrics.inc("db_slow_queries_total");
  }
}

// ── Redis metrics collection ──────────────────────────────────────────────────

let _redisCollectorStarted = false;

export function initDbMetrics(): void {
  if (_redisCollectorStarted) return;
  _redisCollectorStarted = true;

  // Collect Redis INFO stats every 15 seconds
  setInterval(async () => {
    await collectRedisMetrics();
  }, 15_000).unref();
}

async function collectRedisMetrics(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  try {
    const info = await redis.info();
    const parsed = parseRedisInfo(info);

    // Memory
    const usedMemory = parseInt(parsed["used_memory"] ?? "0", 10);
    const maxMemory  = parseInt(parsed["maxmemory"] ?? "0", 10);
    metrics.setL("igfx_redis_memory_used_bytes", {}, usedMemory);
    if (maxMemory > 0) {
      metrics.setL("igfx_redis_memory_utilization_pct", {}, (usedMemory / maxMemory) * 100);
    }

    // Clients
    const clients = parseInt(parsed["connected_clients"] ?? "0", 10);
    metrics.setL("igfx_redis_connected_clients", {}, clients);

    // Commands
    const cmdsSec = parseFloat(parsed["instantaneous_ops_per_sec"] ?? "0");
    metrics.setL("igfx_redis_commands_per_sec", {}, cmdsSec);

    // Keyspace hits/misses
    const hits   = parseInt(parsed["keyspace_hits"] ?? "0", 10);
    const misses = parseInt(parsed["keyspace_misses"] ?? "0", 10);
    const total  = hits + misses;
    if (total > 0) {
      metrics.setL("igfx_redis_hit_rate_pct", {}, (hits / total) * 100);
    }

    // Replication
    const role = parsed["role"] ?? "master";
    metrics.setL("igfx_redis_role", { role }, 1);
    if (parsed["master_last_io_seconds_ago"]) {
      metrics.setL("igfx_redis_replication_lag_sec", {}, parseInt(parsed["master_last_io_seconds_ago"] ?? "0", 10));
    }

    // Rejected connections (backpressure indicator)
    const rejected = parseInt(parsed["rejected_connections"] ?? "0", 10);
    metrics.setL("igfx_redis_rejected_connections_total", {}, rejected);

  } catch { /* Redis blip — non-fatal */ }
}

function parseRedisInfo(info: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of info.split("\r\n")) {
    if (line.startsWith("#") || !line.includes(":")) continue;
    const idx = line.indexOf(":");
    result[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return result;
}

// ── Register Redis gauge metrics ──────────────────────────────────────────────

metrics.register("igfx_redis_memory_used_bytes",           "gauge",   "Redis used memory in bytes");
metrics.register("igfx_redis_memory_utilization_pct",      "gauge",   "Redis memory utilization %");
metrics.register("igfx_redis_connected_clients",           "gauge",   "Redis connected clients");
metrics.register("igfx_redis_commands_per_sec",            "gauge",   "Redis commands per second");
metrics.register("igfx_redis_hit_rate_pct",                "gauge",   "Redis keyspace hit rate %");
metrics.register("igfx_redis_role",                        "gauge",   "Redis role (master=1)");
metrics.register("igfx_redis_replication_lag_sec",         "gauge",   "Replication lag in seconds");
metrics.register("igfx_redis_rejected_connections_total",  "gauge",   "Rejected Redis connections");
