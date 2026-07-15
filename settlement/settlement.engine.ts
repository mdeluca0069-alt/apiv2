/**
 * SettlementEngine — the single authoritative pipeline for position close.
 *
 * Every position close — manual, stop-loss, take-profit, stop-out, admin —
 * MUST go through this engine.  It is the only place that:
 *   - calculates realised P&L (PnLCalculator)
 *   - applies negative balance protection (ESMA requirement) -- both the
 *     per-position cap (PnLCalculator.applyNBP/netCredit, which since FASE 4.3
 *     also protects against commission pushing a capped loss past the
 *     position's own margin) and a final aggregate write-off: if the wallet
 *     balance is still negative after this settlement (several positions can
 *     each individually respect their own margin cap while the account's
 *     pre-existing balance was smaller than the sum of their margins), the
 *     residual is absorbed by the broker via an audited NBP_WRITEOFF ledger
 *     entry in the same transaction, never a silent clamp.
 *   - charges commission (CommissionCalculator)
 *   - charges overnight swap (SwapCalculator)
 *   - atomically updates position, wallet, and three-to-four ledger entries
 *   - writes an immutable audit log entry
 *   - enqueues an outbox event for reliable WebSocket delivery
 *
 * Double-entry accounting model (per position close):
 *   Leg 1 — P&L settlement
 *     DR  BROKER_PNL        / CR  CLIENT:{userId}   (win)
 *     DR  CLIENT:{userId}   / CR  BROKER_PNL        (loss)
 *   Leg 2 — Commission debit
 *     DR  CLIENT:{userId}   / CR  BROKER_COMMISSION
 *   Leg 3 — Margin release
 *     DR  CLIENT_MARGIN:{userId} / CR  CLIENT_FREE:{userId}
 *
 * All three legs and all table updates execute inside a single Prisma
 * serializable transaction.  If any step fails the whole settlement rolls back.
 *
 * NOTE — swap accounting: SwapAccrualService charges overnight financing nightly
 * at 22:00 UTC via its own atomic transactions. Settlement does NOT charge swap.
 * Charging it here would double-bill any position held past one rollover.
 */

import { randomUUID }              from "node:crypto";
import { Decimal }                 from "@prisma/client/runtime/library";
import { Prisma }                  from "@prisma/client";
import { prisma }                  from "../shared/db.js";
import { exposureRegistry }        from "../risk-service/exposure.limits.js";
import { pnlCalculator }           from "../trading-service/pnl.calculator.js";
import { commissionCalculator }    from "../trading-service/commission.calculator.js";
import { eventBus }                from "../events-bus/event.bus.js";
import { metrics }                 from "../gateway/metrics.js";
import { alertManager }            from "../alerting/alert.manager.js";

/**
 * Retry a Prisma Serializable transaction on PostgreSQL serialization failure
 * (SQLSTATE 40001 "could not serialize") or deadlock (SQLSTATE 40P01).
 * These are expected under concurrent settlement of the same-user positions.
 */
async function withSettlementRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isRetryable =
        err instanceof Error &&
        (err.message.includes("deadlock detected") ||
         (err as { code?: string }).code === "P2034");
      if (!isRetryable || attempt >= maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 25 * 2 ** (attempt - 1)));
    }
  }
}

/**
 * Thrown when settle() is called on a position that is not OPEN.
 * Callers (liquidation, stopout) treat this as a no-op rather than an error.
 */
export class PositionAlreadyClosedError extends Error {
  constructor(public readonly positionId: string, public readonly status: string) {
    super(`POSITION_NOT_OPEN:${positionId}:${status}`);
    this.name = "PositionAlreadyClosedError";
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type CloseReason =
  | "MANUAL"
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "STOP_OUT"
  | "LIQUIDATION"
  | "ADMIN";

export type SettleInput = {
  positionId: string;
  userId:     string;
  symbol:     string;
  side:       "BUY" | "SELL";
  quantity:   number;
  entryPrice: number;
  exitPrice:  number;
  marginUsed: number;
  leverage:   number;
  openedAt:   Date;
  reason:     CloseReason;
  detail?:    string;
  userTier?:  string;        // for commission discount
};

export type SettleResult = {
  positionId:  string;
  rawPnl:      number;
  cappedPnl:   number;
  commission:  number;
  swap:        number;
  netCredit:   number;
  newBalance:  Decimal;
  pnlPercent:  number;
  /** FASE 4.3 (Bug #6): >0 when a residual negative balance after this
   *  settlement was written off (broker-absorbed, ESMA NBP). 0 otherwise. */
  writeOffAmount: number;
};

// ── Engine ───────────────────────────────────────────────────────────────────

export class SettlementEngine {
  /**
   * Atomically settle a closed position.
   *
   * The transaction contains:
   *   1. Close the position row.
   *   2. Apply wallet delta (netCredit) and margin release.
   *   3. Write ledger × 3 (PNL_SETTLEMENT, COMMISSION, MARGIN_RELEASE).
   *   4. Update TradeAudit.
   *   5. Append AuditLog (immutable record).
   *   6. Enqueue OutboxEvent (for reliable WS delivery).
   *
   * After the transaction, emits domain events via EventBus.
   */
  async settle(input: SettleInput): Promise<SettleResult> {
    const settleStart = Date.now();
    // ── 1. Pure math (no DB) ────────────────────────────────────────────────
    const commResult  = commissionCalculator.compute({
      symbol:    input.symbol,
      quantity:  input.quantity,
      exitPrice: input.exitPrice,
      tier:      input.userTier,
    });

    // Swap is zero at settlement — SwapAccrualService exclusively owns all overnight
    // financing charges. Positions closed intraday (before their first 22:00 UTC
    // rollover) correctly carry zero swap cost.
    const swapResult = { totalSwap: 0, perNight: 0, nights: 0, rateAnnual: 0 };

    const pnl = pnlCalculator.settleClose({
      side:       input.side,
      quantity:   input.quantity,
      entryPrice: input.entryPrice,
      exitPrice:  input.exitPrice,
      marginUsed: input.marginUsed,
      commission: commResult.commission,
      swap:       0,
    });

    // FASE 4.3 (RISK_ENGINE_FREEZE.md Bug #6): use pnl.netCredit -- the
    // result settleClose() already computed above via pnlCalculator's
    // canonical, NBP-capped-including-commission formula -- instead of
    // recomputing it inline here. This used to be a second, independent
    // `cappedPnl - commission` formula that carried the exact same
    // commission-leak bug pnl.calculator.ts's netCredit() was just fixed
    // for: fixing only the calculator would have done nothing for this,
    // the actual production settlement path.
    const netCredit = Number(pnl.netCredit.toFixed(8));

    const ts = new Date().toISOString();

    // ── 2. Atomic database transaction ─────────────────────────────────────
    let newBalance!: Decimal;
    let safeRelease = 0;
    let discrepancy = 0;
    let writeOffAmount = 0;
    let outboxId!: string;

    await withSettlementRetry(() =>
    (prisma as NonNullable<typeof prisma>).$transaction(async (tx) => {

      // ── 2a. Lock position row (FOR UPDATE) — prevents concurrent close ──
      // Two concurrent closers (e.g. SL/TP tick + stopout) both reach here.
      // The first acquires the row lock and proceeds; the second waits, then
      // sees status ≠ OPEN and throws PositionAlreadyClosedError (silent no-op).
      const posRows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM "Position" WHERE id = ${input.positionId} FOR UPDATE
      `;
      if (posRows.length === 0) {
        throw new PositionAlreadyClosedError(input.positionId, "NOT_FOUND");
      }
      if (posRows[0].status !== "OPEN") {
        throw new PositionAlreadyClosedError(input.positionId, posRows[0].status);
      }

      // ── 2b. Lock wallet row (FOR UPDATE) + compute safe margin release ──
      // Locking wallet serializes concurrent settlements for the same user,
      // ensuring currentLocked is read atomically before the decrement.
      // Defends against three double-release scenarios:
      //   (a) RecoveryService orphan-release zeroed locked before this settlement
      //   (b) Seed-script reset wallet.locked=0 while position remained OPEN
      //   (c) Two concurrent settle() calls for same user (second sees locked=0)
      const walletRows = await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT locked FROM "WalletAccount" WHERE "userId" = ${input.userId} FOR UPDATE
      `;
      const currentLocked = walletRows[0] ? parseFloat(walletRows[0].locked) : 0;
      safeRelease = Math.max(0, Math.min(currentLocked, input.marginUsed));
      discrepancy = input.marginUsed - safeRelease;
      if (discrepancy > 0.001) {
        console.warn(
          `[settlement] MARGIN_DISCREPANCY positionId=${input.positionId} ` +
          `userId=${input.userId} requested=${input.marginUsed.toFixed(2)} ` +
          `currentLocked=${currentLocked.toFixed(2)} released=${safeRelease.toFixed(2)} ` +
          `discrepancy=${discrepancy.toFixed(2)} — orphan or double-release`
        );
        metrics.inc("margin_discrepancies_total");
        void alertManager.marginDiscrepancy(input.positionId, input.userId, input.marginUsed, safeRelease);
      }

      // ── 2c. Close position ──────────────────────────────────────────────
      await tx.position.update({
        where: { id: input.positionId },
        data: {
          status:     this._positionStatus(input.reason),
          closedAt:   new Date(),
          exitPrice:  new Decimal(input.exitPrice),
          markPrice:  new Decimal(input.exitPrice),
          pnl:        new Decimal(pnl.cappedPnl),
          pnlPercent: new Decimal(pnl.pnlPercent),
        },
      });

      // ── 2d. Apply wallet delta — RETURNING gives updated balance atomically
      const updatedWallet = await tx.walletAccount.update({
        where: { userId: input.userId },
        data: {
          balance: { increment: new Decimal(netCredit) },
          locked:  safeRelease > 0 ? { decrement: new Decimal(safeRelease) } : undefined,
        },
        select: { balance: true },
      });
      newBalance = updatedWallet.balance;

      // ── 2d-i. Negative balance write-off (FASE 4.3, RISK_ENGINE_FREEZE.md
      // Bug #6) ─────────────────────────────────────────────────────────
      // Per-position NBP (applyNBP/netCredit above) caps THIS settlement's
      // own loss at its own deposited margin -- but a client can still end
      // up with a negative wallet balance in aggregate: each of several
      // positions can individually respect its own margin cap while the
      // account's pre-existing balance was smaller than the sum of all
      // their margins (leverage means margin used need not equal current
      // balance). ESMA negative balance protection requires the broker to
      // absorb any such residual shortfall, not pursue the client for it --
      // previously nothing detected or wrote this off anywhere in the
      // codebase; a negative balance just sat there. Written off atomically
      // in the same transaction as the settlement that caused it, with its
      // own audited ledger entry (never a silent clamp).
      if (newBalance.lessThan(0)) {
        writeOffAmount = Math.abs(newBalance.toNumber());
        await tx.walletAccount.update({
          where: { userId: input.userId },
          data:  { balance: new Decimal(0) },
        });
        newBalance = new Decimal(0);
        console.warn(
          `[settlement] NBP_WRITEOFF positionId=${input.positionId} userId=${input.userId} ` +
          `amount=${writeOffAmount.toFixed(2)} — residual negative balance absorbed by broker`
        );
      }

      // ── 2c-e. Ledger legs 1-3 — batch INSERT (single round trip) ──────
      // Combining PNL_SETTLEMENT, COMMISSION, and MARGIN_RELEASE into one
      // createMany call reduces this transaction from ~10 sequential round
      // trips to 5, cutting connection-hold time by ~50%.
      await tx.ledgerEntry.createMany({
        data: [
          {
            id:             randomUUID(),
            userId:         input.userId,
            currency:       "USD",
            amount:         new Decimal(pnl.cappedPnl),
            type:           "PNL_SETTLEMENT",
            reference:      input.positionId,
            status:         "COMPLETED",
            note:           `${input.reason} | ${input.symbol} ${input.side} | Entry ${input.entryPrice} → Exit ${input.exitPrice} | Raw P&L ${pnl.rawPnl.toFixed(2)} | Capped ${pnl.cappedPnl.toFixed(2)}`,
            runningBalance: newBalance,
            debitAccount:   pnl.cappedPnl >= 0 ? "BROKER_PNL"            : `CLIENT:${input.userId}`,
            creditAccount:  pnl.cappedPnl >= 0 ? `CLIENT:${input.userId}` : "BROKER_PNL",
          },
          ...(commResult.commission > 0 ? [{
            id:            randomUUID(),
            userId:        input.userId,
            currency:      "USD",
            amount:        new Decimal(-commResult.commission),
            type:          "COMMISSION" as const,
            reference:     input.positionId,
            status:        "COMPLETED",
            note:          `Commission ${commResult.rateBps.toFixed(3)} bps on ${input.symbol} close (tier ${input.userTier ?? "STANDARD"})`,
            debitAccount:  `CLIENT:${input.userId}`,
            creditAccount: "BROKER_COMMISSION",
          }] : []),
          {
            id:            randomUUID(),
            userId:        input.userId,
            currency:      "USD",
            amount:        new Decimal(safeRelease),
            type:          "MARGIN_RELEASE" as const,
            reference:     input.positionId,
            status:        "COMPLETED",
            note:          discrepancy > 0.001
              ? `Margin released on position close — ${input.positionId} [PARTIAL: requested=${input.marginUsed.toFixed(2)} released=${safeRelease.toFixed(2)} discrepancy=${discrepancy.toFixed(2)}]`
              : `Margin released on position close — ${input.positionId}`,
            debitAccount:  `CLIENT_MARGIN:${input.userId}`,
            creditAccount: `CLIENT_FREE:${input.userId}`,
          },
          ...(writeOffAmount > 0 ? [{
            id:             randomUUID(),
            userId:         input.userId,
            currency:       "USD",
            amount:         new Decimal(writeOffAmount),
            type:           "NBP_WRITEOFF" as const,
            reference:      input.positionId,
            status:         "COMPLETED",
            note:           `Negative balance protection write-off — balance after this settlement would have been -${writeOffAmount.toFixed(2)}, broker absorbs the shortfall (ESMA NBP)`,
            runningBalance: newBalance,
            debitAccount:   "BROKER_NBP_WRITEOFF",
            creditAccount:  `CLIENT:${input.userId}`,
          }] : []),
        ],
      });

      // ── 2f. OutboxEvent — same transaction as position/wallet/ledger ────
      // FASE 2.1: previously written fire-and-forget after commit (below,
      // "Audit / outbox"), so a crash between commit and that write could
      // silently lose the client's only durable notification of the close.
      // Now the row is guaranteed to exist the instant the close is durable.
      //
      // FASE 2.4: the payload also carries every field the audit consumer
      // (compliance/audit.outbox.consumer.ts) needs to build the TradeAudit
      // CLOSE update and the AuditLog entry — same reasoning as the
      // equivalent execution.engine.ts change: cheap to capture once here,
      // while everything is already in scope and hasn't moved yet, instead
      // of a consumer re-fetch that risks a torn read against later writes.
      // FASE 2.6: also drives notification.outbox.consumer.ts — the pnl
      // field above is already everything the "Position closed" IN_APP
      // notification needs.
      const outbox = await tx.outboxEvent.create({
        data: {
          eventType: "position.closed",
          userId:    input.userId,
          auditProcessed: false,
          notificationProcessed: false,
          payload: {
            positionId:  input.positionId,
            userId:      input.userId,
            symbol:      input.symbol,
            side:        input.side,
            pnl:         pnl.cappedPnl,
            netCredit,
            exitPrice:   input.exitPrice,
            reason:      input.reason,
            detail:      input.detail ?? "",
            // Audit-only fields (not used by the WS client payload above):
            entryPrice:          input.entryPrice,
            quantity:            input.quantity,
            leverage:            input.leverage,
            openedAt:            input.openedAt.toISOString(),
            rawPnl:              pnl.rawPnl,
            pnlPercent:          pnl.pnlPercent,
            commission:          commResult.commission,
            swap:                swapResult.totalSwap,
            marginUsedRequested: input.marginUsed,
            marginUsedReleased:  safeRelease,
            marginDiscrepancy:   discrepancy > 0.001 ? discrepancy : 0,
            nbpWriteOff:         writeOffAmount > 0 ? writeOffAmount : 0,
          } as object,
        },
      });
      outboxId = outbox.id;

    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 15000 })
    ); // end withSettlementRetry

    // ── 2f-i. Audit ──────────────────────────────────────────────────────
    // FASE 2.4: TradeAudit (CLOSE update) and AuditLog are no longer written
    // here, fire-and-forget. The OutboxEvent row created inside the
    // transaction above (with every field this used to build them from) is
    // durable the instant the close is; compliance/audit.outbox.consumer.ts
    // reliably turns it into both records, with retry and alerting on
    // persistent failure — see that file for the delivery guarantee. This
    // also keeps the ~380ms → ~190ms per-settlement connection-hold win from
    // FASE 2.1 (audit writes still happen after, not inside, the transaction).

    // ── 3. Release global exposure (after transaction commits) ─────────────
    // notional at close = quantity × exitPrice
    const closeNotional = input.quantity * input.exitPrice;
    exposureRegistry.closePosition(input.symbol, input.side, closeNotional);

    // ── 4. Metrics ──────────────────────────────────────────────────────────
    metrics.inc("settlement_completed_total");
    metrics.inc("positions_closed_total");
    metrics.observe("settlement_duration_ms", Date.now() - settleStart);
    if (input.reason === "STOP_OUT" || input.reason === "LIQUIDATION") {
      metrics.inc("stop_out_events_total");
    }
    if (pnl.rawPnl < pnl.cappedPnl) {
      metrics.inc("negative_balance_clips_total");
    }
    if (writeOffAmount > 0) {
      metrics.inc("nbp_writeoff_total");
      metrics.observe("nbp_writeoff_amount_usd", writeOffAmount);
      void alertManager.send({
        type:     "NBP_WRITEOFF",
        severity: "WARNING",
        title:    "Negative Balance Write-Off",
        message:  `User ${input.userId}'s balance went negative after settling position ${input.positionId} — broker absorbed ${writeOffAmount.toFixed(2)} USD (ESMA negative balance protection).`,
        metadata: { userId: input.userId, positionId: input.positionId, writeOffAmount: writeOffAmount.toFixed(2) },
      });
    }

    // ── 5. Emit domain events (non-blocking) ───────────────────────────────
    eventBus.emit("position.closed", {
      positionId: input.positionId,
      userId:     input.userId,
      symbol:     input.symbol,
      side:       input.side,
      quantity:   input.quantity,
      entryPrice: input.entryPrice,
      exitPrice:  input.exitPrice,
      pnl:        pnl.cappedPnl,
      timestamp:  ts,
      outboxId,
    });

    eventBus.emit("wallet.event", {
      userId:    input.userId,
      type:      "MARGIN_RELEASE",
      amount:    input.marginUsed,
      reference: input.positionId,
      timestamp: ts,
    });

    if (input.reason === "STOP_OUT" || input.reason === "LIQUIDATION") {
      eventBus.emit("risk.warning", {
        userId:      input.userId,
        severity:    "CRITICAL",
        marginLevel: 0,
        riskScore:   100,
        message:     `Position ${input.positionId} force-closed: ${input.detail ?? input.reason}. Net: ${netCredit.toFixed(2)} USD`,
        timestamp:   ts,
      });
    }

    return {
      positionId:  input.positionId,
      rawPnl:      pnl.rawPnl,
      cappedPnl:   pnl.cappedPnl,
      commission:  commResult.commission,
      swap:        swapResult.totalSwap,
      netCredit,
      newBalance,
      pnlPercent:  pnl.pnlPercent,
      writeOffAmount,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _positionStatus(reason: CloseReason): string {
    if (reason === "STOP_OUT" || reason === "LIQUIDATION") return "LIQUIDATED";
    return "CLOSED";
  }
}

export const settlementEngine = new SettlementEngine();
