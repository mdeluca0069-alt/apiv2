import { randomUUID } from "node:crypto";
import { Decimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";
import { prisma } from "../shared/db.js";
import { quoteCache } from "../market-data/quote.cache.js";
import { pnlCalculator } from "../trading-service/pnl.calculator.js";
import { eventBus } from "../events-bus/event.bus.js";
import { metrics } from "../gateway/metrics.js";
import { immutableAudit } from "../security/immutable.audit.js";
import type { MarginState } from "../shared/contracts.js";

/** See order.lifecycle.ts — same composability contract. */
type Db = Prisma.TransactionClient | typeof prisma;

export class MarginController {
  /**
   * FASE 4.2 (RISK_ENGINE_FREEZE.md Bug #2): live floating P&L from current
   * quotes, not the persisted Position.pnl column — that column is only
   * refreshed every 5s by PositionPriceMonitor's in-memory cache, which can
   * silently and permanently drop a position on a transient error, freezing
   * its pnl at its creation-time value (0) for the life of the process.
   * This feeds getMarginState() (the pre-trade risk gate — canAcceptOrder
   * below feeds risk.engine.ts's preTradeCheck) AND, since PHASE2_REMEDIATION
   * H4, checkAndLockMargin()'s own atomic claim — it must never approve an
   * order, in either place, against phantom free margin. A position with no
   * live quote right now contributes 0 (skipped), same limitation as
   * ledger.engine.ts's withdrawal fix (FASE 4.1) — strictly safer than
   * reading a stale number, not a guarantee every position's real risk is
   * captured. Accepts `db` so the atomic-claim call site can read within its
   * own transaction, same composability contract as checkAndLockMargin/
   * releaseMargin.
   */
  private async _computeUnrealizedPnl(db: Db, userId: string): Promise<number> {
    const openPositions = await db.position.findMany({
      where:  { userId, status: "OPEN" },
      select: { symbol: true, side: true, quantity: true, entryPrice: true },
    });
    return openPositions.reduce((sum, p) => {
      const quote = quoteCache.get(p.symbol);
      if (!quote) return sum;
      const { rawPnl } = pnlCalculator.unrealized(
        p.side as "BUY" | "SELL", p.quantity.toNumber(), p.entryPrice.toNumber(), quote.bid, quote.ask,
      );
      return sum + rawPnl;
    }, 0);
  }

  async getMarginState(userId: string): Promise<MarginState> {
    const [wallet, openPositions, unrealizedPnl] = await Promise.all([
      prisma.walletAccount.findUnique({ where: { userId } }),
      prisma.position.findMany({
        where:  { userId, status: "OPEN" },
        select: { marginUsed: true },
      }),
      this._computeUnrealizedPnl(prisma, userId),
    ]);

    if (!wallet) throw new Error(`WALLET_NOT_FOUND:${userId}`);

    const balance    = wallet.balance.toNumber();
    const marginUsed = openPositions.reduce((s: number, p) => s + p.marginUsed.toNumber(), 0);

    const equity = balance + unrealizedPnl;
    const freeMargin    = equity - marginUsed;
    const marginLevelPct =
      marginUsed > 0 ? (equity / marginUsed) * 100 : Number.POSITIVE_INFINITY;

    return { userId, balance, equity, marginUsed, freeMargin, marginLevelPct, unrealizedPnl };
  }

  canAcceptOrder(state: MarginState, additionalMargin: number): boolean {
    return state.freeMargin >= additionalMargin && state.equity > 0;
  }

  /**
   * Atomically checks margin availability then locks it.
   *
   * Concurrency is provided by SELECT ... FOR UPDATE on the wallet row, which
   * serializes concurrent margin-lock attempts per user under plain
   * ReadCommitted isolation — no Serializable/SSI retry loop needed, and no
   * risk of the position range-scan false positives SSI can produce.
   *
   * Returns { ok: true } on success or { ok: false, reason } if the
   * margin is no longer available (race was won by another order).
   *
   * FASE 2.2: pass `db` (an already-open Prisma.TransactionClient) to compose
   * this check-and-lock into a larger caller-owned transaction (see
   * execution.engine.ts, where it now runs in the same transaction as position
   * creation and the FILLED transition — a failure anywhere in that unit rolls
   * back the margin lock too, instead of leaving orphaned locked margin behind).
   * Omit `db` for the original standalone behavior (own transaction, unchanged
   * for any other caller).
   */
  async checkAndLockMargin(
    userId:   string,
    orderId:  string,
    required: number,
    db?: Db,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const run = async (tx: Db): Promise<{ ok: true } | { ok: false; reason: string }> => {
      // PHASE2_REMEDIATION (H4): this is the one atomic, race-proof margin
      // gate in the platform -- every caller (order.controller.ts,
      // execution.engine.ts) reaches it AFTER risk.engine.ts's preTradeCheck()
      // already ran the correct equity-based canAcceptOrder() check. But
      // preTradeCheck() is a plain, non-locking read: two near-simultaneous
      // orders for the same user can both read the same equity snapshot and
      // both pass it, so THIS conditional UPDATE is what has to be the real,
      // final safety net. It previously gated on `balance - locked` alone --
      // ignoring unrealized P&L on the user's other open positions entirely.
      // An account already carrying a large floating LOSS could still lock
      // margin for a brand-new position as if every dollar of balance were
      // free, exactly the gap preTradeCheck()'s equity-aware check upstream
      // was supposed to prevent -- silently falling back to balance-only
      // here made the supposedly-authoritative gate weaker than the
      // advisory one in front of it. unrealizedPnl is computed fresh, right
      // here (live quotes, see _computeUnrealizedPnl's docstring) --
      // necessarily a best-effort read (quotes aren't a Postgres column, so
      // this can't be part of the same atomic statement), the same
      // tolerance already accepted everywhere else in this codebase that
      // derives equity from live quotes.
      const unrealizedPnl = await this._computeUnrealizedPnl(tx, userId);
      const pnlAdjustment = new Decimal(unrealizedPnl);

      // FASE 2.2/2.3 perf: the conditional wallet UPDATE and the MARGIN_LOCK
      // ledger INSERT are one round trip via a data-modifying CTE, instead of
      // two separate statements. The INSERT's SELECT ... FROM locked draws
      // its row from the UPDATE's own RETURNING — if the WHERE clause matched
      // 0 rows (insufficient margin), `locked` is empty and the INSERT
      // naturally inserts nothing too, so this stays all-or-nothing with one
      // round trip either way. This matters more than usual now: this runs
      // inside execution.engine.ts's unified transaction (FASE 2.2) while
      // holding the FASE 2.3 per-symbol advisory lock, so every round trip
      // shaved off here directly shortens how long that lock — and therefore
      // every other order queued behind it for the same symbol — is held.
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        WITH locked AS (
          UPDATE "WalletAccount"
          SET locked = locked + ${new Decimal(required)}
          WHERE "userId" = ${userId}
            AND (balance + ${pnlAdjustment}) > 0
            AND (balance + ${pnlAdjustment} - locked) >= ${new Decimal(required)}
          RETURNING "userId"
        )
        INSERT INTO "LedgerEntry"
          (id, "userId", currency, amount, type, reference, status, note, "debitAccount", "creditAccount")
        SELECT
          ${randomUUID()}, locked."userId", 'USD', ${new Decimal(-required)}, 'MARGIN_LOCK', ${orderId},
          'COMPLETED', ${`Margin locked for order ${orderId}`},
          ${`CLIENT_FREE:${userId}`}, ${`CLIENT_MARGIN:${userId}`}
        FROM locked
        RETURNING id
      `;

      if (inserted.length === 0) {
        // Off the hot path — only reached on rejection, to produce a precise
        // reason. A plain read is fine here (no FOR UPDATE needed): worst
        // case a concurrent change makes the message slightly stale, but the
        // conditional UPDATE above is what actually decided the outcome.
        const rows = await tx.$queryRaw<Array<{ balance: string; locked: string }>>`
          SELECT balance, locked FROM "WalletAccount" WHERE "userId" = ${userId}
        `;
        if (rows.length === 0) return { ok: false as const, reason: `WALLET_NOT_FOUND:${userId}` };
        const available = parseFloat(rows[0].balance) + unrealizedPnl - parseFloat(rows[0].locked);
        return {
          ok:     false as const,
          reason: `INSUFFICIENT_MARGIN: need ${required.toFixed(2)}, available=${available.toFixed(2)}`,
        };
      }

      return { ok: true as const };
    };

    try {
      if (db) return await run(db);
      return await prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 3000, timeout: 8000 });
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  /**
   * Locks margin for a newly created order.
   * @deprecated Use checkAndLockMargin for atomic check+lock.
   */
  async lockMargin(userId: string, orderId: string, amount: number): Promise<void> {
    const result = await this.checkAndLockMargin(userId, orderId, amount);
    if (!result.ok) throw new Error(result.reason);
  }

  /**
   * Releases margin back to free balance when a position closes (or, since
   * PHASE2_REMEDIATION H2, when a resting order that had margin locked at
   * placement is cancelled/expires/is true-up'd at fill time).
   *
   * Uses FOR UPDATE on the wallet row to:
   *   1. Prevent concurrent releases from racing each other to a negative locked value.
   *   2. Clamp the release to the actual current locked amount (safe against orphan-release).
   *
   * PHASE2_REMEDIATION (H2): accepts an optional `db` (an already-open
   * Prisma.TransactionClient), same composability contract as
   * checkAndLockMargin() above -- execution.engine.ts's resting-order fill
   * path needs to release the placement-time estimate and lock the real
   * fill-price-derived amount atomically, in ONE transaction, so a failure
   * partway through rolls back both instead of leaving the wallet in an
   * inconsistent released-but-not-relocked state. Omit `db` for the
   * original standalone behavior (own transaction, unchanged for cancel/
   * expiry callers and the pre-existing partial-fill unused-margin release).
   */
  async releaseMargin(userId: string, positionId: string, amount: number, db?: Db): Promise<void> {
    let released = 0;

    const run = async (tx: Db) => {
      const rows = await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT locked FROM "WalletAccount" WHERE "userId" = ${userId} FOR UPDATE
      `;
      const currentLocked = rows[0] ? parseFloat(rows[0].locked) : 0;
      const safeRelease   = Math.max(0, Math.min(currentLocked, amount));

      if (safeRelease === 0) return; // already released or wallet missing

      await tx.walletAccount.update({
        where: { userId },
        data:  { locked: { decrement: new Decimal(safeRelease) } },
      });

      await tx.ledgerEntry.create({
        data: {
          id:            randomUUID(),
          userId,
          currency:      "USD",
          amount:        safeRelease,
          type:          "MARGIN_RELEASE",
          reference:     positionId,
          status:        "COMPLETED",
          note:          `Margin released for closed position ${positionId}`,
          debitAccount:  `CLIENT_MARGIN:${userId}`,
          creditAccount: `CLIENT_FREE:${userId}`,
        },
      });

      // LEDGER_FREEZE.md §0.7: this release (currently only reached from a
      // genuine partial fill's unused-margin follow-up, see execution.engine.ts)
      // had no Audit trail and no success Metrics at all -- only a failure
      // counter existed, and only if every retry AND the fire-and-forget
      // repair both failed.
      await immutableAudit.write({
        actor:   "SYSTEM_EXECUTION",
        action:  "margin.released",
        entity:  positionId,
        payload: { userId, requested: amount, released: safeRelease } as object,
      }, tx);

      released = safeRelease;
    };

    if (db) {
      // Composed into the caller's own (not-yet-committed) transaction --
      // defer the metric/event to the caller, which knows the outer
      // transaction's real outcome (see execution.engine.ts's H2 true-up:
      // it emits its own event/metric only after the whole transaction
      // commits, the same way it already defers every other side effect
      // of a fill). The immutableAudit write inside run() above still
      // happens atomically with the release either way.
      await run(db);
      return;
    }

    await prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 3000, timeout: 8000 });

    if (released > 0) {
      metrics.inc("partial_fill_margin_released_total");
      eventBus.emit("wallet.event", {
        userId, type: "MARGIN_RELEASE", amount: released,
        reference: positionId, timestamp: new Date().toISOString(),
      });
    }
  }

  async updatePositionPnl(
    positionId: string,
    markPrice:  number,
    pnl:        number,
    pnlPercent: number,
  ): Promise<void> {
    await prisma.position.update({
      where: { id: positionId },
      data:  {
        markPrice:  new Decimal(markPrice),
        pnl:        new Decimal(pnl),
        pnlPercent: new Decimal(pnlPercent),
      },
    });
  }

  async snapshotMargin(userId: string, triggerReason: string): Promise<void> {
    const state = await this.getMarginState(userId);
    const safeLevel = Number.isFinite(state.marginLevelPct)
      ? state.marginLevelPct
      : 9999;

    await prisma.marginSnapshot.create({
      data: {
        userId,
        equity:         new Decimal(state.equity),
        balance:        new Decimal(state.balance),
        marginUsed:     new Decimal(state.marginUsed),
        freeMargin:     new Decimal(state.freeMargin),
        marginLevelPct: new Decimal(safeLevel),
        unrealizedPnl:  new Decimal(state.unrealizedPnl),
        triggerReason,
      },
    });
  }
}

export const marginController = new MarginController();
