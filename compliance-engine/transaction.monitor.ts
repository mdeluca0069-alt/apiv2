/**
 * TransactionMonitor — real-time transaction monitoring for suspicious patterns.
 * Integrates with AmlEngine; called on every deposit/withdrawal and periodically
 * for batch review of ledger activity.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { immutableAudit } from "../security/immutable.audit.js";
import { amlEngine }  from "./aml.engine.js";
import { eventBus }   from "../events-bus/event.bus.js";

export type MonitorResult = {
  flagged:    boolean;
  riskLevel:  "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  flags:      string[];
  actionTaken: string;
  monitoredAt: string;
};

export class TransactionMonitor {

  /** Monitor a new ledger transaction in real-time. */
  async monitor(
    userId:          string,
    amount:          number,
    transactionType: "DEPOSIT" | "WITHDRAWAL",
    reference?:      string,
  ): Promise<MonitorResult> {
    const assessment = await amlEngine.assess(userId, amount, transactionType, reference);
    const monitoredAt = new Date().toISOString();

    let actionTaken = "ALLOWED";
    if (assessment.risk === "CRITICAL" || assessment.requiresSar) {
      actionTaken = "FLAGGED_FOR_SAR";
    } else if (assessment.risk === "HIGH") {
      actionTaken = "FLAGGED_FOR_REVIEW";
    }

    if (IS_PERSISTENT && assessment.risk !== "LOW") {
      await immutableAudit.write({
        actor:   "TRANSACTION_MONITOR",
        action:  `tx.monitor.${actionTaken.toLowerCase()}`,
        entity:  userId,
        payload: { amount, transactionType, reference, assessment, actionTaken } as object,
      });

      if (assessment.risk === "CRITICAL") {
        // FASE 7 CLOSURE, Phase A (M.6): was "risk.warning", see aml.engine.ts.
        eventBus.emit("compliance.alert", {
          userId, type: "TRANSACTION_FLAGGED", severity: "CRITICAL",
          message: `Transaction of ${amount} USD flagged: ${assessment.flags.map((f) => f.code).join(", ")}`,
          payload: assessment,
        });
      }
    }

    return {
      flagged:    assessment.risk !== "LOW",
      riskLevel:  assessment.risk,
      flags:      assessment.flags.map((f) => f.code),
      actionTaken,
      monitoredAt,
    };
  }

  /** Batch review — scan all ledger entries from the past N hours. */
  async batchReview(hours = 24): Promise<{ reviewed: number; flagged: number }> {
    if (!IS_PERSISTENT) return { reviewed: 0, flagged: 0 };

    const since = new Date(Date.now() - hours * 3_600_000);
    const entries = await (prisma as NonNullable<typeof prisma>).ledgerEntry.findMany({
      where: {
        type:      { in: ["DEPOSIT_REQUEST", "WITHDRAW_REQUEST"] },
        createdAt: { gte: since },
      },
      select: { id: true, userId: true, amount: true, type: true, reference: true },
      take: 500,
    });

    let flagged = 0;
    for (const entry of entries) {
      const type = entry.type.includes("DEPOSIT") ? "DEPOSIT" as const : "WITHDRAWAL" as const;
      const result = await this.monitor(entry.userId, Math.abs(Number(entry.amount)), type, entry.id);
      if (result.flagged) flagged++;
    }

    return { reviewed: entries.length, flagged };
  }
}

export const transactionMonitor = new TransactionMonitor();
export default transactionMonitor;
