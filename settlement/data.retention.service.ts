/**
 * Data Retention Service
 *
 * Enforces per-table retention policies for the IGFXPRO broker platform.
 * Runs on a daily schedule; each table's policy is independently configurable
 * via environment variables.
 *
 * Regulatory obligations (never delete):
 *   • LedgerEntry:          7 years  (MiFID II Article 25, financial records)
 *   • TradeAudit:           7 years  (MiFID II order records)
 *   • AuditLog:             7 years  (MiFID II audit trail)
 *   • DepositTransaction:   7 years  (AML / payment regulations)
 *   • KycCase + documents:  5 years  (AMLD5 verification records)
 *
 * Operational / non-regulatory (safe to purge after shorter period):
 *   • Notification:         90 days  (in-app notification feed)
 *   • MarginSnapshot:       365 days (daily margin snapshots)
 *   • OutboxEvent:          2 hours  (already handled in main.ts)
 *   • Session (expired):    30 days  (stale refresh tokens)
 *   • AccountDailySnapshot: 7 years  (portfolio analytics history)
 *   • RiskWarning:          365 days (acknowledged risk alerts)
 *   • SignalTelemetry:      2 years  (OLOS signal performance data)
 *
 * Partition lifecycle (LedgerEntry + TradeAudit):
 *   Automatically creates next-month partitions before month boundary.
 *   Old partitions are NEVER dropped — they are reported as archivable
 *   but actual detach/drop requires explicit admin action.
 */

import { prisma } from "../shared/db.js";
import { metrics } from "../gateway/metrics.js";

export type RetentionPolicy = {
  table:         string;
  retainDays:    number;
  description:   string;
  canDelete:     boolean;  // false = regulatory — log only, never delete
};

export type RetentionRun = {
  table:       string;
  retainDays:  number;
  cutoffDate:  string;
  deleted:     number;
  skipped:     boolean;
  reason?:     string;
};

export type RetentionReport = {
  runAt:          string;
  durationMs:     number;
  totalDeleted:   number;
  runs:           RetentionRun[];
  partitionStatus: PartitionStatus[];
  nextRunAt:      string;
};

export type PartitionStatus = {
  parentTable:    string;
  partitionName:  string;
  created:        boolean;
  fromDate:       string;
  toDate:         string;
};

const POLICIES: RetentionPolicy[] = [
  // Regulatory — never delete (report only)
  {
    table: "LedgerEntry",
    retainDays: Number(process.env.LEDGER_RETENTION_DAYS ?? 7 * 365),
    description: "MiFID II financial records (7-year minimum)",
    canDelete: false,
  },
  {
    table: "TradeAudit",
    retainDays: Number(process.env.TRADE_AUDIT_RETENTION_DAYS ?? 7 * 365),
    description: "MiFID II order records (7-year minimum)",
    canDelete: false,
  },
  {
    table: "AuditLog",
    retainDays: Number(process.env.AUDIT_LOG_RETENTION_DAYS ?? 7 * 365),
    description: "MiFID II audit trail (7-year minimum)",
    canDelete: false,
  },
  {
    table: "DepositTransaction",
    retainDays: Number(process.env.DEPOSIT_RETENTION_DAYS ?? 7 * 365),
    description: "AML/Payment regulation records (7-year minimum)",
    canDelete: false,
  },
  // Operational — safe to purge
  {
    table: "Notification",
    retainDays: Number(process.env.NOTIFICATION_RETENTION_DAYS ?? 90),
    description: "In-app notification feed (90-day default)",
    canDelete: true,
  },
  {
    table: "MarginSnapshot",
    retainDays: Number(process.env.MARGIN_SNAPSHOT_RETENTION_DAYS ?? 365),
    description: "Daily margin snapshots (1-year default)",
    canDelete: true,
  },
  {
    table: "Session",
    retainDays: Number(process.env.SESSION_RETENTION_DAYS ?? 30),
    description: "Expired refresh tokens (30-day default)",
    canDelete: true,
  },
  {
    table: "RiskWarning",
    retainDays: Number(process.env.RISK_WARNING_RETENTION_DAYS ?? 365),
    description: "Acknowledged risk alerts (1-year default)",
    canDelete: true,
  },
  {
    table: "SignalTelemetry",
    retainDays: Number(process.env.SIGNAL_TELEMETRY_RETENTION_DAYS ?? 2 * 365),
    description: "OLOS signal performance data (2-year default)",
    canDelete: true,
  },
];

class DataRetentionService {
  private lastRunAt: Date | null = null;
  private lastReport: RetentionReport | null = null;

  getPolicies(): RetentionPolicy[] {
    return POLICIES;
  }

  getLastReport(): RetentionReport | null {
    return this.lastReport;
  }

  private async _deleteOldNotifications(cutoff: Date): Promise<number> {
    const db = prisma as NonNullable<typeof prisma>;
    const r = await db.notification.deleteMany({
      where: { sent: true, createdAt: { lt: cutoff } },
    });
    return r.count;
  }

  private async _deleteOldMarginSnapshots(cutoff: Date): Promise<number> {
    const db = prisma as NonNullable<typeof prisma>;
    const r = await db.marginSnapshot.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return r.count;
  }

  private async _deleteExpiredSessions(cutoff: Date): Promise<number> {
    const db = prisma as NonNullable<typeof prisma>;
    const r = await db.session.deleteMany({
      where: {
        expiresAt: { lt: cutoff },
        createdAt:  { lt: cutoff },
      },
    });
    return r.count;
  }

  private async _deleteAcknowledgedRiskWarnings(cutoff: Date): Promise<number> {
    const db = prisma as NonNullable<typeof prisma>;
    const r = await db.riskWarning.deleteMany({
      where: { acknowledged: true, acknowledgedAt: { lt: cutoff } },
    });
    return r.count;
  }

  private async _deleteOldSignalTelemetry(cutoff: Date): Promise<number> {
    const db = prisma as NonNullable<typeof prisma>;
    // Only delete CLOSED or EXPIRED signals — never delete PENDING
    const r = await db.signalTelemetry.deleteMany({
      where: {
        outcome:   { in: ["WIN", "LOSS", "BREAKEVEN", "EXPIRED"] },
        closedAt:  { lt: cutoff },
      },
    });
    return r.count;
  }

  private async _ensureNextPartitions(): Promise<PartitionStatus[]> {
    const db = prisma as NonNullable<typeof prisma>;
    try {
      const rows = await db.$queryRaw<Array<{
        parent_table:   string;
        partition_name: string;
        created:        boolean;
        from_date:      string;
        to_date:        string;
      }>>`SELECT * FROM igfxpro_create_next_partitions()`;

      const result: PartitionStatus[] = rows.map((r) => ({
        parentTable:   r.parent_table,
        partitionName: r.partition_name,
        created:       r.created,
        fromDate:      r.from_date,
        toDate:        r.to_date,
      }));

      const newPartitions = result.filter((p) => p.created);
      if (newPartitions.length > 0) {
        console.log(
          `[retention] auto-created ${newPartitions.length} partition(s): ` +
          newPartitions.map((p) => p.partitionName).join(", "),
        );
      }

      return result;
    } catch (err) {
      // Function may not exist if migration hasn't run yet
      console.warn("[retention] partition creation skipped:", (err as Error).message);
      return [];
    }
  }

  private _computeRetentionViolations(): Array<{ table: string; oldestAllowed: string; note: string }> {
    return POLICIES
      .filter((p) => !p.canDelete)
      .map((p) => ({
        table:         p.table,
        oldestAllowed: new Date(Date.now() - p.retainDays * 86_400_000).toISOString(),
        note:          p.description,
      }));
  }

  async run(): Promise<RetentionReport> {
    const start = Date.now();
    const runAt = new Date().toISOString();

    if (!prisma) {
      const report: RetentionReport = {
        runAt,
        durationMs:     0,
        totalDeleted:   0,
        runs:           [],
        partitionStatus: [],
        nextRunAt:      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
      this.lastReport = report;
      return report;
    }

    const runs: RetentionRun[] = [];
    let totalDeleted = 0;

    // Run each operational policy
    const policyRunners: Array<[string, (cutoff: Date) => Promise<number>]> = [
      ["Notification",    (c) => this._deleteOldNotifications(c)],
      ["MarginSnapshot",  (c) => this._deleteOldMarginSnapshots(c)],
      ["Session",         (c) => this._deleteExpiredSessions(c)],
      ["RiskWarning",     (c) => this._deleteAcknowledgedRiskWarnings(c)],
      ["SignalTelemetry", (c) => this._deleteOldSignalTelemetry(c)],
    ];

    for (const policy of POLICIES) {
      const cutoff = new Date(Date.now() - policy.retainDays * 86_400_000);

      if (!policy.canDelete) {
        // Regulatory records — log compliance status only
        runs.push({
          table:      policy.table,
          retainDays: policy.retainDays,
          cutoffDate: cutoff.toISOString(),
          deleted:    0,
          skipped:    true,
          reason:     `Regulatory: ${policy.description}`,
        });
        continue;
      }

      const runner = policyRunners.find(([name]) => name === policy.table);
      if (!runner) {
        runs.push({
          table:      policy.table,
          retainDays: policy.retainDays,
          cutoffDate: cutoff.toISOString(),
          deleted:    0,
          skipped:    true,
          reason:     "No runner registered",
        });
        continue;
      }

      try {
        const deleted = await runner[1](cutoff);
        runs.push({
          table:      policy.table,
          retainDays: policy.retainDays,
          cutoffDate: cutoff.toISOString(),
          deleted,
          skipped:    false,
        });
        totalDeleted += deleted;

        if (deleted > 0) {
          console.log(`[retention] ${policy.table}: deleted ${deleted} rows older than ${policy.retainDays}d`);
        }
      } catch (err) {
        runs.push({
          table:      policy.table,
          retainDays: policy.retainDays,
          cutoffDate: cutoff.toISOString(),
          deleted:    0,
          skipped:    true,
          reason:     (err as Error).message,
        });
        console.error(`[retention] ${policy.table}: error — ${(err as Error).message}`);
      }
    }

    // Ensure next-month partitions exist
    const partitionStatus = await this._ensureNextPartitions();

    const durationMs = Date.now() - start;
    const nextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    this.lastRunAt = new Date();

    metrics.inc("retention_rows_deleted_total", totalDeleted);
    metrics.set("retention_last_run_ts", Date.now() / 1000);

    const report: RetentionReport = {
      runAt,
      durationMs,
      totalDeleted,
      runs,
      partitionStatus,
      nextRunAt,
    };

    this.lastReport = report;
    console.log(
      `[retention] run complete: deleted=${totalDeleted} ` +
      `partitions=${partitionStatus.filter((p) => p.created).length} new ` +
      `duration=${durationMs}ms`,
    );
    return report;
  }

  getStatus() {
    return {
      lastRunAt:      this.lastRunAt?.toISOString() ?? null,
      policies:       POLICIES.map((p) => ({
        table:       p.table,
        retainDays:  p.retainDays,
        description: p.description,
        canDelete:   p.canDelete,
      })),
      regulatoryCompliance: this._computeRetentionViolations(),
    };
  }
}

export const dataRetentionService = new DataRetentionService();
