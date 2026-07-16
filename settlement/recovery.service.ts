/**
 * RecoveryService — server restart data validation and repair.
 *
 * Runs at startup BEFORE the server begins accepting connections.
 * Validates and, where safe, repairs the persisted state:
 *
 *   1. Recompute unrealised P&L for all open positions.
 *
 *   2. Validate wallet.locked == SUM(open position margins).
 *      If wallet.locked > positions: RELEASE the orphan margin automatically.
 *      This covers a crash between checkAndLockMargin() and createPosition().
 *
 *   3. Reject stuck orders (RECEIVED, ACCEPTED older than 5 minutes).
 *      For ACCEPTED orders (margin may have been locked): release locked margin
 *      before rejecting, preventing permanent fund freeze.
 *
 *   4. Detect orphan positions (no wallet row) — flag for admin, do not auto-fix.
 *
 *   5. Run a full reconciliation sweep and log the report.
 *
 * Conservative rules:
 *   - NEVER modify wallet.balance autonomously (only an admin reconciliation does this).
 *   - DO auto-release orphan wallet.locked (this is safe — margin with no position
 *     cannot be reclaimed by any future order and would permanently freeze client funds).
 *   - DO auto-reject stuck orders (they were never filled — safe to reject).
 */

import { randomUUID }             from "node:crypto";
import { Decimal }                from "@prisma/client/runtime/library";
import { prisma, IS_PERSISTENT }  from "../shared/db.js";
import { quoteCache }             from "../market-data/quote.cache.js";
import { reconciliationEngine }   from "./reconciliation.engine.js";
import { tradingSuspension }      from "../shared/trading.suspension.js";

export type RecoveryReport = {
  ranAt:               string;
  positionsRecomputed: number;
  stuckOrdersRejected: number;
  orphanMarginReleased: string[];   // userId → amount description
  marginWarnings:      string[];    // warnings that could not be auto-fixed
  orphanPositions:     string[];
  suspendedUsers:      string[];    // P0-5: users suspended due to margin deficit
  reconciliation:      string;
};

const STUCK_ORDER_TTL_MS = 5 * 60 * 1_000; // 5 minutes

export class RecoveryService {
  async run(): Promise<RecoveryReport | null> {
    if (!IS_PERSISTENT || !prisma?.position) {
      console.log("[recovery] sandbox mode — skipping recovery checks");
      return null;
    }

    const ranAt = new Date().toISOString();
    const db    = prisma as NonNullable<typeof prisma>;

    let positionsRecomputed    = 0;
    let stuckOrdersRejected    = 0;
    const orphanMarginReleased: string[] = [];
    const marginWarnings:       string[] = [];
    const orphanPositions:      string[] = [];

    console.log("[recovery] starting startup validation...");

    // ── 1. Recompute floating P&L for all open positions ──────────────────
    const openPositions = await db.position.findMany({
      where:  { status: "OPEN" },
      select: { id: true, userId: true, symbol: true, side: true, quantity: true, entryPrice: true },
    });

    for (const pos of openPositions) {
      const quote = quoteCache.get(pos.symbol);
      if (!quote) continue;

      const markPrice = pos.side === "BUY" ? quote.bid : quote.ask;
      const direction = pos.side === "BUY" ? 1 : -1;
      const qty       = pos.quantity.toNumber();
      const entry     = pos.entryPrice.toNumber();
      const pnl       = (markPrice - entry) * qty * direction;
      const pnlPct    = entry > 0 ? ((markPrice - entry) / entry) * 100 * direction : 0;

      await db.position.update({
        where: { id: pos.id },
        data: {
          markPrice:  new Decimal(markPrice),
          pnl:        new Decimal(pnl),
          pnlPercent: new Decimal(pnlPct),
        },
      });
      positionsRecomputed++;
    }

    console.log(`[recovery] recomputed P&L for ${positionsRecomputed} open positions`);

    // ── 2. Validate and repair margin consistency ─────────────────────────
    //
    // wallet.locked should equal SUM(open position.marginUsed).
    // Mismatch cases:
    //   locked > positions: orphan margin from a crash during execution
    //     → SAFE TO AUTO-RELEASE: the excess lock has no corresponding position
    //   locked < positions: wallet was decremented more than positions show
    //     → DO NOT AUTO-FIX: requires human review (data corruption)
    //
    const wallets = await db.walletAccount.findMany({
      select: { userId: true, locked: true },
    });

    for (const w of wallets) {
      const posMarginAgg = await db.position.aggregate({
        where: { userId: w.userId, status: "OPEN" },
        _sum:  { marginUsed: true },
      });
      const posTotal = posMarginAgg._sum.marginUsed?.toNumber() ?? 0;
      const locked   = w.locked.toNumber();
      const delta    = locked - posTotal; // positive = orphan margin, negative = deficit

      if (Math.abs(delta) <= 0.01) continue; // within tolerance

      if (delta > 0.01) {
        // Orphan margin: wallet has MORE locked than positions require.
        // This happens when margin was locked but createPosition() failed.
        // Safe to release: there is no position that will use this margin.
        try {
          await db.$transaction(async (tx) => {
            await tx.walletAccount.update({
              where: { userId: w.userId },
              data:  { locked: { decrement: new Decimal(delta) } },
            });
            await tx.ledgerEntry.create({
              data: {
                id:            randomUUID(),
                userId:        w.userId,
                currency:      "USD",
                amount:        new Decimal(delta),
                type:          "MARGIN_RELEASE",
                reference:     `RECOVERY:${ranAt}`,
                status:        "COMPLETED",
                note:          `Startup recovery: released orphan margin lock of ${delta.toFixed(2)} (locked=${locked.toFixed(2)} positionTotal=${posTotal.toFixed(2)})`,
                debitAccount:  `CLIENT_MARGIN:${w.userId}`,
                creditAccount: `CLIENT_FREE:${w.userId}`,
              },
            });
            await tx.auditLog.create({
              data: {
                id:      randomUUID(),
                actor:   "SYSTEM_RECOVERY",
                action:  "margin.orphan_released",
                entity:  w.userId,
                payload: { orphanAmount: delta, locked, posTotal, ranAt } as object,
              },
            });
          }, { maxWait: 10000, timeout: 15000 });

          orphanMarginReleased.push(
            `userId=${w.userId} orphan=${delta.toFixed(2)} locked=${locked.toFixed(2)} positions=${posTotal.toFixed(2)}`
          );
          console.warn(`[recovery] ORPHAN MARGIN RELEASED: userId=${w.userId} delta=${delta.toFixed(2)}`);
        } catch (err) {
          const msg = `Failed to release orphan margin for ${w.userId}: ${(err as Error).message}`;
          marginWarnings.push(msg);
          console.error(`[recovery] ${msg}`);
        }

      } else {
        // Deficit: more margin in positions than wallet shows locked.
        // This should never happen in normal operation. Do NOT auto-fix.
        // P0-5: SUSPEND trading for this user until admin reviews and unsuspends.
        const msg = `MARGIN DEFICIT userId=${w.userId} locked=${locked.toFixed(2)} positionTotal=${posTotal.toFixed(2)} delta=${delta.toFixed(2)} — trading SUSPENDED, requires admin review`;
        marginWarnings.push(msg);
        console.error(`[recovery] ${msg}`);

        tradingSuspension.suspend(
          w.userId,
          `MARGIN_DEFICIT: locked=${locked.toFixed(2)} positionTotal=${posTotal.toFixed(2)} deficit=${Math.abs(delta).toFixed(2)}`
        );

        await db.auditLog.create({
          data: {
            id:      randomUUID(),
            actor:   "SYSTEM_RECOVERY",
            action:  "margin.deficit_detected",
            entity:  w.userId,
            payload: { locked, posTotal, delta, ranAt, tradingSuspended: true } as object,
          },
        });
      }
    }

    // ── 3. Detect orphan positions (no wallet row) ─────────────────────────
    const walletUserIds = new Set(wallets.map((w) => w.userId));
    for (const pos of openPositions) {
      if (!walletUserIds.has(pos.userId)) {
        orphanPositions.push(pos.id);
        console.error(`[recovery] ORPHAN POSITION: ${pos.id} userId=${pos.userId} has no wallet`);
      }
    }

    // ── 4. Reject stuck orders and release their margin ────────────────────
    //
    // RECEIVED/ACCEPTED orders that are older than STUCK_ORDER_TTL_MS were
    // never fully executed (the process crashed during execution).
    //
    // ACCEPTED orders may have margin locked (checkAndLockMargin succeeded
    // but createPosition failed/never ran).  We release that margin here.
    //
    const cutoff      = new Date(Date.now() - STUCK_ORDER_TTL_MS);
    const stuckOrders = await db.order.findMany({
      where: {
        status:    { in: ["RECEIVED", "RISK_REVIEW", "ACCEPTED"] },
        createdAt: { lt: cutoff },
      },
      select: { id: true, userId: true, status: true, marginRequired: true, createdAt: true },
    });

    for (const order of stuckOrders) {
      // LEDGER_FREEZE.md §0.3: this used to be inferred as `order.status ===
      // "ACCEPTED"` when writing the audit record below -- true whenever a
      // release was ATTEMPTED, even if the transaction below threw and
      // never actually ran. Track the real outcome instead, so the audit
      // trail can never assert a margin release that didn't happen.
      let marginReleased = false;

      // For ACCEPTED orders: margin may have been locked. Check if a position
      // exists — if not, release margin (it's orphaned).
      if (order.status === "ACCEPTED") {
        const position = await db.position.findFirst({
          where:  { orderId: order.id },
          select: { id: true },
        });

        if (!position) {
          // No position row: margin was locked but execution didn't complete.
          const margReq = order.marginRequired.toNumber();
          if (margReq > 0) {
            try {
              await db.$transaction(async (tx) => {
                // Floor-safe release: read current locked, clamp to avoid going negative.
                const walletNow    = await tx.walletAccount.findUnique({
                  where:  { userId: order.userId },
                  select: { locked: true },
                });
                const currentLocked = walletNow?.locked.toNumber() ?? 0;
                const safeRelease   = Math.max(0, Math.min(currentLocked, margReq));
                if (safeRelease <= 0) {
                  console.warn(
                    `[recovery] stuck-order margin already zeroed: orderId=${order.id} ` +
                    `userId=${order.userId} requested=${margReq.toFixed(2)} currentLocked=${currentLocked.toFixed(2)}`
                  );
                  return;
                }

                await tx.walletAccount.update({
                  where: { userId: order.userId },
                  data:  { locked: { decrement: new Decimal(safeRelease) } },
                });
                await tx.ledgerEntry.create({
                  data: {
                    id:            randomUUID(),
                    userId:        order.userId,
                    currency:      "USD",
                    amount:        new Decimal(safeRelease),
                    type:          "MARGIN_RELEASE",
                    reference:     `RECOVERY:ORDER:${order.id}`,
                    status:        "COMPLETED",
                    note:          safeRelease < margReq
                      ? `Startup recovery: margin released for stuck ACCEPTED order ${order.id} [PARTIAL: requested=${margReq.toFixed(2)} released=${safeRelease.toFixed(2)}]`
                      : `Startup recovery: margin released for stuck ACCEPTED order ${order.id}`,
                    debitAccount:  `CLIENT_MARGIN:${order.userId}`,
                    creditAccount: `CLIENT_FREE:${order.userId}`,
                  },
                });
                marginReleased = true; // only reached if both writes above actually committed
              }, { maxWait: 10000, timeout: 15000 });
              if (marginReleased) {
                console.warn(
                  `[recovery] released margin for stuck ACCEPTED order ${order.id} ` +
                  `userId=${order.userId} amount=${margReq.toFixed(2)}`
                );
              }
            } catch (err) {
              console.error(
                `[recovery] failed to release margin for stuck order ${order.id}:`,
                (err as Error).message,
              );
            }
          }
        }
      }

      // Reject the stuck order.
      await db.order.update({
        where: { id: order.id },
        data: {
          status:          "REJECTED",
          rejectionReason: `Auto-rejected by recovery service: stuck in '${order.status}' since ${order.createdAt.toISOString()}`,
        },
      });

      await db.auditLog.create({
        data: {
          id:      randomUUID(),
          actor:   "SYSTEM_RECOVERY",
          action:  "order.auto_rejected",
          entity:  order.id,
          payload: {
            stuckStatus: order.status,
            age:         Date.now() - order.createdAt.getTime(),
            marginReleased,
          } as object,
        },
      });

      stuckOrdersRejected++;
    }

    if (stuckOrdersRejected > 0) {
      console.warn(`[recovery] auto-rejected ${stuckOrdersRejected} stuck order(s)`);
    }

    // ── 5. Full reconciliation sweep ──────────────────────────────────────
    const report = await reconciliationEngine.runFull();

    const suspendedUsers = tradingSuspension.getSuspendedUsers().map((s) => s.userId);

    console.log(
      `[recovery] complete — ` +
      `positions=${positionsRecomputed} stuckOrders=${stuckOrdersRejected} ` +
      `orphanMargin=${orphanMarginReleased.length} marginWarnings=${marginWarnings.length} ` +
      `orphans=${orphanPositions.length} suspended=${suspendedUsers.length}`
    );
    console.log(`[recovery] reconciliation: ${report.summary}`);
    if (suspendedUsers.length > 0) {
      console.error(`[recovery] CRITICAL: ${suspendedUsers.length} user(s) suspended due to margin deficit: ${suspendedUsers.join(", ")}`);
    }

    return {
      ranAt,
      positionsRecomputed,
      stuckOrdersRejected,
      orphanMarginReleased,
      marginWarnings,
      orphanPositions,
      suspendedUsers,
      reconciliation: report.summary,
    };
  }
}

export const recoveryService = new RecoveryService();
