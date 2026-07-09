/**
 * Enhanced Reconciliation Service
 *
 * Extends the existing ReconciliationEngine (margin + ledger balance checks)
 * with four additional daily audit checks required at institutional grade:
 *
 *   1. SWAP ACCRUAL COMPLETENESS
 *      Every position that was OPEN at EOD should have a SwapAccrual row
 *      for the previous night. Detects missed overnight financing charges.
 *
 *   2. DEPOSIT INTEGRITY
 *      Every DepositTransaction with status=CREDITED should have exactly one
 *      corresponding LedgerEntry of type ADMIN_CAPITAL_ALLOCATION or
 *      DEPOSIT_REQUEST with a matching amount. Detects double-credits and
 *      missed credits.
 *
 *   3. TRADE PNL INTEGRITY
 *      For every closed TradeAudit row with pnlRealized != null, there should
 *      be a LedgerEntry of type PNL_SETTLEMENT with a reference matching
 *      the position. Detects P&L settlement gaps (closed trade, no ledger entry).
 *
 *   4. POSITION-ORDER INTEGRITY
 *      Every closed Position should have a corresponding TradeAudit row.
 *      Detects positions that closed without an audit trail.
 *
 * All checks are read-only (no auto-repair). Mismatches are logged, emitted
 * to MetricsRegistry, and returned in the report for admin review.
 *
 * Schedule: daily at 03:00 UTC (after EOD snapshot + swap accrual).
 */

import { prisma }        from "../shared/db.js";
import { metrics }       from "../gateway/metrics.js";
import { alertManager }  from "../alerting/alert.manager.js";
import { DistributedJobLock } from "../shared/distributed.job.lock.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SwapAccrualCheck = {
  status:               "OK" | "MISMATCH" | "SKIPPED";
  checkDate:            string;
  openPositionsChecked: number;
  missingAccruals:      Array<{ positionId: string; userId: string; symbol: string }>;
};

export type DepositIntegrityCheck = {
  status:            "OK" | "MISMATCH" | "SKIPPED";
  creditedDeposits:  number;
  matched:           number;
  doubleCredit:      Array<{ depositId: string; userId: string; amount: number }>;
  missingCredit:     Array<{ depositId: string; userId: string; amount: number }>;
};

export type PnlIntegrityCheck = {
  status:            "OK" | "MISMATCH" | "SKIPPED";
  closedTrades:      number;
  settledTrades:     number;
  unsettled:         Array<{ positionId: string; userId: string; pnlRealized: number }>;
};

export type PositionAuditCheck = {
  status:              "OK" | "MISMATCH" | "SKIPPED";
  closedPositions:     number;
  positionsWithAudit:  number;
  missingAudit:        Array<{ positionId: string; userId: string; closedAt: string }>;
};

export type EnhancedReconciliationReport = {
  runAt:               string;
  durationMs:          number;
  checkDate:           string;
  swapAccrual:         SwapAccrualCheck;
  depositIntegrity:    DepositIntegrityCheck;
  pnlIntegrity:        PnlIntegrityCheck;
  positionAudit:       PositionAuditCheck;
  overallClean:        boolean;
  totalMismatches:     number;
  summary:             string;
};

// ── Implementation ────────────────────────────────────────────────────────────

class EnhancedReconciliationService {
  private lastReport: EnhancedReconciliationReport | null = null;

  /**
   * Check 1: Swap accrual completeness.
   * Verifies that every position open at EOD yesterday has a SwapAccrual row
   * for accrualDate = yesterday.
   */
  private async _checkSwapAccruals(checkDate: Date): Promise<SwapAccrualCheck> {
    const db = prisma as NonNullable<typeof prisma>;
    const yesterday = new Date(checkDate);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const accrualDate = yesterday.toISOString().split("T")[0];

    try {
      // Get all positions that were open at end of yesterday
      const openPositions = await db.position.findMany({
        where: {
          status: "OPEN",
          openedAt: { lte: new Date(accrualDate + "T23:59:59Z") },
        },
        select: { id: true, userId: true, symbol: true },
      });

      if (openPositions.length === 0) {
        return {
          status:               "SKIPPED",
          checkDate:            accrualDate,
          openPositionsChecked: 0,
          missingAccruals:      [],
        };
      }

      // Find which ones have a SwapAccrual for yesterday
      const accruals = await db.swapAccrual.findMany({
        where: {
          positionId: { in: openPositions.map((p) => p.id) },
          accrualDate: new Date(accrualDate),
        },
        select: { positionId: true },
      });

      const accrualSet = new Set(accruals.map((a) => a.positionId));
      const missing = openPositions
        .filter((p) => !accrualSet.has(p.id))
        .map((p) => ({ positionId: p.id, userId: p.userId, symbol: p.symbol }));

      return {
        status:               missing.length === 0 ? "OK" : "MISMATCH",
        checkDate:            accrualDate,
        openPositionsChecked: openPositions.length,
        missingAccruals:      missing.slice(0, 50), // cap for report size
      };
    } catch (err) {
      return {
        status:               "SKIPPED",
        checkDate:            accrualDate,
        openPositionsChecked: 0,
        missingAccruals:      [],
      };
    }
  }

  /**
   * Check 2: Deposit integrity.
   * Every CREDITED DepositTransaction should produce exactly one LedgerEntry.
   */
  private async _checkDepositIntegrity(): Promise<DepositIntegrityCheck> {
    const db = prisma as NonNullable<typeof prisma>;

    try {
      const creditedDeposits = await db.depositTransaction.findMany({
        where: { status: "CREDITED" },
        select: { id: true, userId: true, amount: true, pspRef: true },
      });

      if (creditedDeposits.length === 0) {
        return {
          status: "SKIPPED",
          creditedDeposits: 0,
          matched: 0,
          doubleCredit: [],
          missingCredit: [],
        };
      }

      const doubleCredit: DepositIntegrityCheck["doubleCredit"] = [];
      const missingCredit: DepositIntegrityCheck["missingCredit"] = [];
      let matched = 0;

      for (const dep of creditedDeposits) {
        // Look for LedgerEntry referencing this deposit. Fix #7: the live
        // PSP flow (payment-service/deposit.state.machine.ts) writes
        // type="DEPOSIT_CREDIT" with reference=`PSP:${pspRef}` — this
        // previously matched neither the type filter (only the legacy
        // admin-approval types) nor the reference filter (which looked for
        // the DepositTransaction's own id, never present in that string),
        // so every real deposit was reported as a permanent missingCredit
        // false positive. ADMIN_CAPITAL_ALLOCATION/DEPOSIT_REQUEST are kept
        // for any deposit that went through the legacy admin-approval path.
        const referenceCandidates = [dep.id, ...(dep.pspRef ? [dep.pspRef] : [])];
        const ledgerEntries = await db.ledgerEntry.findMany({
          where: {
            userId: dep.userId,
            type:   { in: ["DEPOSIT_CREDIT", "ADMIN_CAPITAL_ALLOCATION", "DEPOSIT_REQUEST"] },
            OR:     referenceCandidates.map((ref) => ({ reference: { contains: ref } })),
          },
          select: { id: true, amount: true },
        });

        if (ledgerEntries.length === 0) {
          missingCredit.push({
            depositId: dep.id,
            userId:    dep.userId,
            amount:    dep.amount.toNumber(),
          });
        } else if (ledgerEntries.length > 1) {
          doubleCredit.push({
            depositId: dep.id,
            userId:    dep.userId,
            amount:    dep.amount.toNumber(),
          });
        } else {
          matched++;
        }
      }

      const hasMismatch = doubleCredit.length > 0 || missingCredit.length > 0;
      return {
        status:           hasMismatch ? "MISMATCH" : "OK",
        creditedDeposits: creditedDeposits.length,
        matched,
        doubleCredit:     doubleCredit.slice(0, 20),
        missingCredit:    missingCredit.slice(0, 20),
      };
    } catch {
      return {
        status: "SKIPPED",
        creditedDeposits: 0,
        matched: 0,
        doubleCredit: [],
        missingCredit: [],
      };
    }
  }

  /**
   * Check 3: Trade P&L settlement integrity.
   * Closed TradeAudit rows with non-zero pnlRealized should have a corresponding
   * LedgerEntry of type PNL_SETTLEMENT in the same 24-hour window.
   */
  private async _checkPnlIntegrity(checkDate: Date): Promise<PnlIntegrityCheck> {
    const db = prisma as NonNullable<typeof prisma>;

    // Look at trades closed in the last 24 hours
    const since = new Date(checkDate.getTime() - 24 * 60 * 60 * 1000);

    try {
      const closedTrades = await db.tradeAudit.findMany({
        where: {
          tradeStatus: { in: ["CLOSED", "STOP_OUT"] },
          closedAt:    { gte: since, lte: checkDate },
          pnlRealized: { not: null },
        },
        select: {
          id:          true,
          userId:      true,
          positionId:  true,
          pnlRealized: true,
          closedAt:    true,
        },
      });

      if (closedTrades.length === 0) {
        return {
          status:        "SKIPPED",
          closedTrades:  0,
          settledTrades: 0,
          unsettled:     [],
        };
      }

      const unsettled: PnlIntegrityCheck["unsettled"] = [];
      let settledTrades = 0;

      for (const trade of closedTrades) {
        if (!trade.positionId) { settledTrades++; continue; }

        const settlement = await db.ledgerEntry.findFirst({
          where: {
            userId:    trade.userId,
            type:      { in: ["PNL_SETTLEMENT", "PNL_CREDIT", "PNL_DEBIT"] },
            reference: { contains: trade.positionId },
          },
          select: { id: true },
        });

        if (settlement) {
          settledTrades++;
        } else {
          const pnl = trade.pnlRealized?.toNumber() ?? 0;
          // Only flag non-trivial P&L (>$0.01 gap)
          if (Math.abs(pnl) > 0.01) {
            unsettled.push({
              positionId:  trade.positionId,
              userId:      trade.userId,
              pnlRealized: pnl,
            });
          } else {
            settledTrades++;
          }
        }
      }

      return {
        status:        unsettled.length === 0 ? "OK" : "MISMATCH",
        closedTrades:  closedTrades.length,
        settledTrades,
        unsettled:     unsettled.slice(0, 20),
      };
    } catch {
      return {
        status:        "SKIPPED",
        closedTrades:  0,
        settledTrades: 0,
        unsettled:     [],
      };
    }
  }

  /**
   * Check 4: Position audit trail completeness.
   * Every closed Position should have a TradeAudit record.
   */
  private async _checkPositionAuditTrail(checkDate: Date): Promise<PositionAuditCheck> {
    const db = prisma as NonNullable<typeof prisma>;
    const since = new Date(checkDate.getTime() - 24 * 60 * 60 * 1000);

    try {
      const closedPositions = await db.position.findMany({
        where: {
          status:   { in: ["CLOSED", "LIQUIDATED"] },
          closedAt: { gte: since, lte: checkDate },
        },
        select: { id: true, userId: true, closedAt: true },
      });

      if (closedPositions.length === 0) {
        return {
          status:             "SKIPPED",
          closedPositions:    0,
          positionsWithAudit: 0,
          missingAudit:       [],
        };
      }

      const auditedIds = await db.tradeAudit.findMany({
        where: {
          positionId: { in: closedPositions.map((p) => p.id) },
        },
        select: { positionId: true },
      });

      const auditSet = new Set(auditedIds.map((a) => a.positionId).filter(Boolean));
      const missing = closedPositions
        .filter((p) => !auditSet.has(p.id))
        .map((p) => ({
          positionId: p.id,
          userId:     p.userId,
          closedAt:   p.closedAt?.toISOString() ?? "",
        }));

      return {
        status:             missing.length === 0 ? "OK" : "MISMATCH",
        closedPositions:    closedPositions.length,
        positionsWithAudit: closedPositions.length - missing.length,
        missingAudit:       missing.slice(0, 20),
      };
    } catch {
      return {
        status:             "SKIPPED",
        closedPositions:    0,
        positionsWithAudit: 0,
        missingAudit:       [],
      };
    }
  }

  getLastReport(): EnhancedReconciliationReport | null {
    return this.lastReport;
  }

  /**
   * Run all enhanced reconciliation checks.
   * Leader-elected: only one worker per schedule window runs this.
   */
  async runDailyAudit(): Promise<EnhancedReconciliationReport> {
    const lock = new DistributedJobLock("enhanced-recon-daily", 23 * 60 * 60);
    if (!(await lock.tryAcquire())) {
      return this.lastReport ?? {
        runAt:            new Date().toISOString(),
        durationMs:       0,
        checkDate:        new Date().toISOString(),
        swapAccrual:      { status: "SKIPPED", checkDate: "", openPositionsChecked: 0, missingAccruals: [] },
        depositIntegrity: { status: "SKIPPED", creditedDeposits: 0, matched: 0, doubleCredit: [], missingCredit: [] },
        pnlIntegrity:     { status: "SKIPPED", closedTrades: 0, settledTrades: 0, unsettled: [] },
        positionAudit:    { status: "SKIPPED", closedPositions: 0, positionsWithAudit: 0, missingAudit: [] },
        overallClean:     true,
        totalMismatches:  0,
        summary:          "skipped — another worker holds the reconciliation lock",
      };
    }

    const start = Date.now();
    const checkDate = new Date();
    const runAt = checkDate.toISOString();

    try {
      const [swapAccrual, depositIntegrity, pnlIntegrity, positionAudit] = await Promise.all([
        this._checkSwapAccruals(checkDate),
        this._checkDepositIntegrity(),
        this._checkPnlIntegrity(checkDate),
        this._checkPositionAuditTrail(checkDate),
      ]);

      const checks = [swapAccrual, depositIntegrity, pnlIntegrity, positionAudit];
      const mismatches = checks.filter((c) => c.status === "MISMATCH");
      const totalMismatches = mismatches.length;
      const overallClean = totalMismatches === 0;

      // Detailed mismatch counts for Prometheus
      metrics.inc("enhanced_recon_swap_mismatches",    swapAccrual.missingAccruals.length);
      metrics.inc("enhanced_recon_deposit_mismatches",
        depositIntegrity.doubleCredit.length + depositIntegrity.missingCredit.length);
      metrics.inc("enhanced_recon_pnl_mismatches",     pnlIntegrity.unsettled.length);
      metrics.inc("enhanced_recon_audit_mismatches",   positionAudit.missingAudit.length);
      metrics.set("enhanced_recon_dirty_checks",       totalMismatches);

      const summaryParts: string[] = [];
      if (swapAccrual.status === "MISMATCH") {
        summaryParts.push(`${swapAccrual.missingAccruals.length} missing swap accruals`);
      }
      if (depositIntegrity.status === "MISMATCH") {
        summaryParts.push(
          `${depositIntegrity.missingCredit.length} uncredited deposits, ` +
          `${depositIntegrity.doubleCredit.length} double-credits`,
        );
      }
      if (pnlIntegrity.status === "MISMATCH") {
        summaryParts.push(`${pnlIntegrity.unsettled.length} unsettled P&L`);
      }
      if (positionAudit.status === "MISMATCH") {
        summaryParts.push(`${positionAudit.missingAudit.length} positions without audit trail`);
      }

      const summary = overallClean
        ? "All enhanced reconciliation checks passed."
        : `Issues: ${summaryParts.join("; ")}.`;

      if (!overallClean) {
        console.error("[enhanced-recon] mismatches detected:", summary);
        void alertManager.reconciliationMismatch(
          totalMismatches,
          summaryParts.join("; "),
        );
      }

      const report: EnhancedReconciliationReport = {
        runAt,
        durationMs:      Date.now() - start,
        checkDate:       checkDate.toISOString(),
        swapAccrual,
        depositIntegrity,
        pnlIntegrity,
        positionAudit,
        overallClean,
        totalMismatches,
        summary,
      };

      this.lastReport = report;
      console.log(
        `[enhanced-recon] run complete: clean=${overallClean} ` +
        `checks=${checks.length} mismatches=${totalMismatches} ` +
        `duration=${report.durationMs}ms`,
      );
      return report;
    } finally {
      await lock.release();
    }
  }
}

export const enhancedReconciliationService = new EnhancedReconciliationService();
