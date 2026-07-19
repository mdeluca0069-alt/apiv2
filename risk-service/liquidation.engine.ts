/**
 * LiquidationEngine — periodic SL/TP recovery watchdog.
 *
 * FASE 2.5 (Core Trading Certification, frozen constraint #2): this used to
 * be called by quoteCache.set() on every price tick, redundantly re-running
 * a DB-backed SL/TP + margin-stop-out check for every open position of that
 * symbol — duplicating, on every single tick, work trading-service/
 * position.price.monitor.ts already does in-memory (SL/TP) and
 * trading-service/stopout.engine.ts already does on its own 30s scan
 * (margin stop-out). Margin stop-out is dropped entirely here: it already
 * has both tick-level (position.price.monitor.ts → stopOutEngine.checkUser())
 * and 30s-periodic (stopOutEngine.scanAll()) coverage — a third periodic
 * copy here would just be redundant, not defense-in-depth.
 *
 * SL/TP has no such periodic fallback today — only the tick path. If
 * position.price.monitor.ts misses a position (its in-memory cache is at
 * MAX_POSITIONS_IN_MEM capacity, a restart gap before _loadPositions()
 * completes, or — since each PM2 cluster worker keeps its own independent
 * cache with no cross-worker sync — a position opened on one worker whose
 * ticks happen to be handled by another), a stop-loss or take-profit could
 * sit untriggered indefinitely with nothing else checking it. This engine
 * is that safety net: a periodic sweep (main.ts, every 30s, leader-elected
 * via jobCoordinator like stop-out-scan), not a second real-time engine —
 * a stop-loss still reacts to the tick via position.price.monitor.ts;
 * this only catches what that path missed.
 *
 * Settlement on close is delegated to SettlementEngine (atomic, double-entry),
 * same as every other closer in the codebase.
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { quoteCache }         from "../market-data/quote.cache.js";
import { settlementEngine, type CloseReason, PositionAlreadyClosedError } from "../settlement/settlement.engine.js";
import { LiquidityProvider } from "../liquidity-engine/liquidity.provider.js";
import { brokerSpreadConfig } from "../liquidity-engine/broker.spread.config.js";
import type { LiquidationResult } from "../shared/contracts.js";

type LiveQuote = {
  bid:       number;
  ask:       number;
  mid:       number;
  symbol:    string;
  spread:    number;
  changePct: number;
  ts?:       string;
};

export type LiquidationScanReport = {
  scanned:     number;  // open positions with a stopLoss/takeProfit set
  closed:      number;  // positions this sweep actually closed
  skippedStale: number; // positions skipped because their symbol's quote is stale/missing
  skippedHalted: number; // positions skipped because their symbol is currently halted (FASE 4.2 Bug #3)
};

export class LiquidationEngine {
  /**
   * Periodic sweep — called every 30s by main.ts (leader-elected job
   * "liquidation-watchdog"). Only positions with an SL or TP set are
   * scanned; each is evaluated against the current quoteCache snapshot for
   * its symbol and skipped if that quote is missing or stale (evaluating
   * against a stale price would be exactly the "never trade on fake/old
   * prices" mistake the rest of this codebase deliberately avoids).
   */
  async scanForMissedSlTp(): Promise<LiquidationScanReport> {
    const report: LiquidationScanReport = { scanned: 0, closed: 0, skippedStale: 0, skippedHalted: 0 };
    if (!IS_PERSISTENT || !prisma?.position) return report; // sandbox / no-DB mode

    const db = prisma as NonNullable<typeof prisma>;
    let openPositions;
    try {
      openPositions = await db.position.findMany({
        where: {
          status: "OPEN",
          OR: [{ stopLoss: { not: null } }, { takeProfit: { not: null } }],
        },
        select: {
          id:         true,
          userId:     true,
          symbol:     true,
          side:       true,
          quantity:   true,
          entryPrice: true,
          marginUsed: true,
          leverage:   true,
          openedAt:   true,
          stopLoss:   true,
          takeProfit: true,
        },
      });
    } catch { return report; } // DB temporarily unavailable

    report.scanned = openPositions.length;
    if (openPositions.length === 0) return report;

    for (const pos of openPositions) {
      const quote = quoteCache.get(pos.symbol);
      if (!quote || quoteCache.isStale(pos.symbol)) {
        report.skippedStale++;
        continue;
      }

      // FASE 4.2 (RISK_ENGINE_FREEZE.md Bug #3): a halted symbol's live
      // price is exactly the price the circuit breaker flagged as
      // anomalous (or an admin flagged as untradeable) -- closing an
      // existing position against it is the same mistake the halt exists
      // to prevent for new orders. Skip and let the halt's own recovery
      // sweep / next tick after it clears catch this position.
      if (!brokerSpreadConfig.isEnabled(pos.symbol)) {
        report.skippedHalted++;
        continue;
      }

      const markPrice = pos.side === "BUY" ? quote.bid : quote.ask;

      if (pos.stopLoss) {
        const sl    = pos.stopLoss.toNumber();
        const slHit = pos.side === "BUY" ? markPrice <= sl : markPrice >= sl;
        if (slHit) {
          await this._close(pos, quote, "STOP_LOSS", `Watchdog recovery: stop-loss hit @ ${markPrice} (missed by the real-time monitor)`);
          report.closed++;
          continue;
        }
      }

      if (pos.takeProfit) {
        const tp    = pos.takeProfit.toNumber();
        const tpHit = pos.side === "BUY" ? markPrice >= tp : markPrice <= tp;
        if (tpHit) {
          await this._close(pos, quote, "TAKE_PROFIT", `Watchdog recovery: take-profit hit @ ${markPrice} (missed by the real-time monitor)`);
          report.closed++;
        }
      }
    }

    return report;
  }

  /**
   * Admin / system-initiated close (e.g. position dispute, account suspension).
   */
  async closePosition(positionId: string, quote: LiveQuote): Promise<LiquidationResult> {
    const pos = await (prisma as NonNullable<typeof prisma>).position.findUnique({
      where:  { id: positionId },
      select: {
        id:         true,
        userId:     true,
        symbol:     true,
        side:       true,
        quantity:   true,
        entryPrice: true,
        marginUsed: true,
        leverage:   true,
        openedAt:   true,
        status:     true,
      },
    });

    if (!pos || pos.status !== "OPEN") {
      throw new Error(`Position ${positionId} not found or not open`);
    }

    // LEDGER_FREEZE.md §0.12: this had no callers anywhere in the codebase
    // (confirmed dead code) but previously passed reason "STOP_OUT" -- if it
    // were ever wired up, audit.outbox.consumer.ts's `action:
    // position.${reason.toLowerCase()}` would produce an AuditLog row
    // indistinguishable from a genuine ESMA-mandated regulatory stop-out,
    // with the only difference being a free-text detail string. "ADMIN" is
    // an existing CloseReason variant (settlement.engine.ts) that was never
    // actually used anywhere -- exactly the value this case should have
    // used from the start.
    return this._close(pos, quote, "ADMIN", "Admin force-close");
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _close(
    pos: {
      id:         string;
      userId:     string;
      symbol:     string;
      side:       string;
      quantity:   { toNumber(): number };
      entryPrice: { toNumber(): number };
      marginUsed: { toNumber(): number };
      leverage:   number;
      openedAt:   Date;
    },
    quote:   LiveQuote,
    reason:  CloseReason,
    detail:  string,
  ): Promise<LiquidationResult> {
    const closeSide = pos.side === "BUY" ? "SELL" : "BUY";
    const qty       = pos.quantity.toNumber();

    const book = LiquidityProvider.buildBook({
      symbol:    quote.symbol,
      bid:       quote.bid,
      ask:       quote.ask,
      mid:       quote.mid,
      spread:    quote.spread,
      changePct: quote.changePct,
    });
    const fill = LiquidityProvider.calculateFillFromBook(book, closeSide, qty);

    let result;
    try {
      result = await settlementEngine.settle({
      positionId: pos.id,
      userId:     pos.userId,
      symbol:     pos.symbol,
      side:       pos.side as "BUY" | "SELL",
      quantity:   qty,
      entryPrice: pos.entryPrice.toNumber(),
      exitPrice:  fill.averagePrice,
      marginUsed: pos.marginUsed.toNumber(),
      leverage:   pos.leverage,
      openedAt:   pos.openedAt,
      reason,
      detail,
    });
    } catch (err) {
      if (err instanceof PositionAlreadyClosedError) {
        // Another concurrent path (tick-level monitor, stopout, or the same
        // watchdog sweep racing itself across workers) closed this position first.
        // Treat as a silent no-op — return the last-known fill price.
        return {
          positionId: pos.id,
          exitPrice:  fill.averagePrice,
          pnl:        0,
          reason:     reason === "STOP_OUT" ? "STOP_OUT" : "NEGATIVE_BALANCE_PROTECTION",
          executedAt: new Date().toISOString(),
        };
      }
      throw err;
    }

    return {
      positionId: pos.id,
      exitPrice:  fill.averagePrice,
      pnl:        result.cappedPnl,
      reason:     reason === "STOP_OUT" ? "STOP_OUT" : "NEGATIVE_BALANCE_PROTECTION",
      executedAt: new Date().toISOString(),
    };
  }
}

export const liquidationEngine = new LiquidationEngine();
