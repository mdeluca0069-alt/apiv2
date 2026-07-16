/**
 * ReconciliationEngine — automated consistency checks for the broker ledger.
 *
 * Runs four independent invariant checks:
 *
 *   1. MARGIN INVARIANT
 *      wallet.locked  ==  SUM(position.marginUsed  WHERE status='OPEN')
 *      Detects margin leakage: margin locked but no open position, or position
 *      closed without releasing margin.
 *
 *   2. LEDGER BALANCE INVARIANT
 *      SUM(completed balance-affecting ledger entries)  ==  wallet.balance
 *      Detects P&L settlement gaps or double-credits.
 *
 *   3. POSITION INTEGRITY
 *      All OPEN positions have entryPrice > 0, marginUsed > 0, quantity > 0.
 *      Detects orphaned / malformed position records.
 *
 *   4. WALLET EXISTENCE
 *      Every user with OPEN positions has a WalletAccount row.
 *      Detects positions created without a wallet (should be impossible but
 *      guards against manual DB mutations).
 *
 * Usage:
 *   - Run at startup (RecoveryService calls runUser for all active users).
 *   - Run on a daily schedule (DailySnapshotService triggers after EOD).
 *   - Run on demand via admin endpoint.
 */

import { randomUUID }          from "node:crypto";
import { Decimal }             from "@prisma/client/runtime/library";
import { prisma }              from "../shared/db.js";
import { metrics }             from "../gateway/metrics.js";
import { alertManager }        from "../alerting/alert.manager.js";
import { DistributedJobLock }  from "../shared/distributed.job.lock.js";
import { eventBus }            from "../events-bus/event.bus.js";
import { notificationRouter }  from "../notification-service/notification.router.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type CheckStatus = "OK" | "MISMATCH" | "SKIPPED";

export type MarginCheck = {
  status:         CheckStatus;
  walletLocked:   number;
  positionTotal:  number;
  delta:          number;   // walletLocked - positionTotal (should be 0)
};

export type LedgerBalanceCheck = {
  status:          CheckStatus;
  walletBalance:   number;
  ledgerComputed:  number;
  delta:           number;
};

export type PositionIntegrityCheck = {
  status:          CheckStatus;
  total:           number;
  malformed:       string[];  // positionIds with invalid data
};

export type WalletExistenceCheck = {
  status:          CheckStatus;
  orphanUserIds:   string[];  // users with open positions but no wallet
};

export type UserReconciliationResult = {
  userId:          string;
  checkedAt:       string;
  margin:          MarginCheck;
  ledgerBalance:   LedgerBalanceCheck;
  positionIntegrity: PositionIntegrityCheck;
  walletExistence: WalletExistenceCheck;
  clean:           boolean;   // true if all checks are OK or SKIPPED
};

export type ReconciliationReport = {
  generatedAt:  string;
  usersChecked: number;
  cleanUsers:   number;
  dirtyUsers:   UserReconciliationResult[];  // only users with mismatches
  summary:      string;
};

// Balance-affecting ledger types (these actually change wallet.balance).
// Margin-only types (MARGIN_RESERVED, MARGIN_RELEASED, MARGIN_LOCK, MARGIN_RELEASE)
// only change wallet.locked and are excluded from the balance recomputation.
//
// IMPORTANT: "WITHDRAW_REQUEST" with status COMPLETED or APPROVED represents
// an approved withdrawal that has been debited from the wallet. It MUST be
// included here. wallet.repository.debit() creates these entries with a
// negative amount (debitAmount.negated()), so including them correctly
// reduces the ledger sum.
const BALANCE_TYPES = new Set([
  "ADMIN_CAPITAL_ALLOCATION",   // approved deposit credit (legacy admin-approval flow)
  "DEPOSIT_CREDIT",             // Fix #7: live PSP deposit credit (payment-service/deposit.state.machine.ts)
                                 // — omitted before, so every real self-service deposit produced a
                                 // permanent false-positive ledger/wallet mismatch.
  "WITHDRAW_REQUEST",           // approved withdrawal debit (amount is negative)
  "PNL_CREDIT",                 // positive P&L (legacy path)
  "PNL_DEBIT",                  // negative P&L (legacy path)
  "PNL_SETTLEMENT",             // net P&L from SettlementEngine (may be ±)
  "COMMISSION",                 // brokerage commission debit
  "SWAP",                       // overnight financing (may be ±)
  "ADJUSTMENT",                 // manual admin correction
  "NBP_WRITEOFF",               // FASE 4.3: broker absorbs a residual negative
                                 // balance after settlement (see settlement.engine.ts)
]);

const EPSILON = 0.01; // 1 cent tolerance for floating-point rounding

// ── Engine ───────────────────────────────────────────────────────────────────

export class ReconciliationEngine {
  /**
   * Check a single user for all four invariants.
   */
  async checkUser(userId: string): Promise<UserReconciliationResult> {
    const checkedAt = new Date().toISOString();

    const [wallet, openPositions, ledgerEntries] = await Promise.all([
      (prisma as NonNullable<typeof prisma>).walletAccount.findUnique({
        where:  { userId },
        select: { balance: true, locked: true },
      }),
      (prisma as NonNullable<typeof prisma>).position.findMany({
        where:  { userId, status: "OPEN" },
        select: { id: true, marginUsed: true, entryPrice: true, quantity: true, leverage: true },
      }),
      (prisma as NonNullable<typeof prisma>).ledgerEntry.findMany({
        // "APPROVED" is the terminal/settled status used by BrokerState's
        // legacy admin-allocation path (adminAllocateCapital/adminWithdrawCapital
        // in shared/state.ts) — it never transitions to "COMPLETED". Both
        // represent a settled, balance-affecting entry; only PENDING_ADMIN/
        // PENDING/REJECTED should stay excluded.
        where:  { userId, status: { in: ["COMPLETED", "APPROVED"] } },
        select: { amount: true, type: true },
      }),
    ]);

    // ── 4. Wallet existence ─────────────────────────────────────────────────
    const walletExistence: WalletExistenceCheck = {
      status:        wallet ? "OK" : (openPositions.length > 0 ? "MISMATCH" : "SKIPPED"),
      orphanUserIds: (!wallet && openPositions.length > 0) ? [userId] : [],
    };

    if (!wallet) {
      return {
        userId, checkedAt,
        margin:            { status: "SKIPPED", walletLocked: 0, positionTotal: 0, delta: 0 },
        ledgerBalance:     { status: "SKIPPED", walletBalance: 0, ledgerComputed: 0, delta: 0 },
        positionIntegrity: { status: "SKIPPED", total: openPositions.length, malformed: [] },
        walletExistence,
        clean: walletExistence.status !== "MISMATCH",
      };
    }

    const walletLocked  = wallet.locked.toNumber();
    const walletBalance = wallet.balance.toNumber();

    // ── 1. Margin invariant ─────────────────────────────────────────────────
    const positionMarginTotal = openPositions.reduce(
      (sum, p) => sum + p.marginUsed.toNumber(), 0
    );
    const marginDelta = walletLocked - positionMarginTotal;
    const margin: MarginCheck = {
      status:        Math.abs(marginDelta) <= EPSILON ? "OK" : "MISMATCH",
      walletLocked,
      positionTotal: positionMarginTotal,
      delta:         Number(marginDelta.toFixed(8)),
    };

    // ── 2. Ledger balance invariant ─────────────────────────────────────────
    const ledgerSum = ledgerEntries
      .filter((e) => BALANCE_TYPES.has(e.type))
      .reduce((sum, e) => sum + e.amount.toNumber(), 0);
    const balanceDelta = walletBalance - ledgerSum;
    const ledgerBalance: LedgerBalanceCheck = {
      status:         Math.abs(balanceDelta) <= EPSILON ? "OK" : "MISMATCH",
      walletBalance,
      ledgerComputed: Number(ledgerSum.toFixed(8)),
      delta:          Number(balanceDelta.toFixed(8)),
    };

    // ── 3. Position integrity ───────────────────────────────────────────────
    const malformed: string[] = [];
    for (const pos of openPositions) {
      if (
        pos.entryPrice.toNumber() <= 0 ||
        pos.marginUsed.toNumber() <= 0 ||
        pos.quantity.toNumber()   <= 0 ||
        pos.leverage              <= 0
      ) {
        malformed.push(pos.id);
      }
    }
    const positionIntegrity: PositionIntegrityCheck = {
      status:   malformed.length === 0 ? "OK" : "MISMATCH",
      total:    openPositions.length,
      malformed,
    };

    const clean =
      margin.status            !== "MISMATCH" &&
      ledgerBalance.status     !== "MISMATCH" &&
      positionIntegrity.status !== "MISMATCH" &&
      walletExistence.status   !== "MISMATCH";

    return { userId, checkedAt, margin, ledgerBalance, positionIntegrity, walletExistence, clean };
  }

  /**
   * Run reconciliation for ALL users who have a wallet or open position.
   * Returns a full report with mismatches highlighted.
   * Uses Redis leader election so only one worker per 5-min window runs the sweep.
   */
  async runFull(): Promise<ReconciliationReport> {
    // Leader election: TTL = 4 min (slightly less than the 5-min schedule interval
    // so the lock always expires before the next scheduled run).
    // If Redis is unavailable all workers run — checkUser is read-only and idempotent.
    const lock = new DistributedJobLock("reconciliation-sweep", 240);
    if (!(await lock.tryAcquire())) {
      return {
        generatedAt:  new Date().toISOString(),
        usersChecked: 0,
        cleanUsers:   0,
        dirtyUsers:   [],
        summary:      "skipped — another worker holds the reconciliation lock",
      };
    }

    const generatedAt = new Date().toISOString();
    try {
      // Collect distinct userIds from wallets + open positions
      const [walletUsers, positionUsers] = await Promise.all([
        (prisma as NonNullable<typeof prisma>).walletAccount.findMany({
          select: { userId: true },
        }),
        (prisma as NonNullable<typeof prisma>).position.findMany({
          where:  { status: "OPEN" },
          select: { userId: true },
          distinct: ["userId"],
        }),
      ]);

      const userSet = new Set([
        ...walletUsers.map((w) => w.userId),
        ...positionUsers.map((p) => p.userId),
      ]);

      const results: UserReconciliationResult[] = [];
      for (const userId of userSet) {
        results.push(await this.checkUser(userId));
      }

      const dirtyUsers  = results.filter((r) => !r.clean);
      const cleanUsers  = results.length - dirtyUsers.length;
      const summary     = dirtyUsers.length === 0
        ? `All ${results.length} accounts reconciled successfully.`
        : `${dirtyUsers.length} account(s) have mismatches. See dirtyUsers for details.`;

      // Emit Prometheus metrics so Grafana/Alertmanager can see the state
      let totalMismatches = 0;
      if (dirtyUsers.length > 0) {
        console.error("[reconciliation] mismatches detected:", summary);
        for (const d of dirtyUsers) {
          if (d.margin.status === "MISMATCH") {
            console.error(`  [margin] userId=${d.userId} delta=${d.margin.delta}`);
            totalMismatches++;
          }
          if (d.ledgerBalance.status === "MISMATCH") {
            console.error(`  [ledger] userId=${d.userId} delta=${d.ledgerBalance.delta}`);
            totalMismatches++;
          }
          if (d.positionIntegrity.status === "MISMATCH") {
            console.error(`  [positions] malformed: ${d.positionIntegrity.malformed.join(", ")}`);
            totalMismatches++;
          }
        }
      }
      metrics.inc("reconciliation_mismatches_total", totalMismatches);
      metrics.set("reconciliation_dirty_users", dirtyUsers.length);

      if (dirtyUsers.length > 0) {
        const detail = dirtyUsers.map((d) => `userId=${d.userId} margin=${d.margin.delta?.toFixed(2) ?? "ok"} ledger=${d.ledgerBalance.delta?.toFixed(2) ?? "ok"}`).join("; ");
        void alertManager.reconciliationMismatch(dirtyUsers.length, detail);
      }

      return { generatedAt, usersChecked: results.length, cleanUsers, dirtyUsers, summary };
    } finally {
      await lock.release();
    }
  }

  /**
   * Atomically repair orphan margin for a single user.
   * Only releases excess: wallet.locked → sum(OPEN position.marginUsed).
   * Never increases wallet.locked (deficit requires admin review).
   * Returns the amount released (0 if no repair was needed).
   */
  async repairOrphanMargin(userId: string): Promise<number> {
    const db = prisma as NonNullable<typeof prisma>;
    const repairedAt = new Date().toISOString();
    let released = 0;

    await db.$transaction(async (tx) => {
      const walletRows = await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT locked FROM "WalletAccount" WHERE "userId" = ${userId} FOR UPDATE
      `;
      if (!walletRows.length) return;

      const currentLocked = parseFloat(walletRows[0].locked);
      const agg = await tx.position.aggregate({
        where: { userId, status: "OPEN" },
        _sum:  { marginUsed: true },
      });
      const positionTotal = agg._sum.marginUsed?.toNumber() ?? 0;
      const orphan = currentLocked - positionTotal;

      if (orphan <= 0.01) return; // within tolerance or deficit — skip

      await tx.walletAccount.update({
        where: { userId },
        data:  { locked: { decrement: new Decimal(orphan) } },
      });
      await tx.ledgerEntry.create({
        data: {
          id:            randomUUID(),
          userId,
          currency:      "USD",
          amount:        new Decimal(orphan),
          type:          "MARGIN_RELEASE",
          reference:     `RECON:${repairedAt}`,
          status:        "COMPLETED",
          note:          `Periodic reconciliation: released orphan margin ${orphan.toFixed(2)} (locked=${currentLocked.toFixed(2)} openPositions=${positionTotal.toFixed(2)})`,
          debitAccount:  `CLIENT_MARGIN:${userId}`,
          creditAccount: `CLIENT_FREE:${userId}`,
        },
      });
      // LEDGER_FREEZE.md §0.2: this is the system's own autonomous self-
      // correction of a client's balance -- it needs an audit trail at least
      // as complete as an ordinary user-initiated action, not less. Same
      // action/actor shape as recovery.service.ts's equivalent startup-time
      // repair (the one branch already doing this right).
      await tx.auditLog.create({
        data: {
          id:      randomUUID(),
          actor:   "SYSTEM_RECONCILIATION",
          action:  "margin.orphan_released",
          entity:  userId,
          payload: { orphanAmount: orphan, locked: currentLocked, positionTotal, repairedAt } as object,
        },
      });
      released = orphan;
    }, { maxWait: 10000, timeout: 15000 });

    if (released > 0.01) {
      metrics.inc("reconciliation_orphan_margin_repaired_total");
      console.warn(`[reconciliation] repaired orphan margin userId=${userId} released=${released.toFixed(2)}`);
      eventBus.emit("wallet.event", {
        userId, type: "MARGIN_RELEASE", amount: released,
        reference: `RECON:${repairedAt}`, timestamp: repairedAt,
      });
      void notificationRouter.sendAll(
        userId, "margin", "NORMAL",
        "Margine bloccato rilasciato automaticamente",
        `Una verifica di riconciliazione ha rilasciato ${released.toFixed(2)} USD di margine bloccato non più associato a posizioni aperte.`,
        { orphanAmount: released, repairedAt },
      );
    }
    return released;
  }

  /**
   * Run full reconciliation and auto-repair any orphan margin found.
   * Called every 5 minutes from main.ts.
   */
  async runFullWithRepair(): Promise<{ checked: number; repaired: number; totalReleased: number }> {
    const report = await this.runFull();
    let repaired = 0;
    let totalReleased = 0;
    for (const dirty of report.dirtyUsers) {
      if (dirty.margin.status === "MISMATCH" && dirty.margin.delta > 0.01) {
        try {
          const released = await this.repairOrphanMargin(dirty.userId);
          if (released > 0) { repaired++; totalReleased += released; }
        } catch (err) {
          console.error(`[reconciliation] repair failed for ${dirty.userId}:`, (err as Error).message);
        }
      }
    }
    return { checked: report.usersChecked, repaired, totalReleased };
  }
}

export const reconciliationEngine = new ReconciliationEngine();
