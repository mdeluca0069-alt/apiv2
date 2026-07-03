/**
 * AML Engine — Anti-Money Laundering transaction analysis.
 *
 * Runs heuristic-based pattern detection on every deposit/withdrawal and
 * on large single transactions. Generates ComplianceAlert records and
 * writes immutable AuditLog entries.
 *
 * For production: wire to a real AML provider (ComplyAdvantage, Onfido,
 * LexisNexis) by implementing the AmlProvider interface below.
 */
import { randomUUID }    from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }      from "../events-bus/event.bus.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const LARGE_TRANSACTION_THRESHOLD = 10_000;   // USD — triggers SAR review
const STRUCTURING_WINDOW_HOURS    = 24;        // hours to aggregate for structuring
const STRUCTURING_THRESHOLD       = 9_900;     // just-below reporting limit
const MAX_DAILY_DEPOSITS          = 5;         // flag if more than N deposits in 24h
const RAPID_CYCLE_MINUTES         = 60;        // flag if deposit+withdraw within N min

export type AmlRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type AmlFlag = {
  code:     string;
  message:  string;
  risk:     AmlRisk;
  details?: Record<string, unknown>;
};

export type AmlAssessment = {
  userId:     string;
  risk:       AmlRisk;
  flags:      AmlFlag[];
  requiresSar: boolean;
  assessedAt: string;
};

// ─── AML Engine ───────────────────────────────────────────────────────────────

export class AmlEngine {

  /**
   * Assess a new financial transaction for AML risk.
   * Called on every deposit and withdrawal request.
   */
  async assess(
    userId:         string,
    amount:         number,
    transactionType: "DEPOSIT" | "WITHDRAWAL",
    reference?:     string,
  ): Promise<AmlAssessment> {
    const flags: AmlFlag[] = [];
    const assessedAt = new Date().toISOString();

    // ── 1. Large transaction check ────────────────────────────────────────────
    if (amount >= LARGE_TRANSACTION_THRESHOLD) {
      flags.push({
        code:    "LARGE_TRANSACTION",
        message: `${transactionType} of ${amount.toFixed(2)} USD exceeds reporting threshold`,
        risk:    amount >= LARGE_TRANSACTION_THRESHOLD * 5 ? "CRITICAL" : "HIGH",
        details: { amount, threshold: LARGE_TRANSACTION_THRESHOLD },
      });
    }

    // ── 2. Structuring check (just-below reporting limit) ─────────────────────
    if (!IS_PERSISTENT) {
      return this._buildAssessment(userId, flags, assessedAt);
    }

    const windowStart = new Date(Date.now() - STRUCTURING_WINDOW_HOURS * 3_600_000);
    const recentDeposits = await (prisma as NonNullable<typeof prisma>).ledgerEntry.aggregate({
      where: {
        userId,
        type:      { in: ["DEPOSIT_REQUEST", "ADMIN_CAPITAL_ALLOCATION"] },
        createdAt: { gte: windowStart },
      },
      _sum: { amount: true },
      _count: true,
    });

    const windowTotal  = recentDeposits._sum.amount ? Number(recentDeposits._sum.amount) : 0;
    const depositCount = recentDeposits._count;

    if (windowTotal + amount >= STRUCTURING_THRESHOLD && windowTotal + amount < LARGE_TRANSACTION_THRESHOLD) {
      flags.push({
        code:    "STRUCTURING_PATTERN",
        message: `Cumulative deposits ${(windowTotal + amount).toFixed(2)} USD in ${STRUCTURING_WINDOW_HOURS}h suggest structuring`,
        risk:    "HIGH",
        details: { windowTotal, newAmount: amount, windowHours: STRUCTURING_WINDOW_HOURS },
      });
    }

    // ── 3. Frequency check (many small deposits) ───────────────────────────────
    if (depositCount >= MAX_DAILY_DEPOSITS) {
      flags.push({
        code:    "HIGH_FREQUENCY_DEPOSITS",
        message: `${depositCount} deposits in last ${STRUCTURING_WINDOW_HOURS}h`,
        risk:    "MEDIUM",
        details: { count: depositCount, window: `${STRUCTURING_WINDOW_HOURS}h` },
      });
    }

    // ── 4. Rapid cycle (deposit immediately followed by withdrawal) ───────────
    if (transactionType === "WITHDRAWAL") {
      const cycleWindow = new Date(Date.now() - RAPID_CYCLE_MINUTES * 60_000);
      const recentCredit = await (prisma as NonNullable<typeof prisma>).ledgerEntry.findFirst({
        where: {
          userId,
          type:      { in: ["DEPOSIT_REQUEST", "ADMIN_CAPITAL_ALLOCATION"] },
          status:    "COMPLETED",
          createdAt: { gte: cycleWindow },
        },
        orderBy: { createdAt: "desc" },
      });

      if (recentCredit) {
        flags.push({
          code:    "RAPID_DEPOSIT_WITHDRAWAL",
          message: `Withdrawal within ${RAPID_CYCLE_MINUTES}min of credit — possible pass-through`,
          risk:    "HIGH",
          details: { creditId: recentCredit.id, minutes: RAPID_CYCLE_MINUTES },
        });
      }
    }

    const assessment = this._buildAssessment(userId, flags, assessedAt);

    // Persist AML result
    await this._persist(userId, amount, transactionType, assessment, reference);

    return assessment;
  }

  private _buildAssessment(userId: string, flags: AmlFlag[], assessedAt: string): AmlAssessment {
    const maxRisk = this._maxRisk(flags);
    return {
      userId,
      risk:        maxRisk,
      flags,
      requiresSar: maxRisk === "CRITICAL" || flags.some((f) => f.code === "STRUCTURING_PATTERN"),
      assessedAt,
    };
  }

  private _maxRisk(flags: AmlFlag[]): AmlRisk {
    if (flags.some((f) => f.risk === "CRITICAL")) return "CRITICAL";
    if (flags.some((f) => f.risk === "HIGH"))     return "HIGH";
    if (flags.some((f) => f.risk === "MEDIUM"))   return "MEDIUM";
    return "LOW";
  }

  private async _persist(
    userId:          string,
    amount:          number,
    transactionType: string,
    assessment:      AmlAssessment,
    reference?:      string,
  ): Promise<void> {
    if (!IS_PERSISTENT) return;

    const db = prisma as NonNullable<typeof prisma>;
    await db.auditLog.create({
      data: {
        id:      randomUUID(),
        actor:   "AML_ENGINE",
        action:  `aml.assessment.${assessment.risk.toLowerCase()}`,
        entity:  userId,
        payload: {
          amount, transactionType, reference,
          risk:       assessment.risk,
          flags:      assessment.flags,
          requiresSar: assessment.requiresSar,
        } as object,
      },
    });

    if (assessment.risk !== "LOW") {
      eventBus.emit("risk.warning", {
        userId,
        type:     "AML_FLAG",
        severity: assessment.risk,
        message:  `AML ${assessment.risk} risk: ${assessment.flags.map((f) => f.code).join(", ")}`,
        payload:  assessment,
      });
    }
  }
}

export const amlEngine = new AmlEngine();
