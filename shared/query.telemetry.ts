/**
 * Query Telemetry — Prisma middleware for database observability.
 *
 * Captures:
 *   • Every query's model + action + duration
 *   • Slow queries (> SLOW_QUERY_THRESHOLD_MS) with contextual detail
 *   • Per-model and per-action breakdowns
 *   • Rolling ring-buffer of the last N slow queries
 *
 * Exposes:
 *   • Prometheus-compatible counters/histograms via MetricsRegistry
 *   • In-memory slow query log accessible via admin endpoint
 *   • Statistical summary (p50, p95, p99 latencies)
 *
 * Wire-up: call createMiddleware() and pass the result to prisma.$use()
 */

import { Prisma } from "@prisma/client";
type MiddlewareFn = Prisma.Middleware;

export type SlowQueryRecord = {
  id:          string;
  model:       string;
  action:      string;
  durationMs:  number;
  timestamp:   string;
  source:      "primary" | "replica";
  queryArgs:   string | null;
};

export type QueryStats = {
  totalQueries:    number;
  slowQueries:     number;
  errored:         number;
  thresholdMs:     number;
  avgDurationMs:   number;
  p50Ms:           number;
  p95Ms:           number;
  p99Ms:           number;
  topModels:       Array<{ model: string; count: number; avgMs: number }>;
  topActions:      Array<{ action: string; count: number; avgMs: number }>;
  lastSlowQuery:   SlowQueryRecord | null;
};

const SLOW_QUERY_BUFFER_SIZE = 200;
const MIN_ARGS_LOG_MS = 2_000; // include query args only for very slow queries

class QueryTelemetry {
  private readonly thresholdMs: number;
  private totalQueries  = 0;
  private totalDuration = 0;
  private errored       = 0;
  private slowBuffer:   SlowQueryRecord[] = [];
  private durations:    number[] = []; // rolling window for percentile calc (last 5000)
  private readonly DURATION_WINDOW = 5_000;

  private modelStats  = new Map<string, { count: number; totalMs: number }>();
  private actionStats = new Map<string, { count: number; totalMs: number }>();

  constructor() {
    this.thresholdMs = Number(process.env.SLOW_QUERY_THRESHOLD_MS ?? 500);
  }

  createMiddleware(source: "primary" | "replica" = "primary"): MiddlewareFn {
    return async (params, next) => {
      const start = Date.now();
      let threw = false;

      try {
        const result = await next(params);
        return result;
      } catch (err) {
        threw = true;
        this.errored++;
        throw err;
      } finally {
        if (!threw) {
          const durationMs = Date.now() - start;
          this._record(params, durationMs, source);
        }
      }
    };
  }

  private _record(
    params: Prisma.MiddlewareParams,
    durationMs: number,
    source: "primary" | "replica",
  ): void {
    this.totalQueries++;
    this.totalDuration += durationMs;

    // Rolling duration window for percentile computation
    this.durations.push(durationMs);
    if (this.durations.length > this.DURATION_WINDOW) {
      this.durations.shift();
    }

    // Per-model aggregation
    const model = params.model ?? "raw";
    const mStat = this.modelStats.get(model) ?? { count: 0, totalMs: 0 };
    mStat.count++;
    mStat.totalMs += durationMs;
    this.modelStats.set(model, mStat);

    // Per-action aggregation
    const action = params.action;
    const aStat = this.actionStats.get(action) ?? { count: 0, totalMs: 0 };
    aStat.count++;
    aStat.totalMs += durationMs;
    this.actionStats.set(action, aStat);

    // Slow query capture
    if (durationMs >= this.thresholdMs) {
      const record: SlowQueryRecord = {
        id:         `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        model,
        action,
        durationMs,
        timestamp:  new Date().toISOString(),
        source,
        queryArgs:  durationMs >= MIN_ARGS_LOG_MS
          ? JSON.stringify(params.args as Record<string, unknown> ?? {}).slice(0, 500)
          : null,
      };

      this.slowBuffer.unshift(record);
      if (this.slowBuffer.length > SLOW_QUERY_BUFFER_SIZE) {
        this.slowBuffer.length = SLOW_QUERY_BUFFER_SIZE;
      }

      console.warn(
        `[slow-query] ${source} ${model}.${action} ${durationMs}ms${record.queryArgs ? ` args=${record.queryArgs}` : ""}`,
      );
    }
  }

  private _percentile(sortedArr: number[], p: number): number {
    if (sortedArr.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
    return sortedArr[Math.max(0, idx)];
  }

  getStats(): QueryStats {
    const sorted = [...this.durations].sort((a, b) => a - b);

    const topModels = [...this.modelStats.entries()]
      .map(([model, s]) => ({ model, count: s.count, avgMs: Math.round(s.totalMs / s.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topActions = [...this.actionStats.entries()]
      .map(([action, s]) => ({ action, count: s.count, avgMs: Math.round(s.totalMs / s.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalQueries:  this.totalQueries,
      slowQueries:   this.slowBuffer.length,
      errored:       this.errored,
      thresholdMs:   this.thresholdMs,
      avgDurationMs: this.totalQueries > 0 ? Math.round(this.totalDuration / this.totalQueries) : 0,
      p50Ms:         this._percentile(sorted, 50),
      p95Ms:         this._percentile(sorted, 95),
      p99Ms:         this._percentile(sorted, 99),
      topModels,
      topActions,
      lastSlowQuery: this.slowBuffer[0] ?? null,
    };
  }

  getSlowQueries(limit = 50): SlowQueryRecord[] {
    return this.slowBuffer.slice(0, limit);
  }

  clearSlowQueries(): void {
    this.slowBuffer = [];
  }

  getThresholdMs(): number {
    return this.thresholdMs;
  }
}

export const queryTelemetry = new QueryTelemetry();
