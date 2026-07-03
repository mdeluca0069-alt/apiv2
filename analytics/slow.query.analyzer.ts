/**
 * Slow Query Analyzer
 *
 * Two data sources:
 *   1. In-process ring buffer from QueryTelemetry (all environments)
 *   2. pg_stat_statements extension (production PostgreSQL, requires
 *      CREATE EXTENSION pg_stat_statements in postgresql.conf)
 *
 * Provides:
 *   • Top slow queries with frequency, avg/max latency
 *   • Table-level scan statistics (seq_scans vs index_scans)
 *   • Partition health check (row counts and sizes per partition)
 *   • Actionable index recommendations based on observed patterns
 */

import { prisma }           from "../shared/db.js";
import { queryTelemetry }   from "../shared/query.telemetry.js";
import type { SlowQueryRecord } from "../shared/query.telemetry.js";

export type PgStatStatement = {
  query:         string;
  calls:         number;
  avgMs:         number;
  maxMs:         number;
  totalMs:       number;
  stddevMs:      number;
  avgRows:       number;
  cacheHitRatio: number;
};

export type TableScanStat = {
  tableName:   string;
  seqScans:    number;
  indexScans:  number;
  liveRows:    number;
  deadRows:    number;
  lastVacuum:  string | null;
  lastAnalyze: string | null;
  seqScanRatio: number;
};

export type PartitionInfo = {
  parentTable:    string;
  partitionName:  string;
  totalSize:      string;
  totalBytes:     number;
  liveRows:       number;
  lastAnalyzed:   string | null;
  lastVacuumed:   string | null;
};

export type SlowQueryAnalysis = {
  generatedAt:        string;
  capturedSlowQueries: SlowQueryRecord[];
  pgStatStatements:   PgStatStatement[] | null;
  pgStatAvailable:    boolean;
  tableScanStats:     TableScanStat[];
  partitionStats:     PartitionInfo[];
  recommendations:    string[];
  summary: {
    totalSlowCaptured:  number;
    worstAvgMs:         number;
    worstModel:         string;
    seqScanTables:      string[];
    partitionsHealthy:  boolean;
  };
};

const MONITORED_TABLES = [
  "LedgerEntry", "TradeAudit", "Position", "Order",
  "WalletAccount", "SwapAccrual", "OlosSignal", "Notification",
  "OutboxEvent", "AuditLog", "TradeAudit",
];

class SlowQueryAnalyzer {
  private async _tryPgStatStatements(): Promise<PgStatStatement[] | null> {
    const db = prisma as NonNullable<typeof prisma>;

    // Check extension availability first
    try {
      const ext = await db.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
        ) AS exists
      `;
      if (!ext[0]?.exists) return null;
    } catch {
      return null;
    }

    try {
      const rows = await db.$queryRaw<Array<{
        query:         string;
        calls:         bigint;
        total_exec_ms: number;
        min_exec_ms:   number;
        max_exec_ms:   number;
        stddev_ms:     number;
        rows:          bigint;
        shared_blks_hit:   bigint;
        shared_blks_read:  bigint;
      }>>`
        SELECT
          LEFT(query, 300)                AS query,
          calls,
          total_exec_time                 AS total_exec_ms,
          min_exec_time                   AS min_exec_ms,
          max_exec_time                   AS max_exec_ms,
          stddev_exec_time                AS stddev_ms,
          rows,
          shared_blks_hit,
          shared_blks_read
        FROM pg_stat_statements
        WHERE calls > 0
          AND total_exec_time / calls > 50
        ORDER BY total_exec_time / calls DESC
        LIMIT 25
      `;

      return rows.map((r) => {
        const calls = Number(r.calls);
        const rows  = Number(r.rows);
        const blksHit  = Number(r.shared_blks_hit);
        const blksRead = Number(r.shared_blks_read);
        const totalBlks = blksHit + blksRead;
        return {
          query:         r.query,
          calls,
          avgMs:         Math.round(r.total_exec_ms / calls),
          maxMs:         Math.round(r.max_exec_ms),
          totalMs:       Math.round(r.total_exec_ms),
          stddevMs:      Math.round(r.stddev_ms),
          avgRows:       calls > 0 ? Math.round(rows / calls) : 0,
          cacheHitRatio: totalBlks > 0 ? Math.round((blksHit / totalBlks) * 100) : 100,
        };
      });
    } catch {
      return null;
    }
  }

  private async _getTableScanStats(): Promise<TableScanStat[]> {
    const db = prisma as NonNullable<typeof prisma>;
    try {
      const rows = await db.$queryRaw<Array<{
        relname:          string;
        seq_scan:         bigint;
        idx_scan:         bigint | null;
        n_live_tup:       bigint;
        n_dead_tup:       bigint;
        last_vacuum:      Date | null;
        last_analyze:     Date | null;
      }>>`
        SELECT
          relname,
          seq_scan,
          idx_scan,
          n_live_tup,
          n_dead_tup,
          last_vacuum,
          last_analyze
        FROM pg_stat_user_tables
        WHERE relname = ANY(${MONITORED_TABLES}::text[])
        ORDER BY seq_scan DESC
      `;

      return rows.map((r) => {
        const seqScans   = Number(r.seq_scan);
        const idxScans   = Number(r.idx_scan ?? 0);
        const totalScans = seqScans + idxScans;
        return {
          tableName:    r.relname,
          seqScans,
          indexScans:   idxScans,
          liveRows:     Number(r.n_live_tup),
          deadRows:     Number(r.n_dead_tup),
          lastVacuum:   r.last_vacuum?.toISOString() ?? null,
          lastAnalyze:  r.last_analyze?.toISOString() ?? null,
          seqScanRatio: totalScans > 0 ? Math.round((seqScans / totalScans) * 100) : 0,
        };
      });
    } catch {
      return [];
    }
  }

  private async _getPartitionStats(): Promise<PartitionInfo[]> {
    const db = prisma as NonNullable<typeof prisma>;
    try {
      const rows = await db.$queryRaw<Array<{
        parent_table:   string;
        partition_name: string;
        total_size:     string;
        total_bytes:    bigint;
        live_rows:      bigint | null;
        last_analyzed:  Date | null;
        last_vacuumed:  Date | null;
      }>>`
        SELECT * FROM igfxpro_partition_stats
        ORDER BY parent_table, partition_name
      `;

      return rows.map((r) => ({
        parentTable:   r.parent_table,
        partitionName: r.partition_name,
        totalSize:     r.total_size,
        totalBytes:    Number(r.total_bytes),
        liveRows:      Number(r.live_rows ?? 0),
        lastAnalyzed:  r.last_analyzed?.toISOString() ?? null,
        lastVacuumed:  r.last_vacuumed?.toISOString() ?? null,
      }));
    } catch {
      // View may not exist yet (migration not applied)
      return [];
    }
  }

  private _generateRecommendations(
    pgStats:    PgStatStatement[] | null,
    scanStats:  TableScanStat[],
    partitions: PartitionInfo[],
    captured:   SlowQueryRecord[],
  ): string[] {
    const recs: string[] = [];

    // Seq scan ratio warning
    for (const t of scanStats) {
      if (t.seqScans > 100 && t.seqScanRatio > 60 && t.liveRows > 10_000) {
        recs.push(
          `HIGH SEQ SCAN: "${t.tableName}" has ${t.seqScans} sequential scans ` +
          `(${t.seqScanRatio}% of all scans, ${t.liveRows.toLocaleString()} rows). ` +
          `Review WHERE clauses and add missing indexes.`
        );
      }
    }

    // Dead row vacuum alert
    for (const t of scanStats) {
      const deadRatio = t.liveRows > 0 ? t.deadRows / t.liveRows : 0;
      if (deadRatio > 0.2 && t.deadRows > 10_000) {
        recs.push(
          `HIGH BLOAT: "${t.tableName}" has ${t.deadRows.toLocaleString()} dead rows ` +
          `(${Math.round(deadRatio * 100)}% dead ratio). Run VACUUM ANALYZE.`
        );
      }
    }

    // pg_stat_statements slow query patterns
    if (pgStats) {
      for (const q of pgStats.slice(0, 5)) {
        if (q.avgMs > 1_000) {
          recs.push(
            `SLOW QUERY (${q.avgMs}ms avg, ${q.calls} calls): ` +
            `${q.query.slice(0, 150)}… — consider EXPLAIN ANALYZE.`
          );
        }
        if (q.cacheHitRatio < 80) {
          recs.push(
            `LOW CACHE HIT (${q.cacheHitRatio}%): query "${q.query.slice(0, 80)}…" ` +
            `is reading from disk frequently. Consider pg_prewarm or increasing shared_buffers.`
          );
        }
      }
    }

    // In-process slow query patterns
    const modelFreq = new Map<string, number>();
    for (const sq of captured) {
      modelFreq.set(sq.model, (modelFreq.get(sq.model) ?? 0) + 1);
    }
    for (const [model, freq] of modelFreq) {
      if (freq >= 5) {
        recs.push(
          `REPEATED SLOW QUERIES: "${model}" appears ${freq}× in slow query log. ` +
          `Review query patterns and indexes for this model.`
        );
      }
    }

    // Partition health
    if (partitions.length > 0) {
      const stalePartitions = partitions.filter(
        (p) => !p.lastAnalyzed || Date.now() - new Date(p.lastAnalyzed).getTime() > 7 * 24 * 60 * 60 * 1000,
      );
      if (stalePartitions.length > 3) {
        recs.push(
          `STALE PARTITIONS: ${stalePartitions.length} partition(s) haven't been analyzed in >7 days. ` +
          `Enable autovacuum or schedule ANALYZE on these partitions.`
        );
      }
    }

    if (recs.length === 0) {
      recs.push("No significant performance issues detected.");
    }

    return recs;
  }

  async analyze(): Promise<SlowQueryAnalysis> {
    const generatedAt = new Date().toISOString();

    if (!prisma) {
      return {
        generatedAt,
        capturedSlowQueries: queryTelemetry.getSlowQueries(50),
        pgStatStatements:    null,
        pgStatAvailable:     false,
        tableScanStats:      [],
        partitionStats:      [],
        recommendations:     ["Database not connected — limited analysis available."],
        summary: {
          totalSlowCaptured: queryTelemetry.getSlowQueries().length,
          worstAvgMs:        0,
          worstModel:        "n/a",
          seqScanTables:     [],
          partitionsHealthy: false,
        },
      };
    }

    const [pgStats, scanStats, partitions] = await Promise.all([
      this._tryPgStatStatements(),
      this._getTableScanStats(),
      this._getPartitionStats(),
    ]);

    const captured = queryTelemetry.getSlowQueries(100);
    const recs = this._generateRecommendations(pgStats, scanStats, partitions, captured);

    // Summary computation
    const worstCapture = captured[0];
    const seqScanTables = scanStats
      .filter((t) => t.seqScans > 50 && t.seqScanRatio > 50)
      .map((t) => t.tableName);

    const partitionsHealthy =
      partitions.length === 0 ||
      partitions.every((p) => {
        if (!p.lastAnalyzed) return true;
        return Date.now() - new Date(p.lastAnalyzed).getTime() < 14 * 24 * 60 * 60 * 1000;
      });

    return {
      generatedAt,
      capturedSlowQueries: captured.slice(0, 50),
      pgStatStatements:    pgStats,
      pgStatAvailable:     pgStats !== null,
      tableScanStats:      scanStats,
      partitionStats:      partitions,
      recommendations:     recs,
      summary: {
        totalSlowCaptured: captured.length,
        worstAvgMs:        worstCapture?.durationMs ?? 0,
        worstModel:        worstCapture?.model ?? "none",
        seqScanTables,
        partitionsHealthy,
      },
    };
  }
}

export const slowQueryAnalyzer = new SlowQueryAnalyzer();
