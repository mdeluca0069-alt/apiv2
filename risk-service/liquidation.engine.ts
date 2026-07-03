/**
 * LiquidationEngine — mark-to-market, SL/TP, and stop-out.
 *
 * Called by quoteCache.set() on every price tick.
 * Settlement on close is delegated to SettlementEngine (atomic, double-entry).
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { marginController }  from "./margin.controller.js";
import { settlementEngine, type CloseReason, PositionAlreadyClosedError } from "../settlement/settlement.engine.js";
import { LiquidityProvider } from "../liquidity-engine/liquidity.provider.js";
import {
  STOP_OUT_LEVEL_PCT,
  type LiquidationResult,
} from "../shared/contracts.js";

type LiveQuote = {
  bid:       number;
  ask:       number;
  mid:       number;
  symbol:    string;
  spread:    number;
  changePct: number;
  ts?:       string;
};

export class LiquidationEngine {
  /**
   * Called by quoteCache.set() on every price update.
   * Runs mark-to-market, SL/TP, and stop-out checks for the symbol.
   */
  async onQuoteUpdate(symbol: string, quote: LiveQuote): Promise<void> {
    if (!IS_PERSISTENT || !prisma?.position) return; // sandbox / no-DB mode

    const db = prisma as NonNullable<typeof prisma>;
    let openPositions;
    try {
      openPositions = await db.position.findMany({
        where:  { symbol: symbol.toUpperCase(), status: "OPEN" },
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
    } catch { return; } // DB temporarily unavailable

    if (openPositions.length === 0) return;

    for (const pos of openPositions) {
      const markPrice  = pos.side === "BUY" ? quote.bid : quote.ask;
      const entry      = pos.entryPrice.toNumber();
      const qty        = pos.quantity.toNumber();
      const direction  = pos.side === "BUY" ? 1 : -1;

      const pnl        = (markPrice - entry) * qty * direction;
      const pnlPercent = ((markPrice - entry) / entry) * 100 * direction;

      // Update mark price + floating P&L
      await marginController.updatePositionPnl(pos.id, markPrice, pnl, pnlPercent);

      // ── Stop-loss ──────────────────────────────────────────────────────
      if (pos.stopLoss) {
        const sl    = pos.stopLoss.toNumber();
        const slHit = pos.side === "BUY" ? markPrice <= sl : markPrice >= sl;
        if (slHit) {
          await this._close(pos, quote, "STOP_LOSS", `Stop-loss hit @ ${markPrice}`);
          continue;
        }
      }

      // ── Take-profit ────────────────────────────────────────────────────
      if (pos.takeProfit) {
        const tp    = pos.takeProfit.toNumber();
        const tpHit = pos.side === "BUY" ? markPrice >= tp : markPrice <= tp;
        if (tpHit) {
          await this._close(pos, quote, "TAKE_PROFIT", `Take-profit hit @ ${markPrice}`);
          continue;
        }
      }

      // ── Margin stop-out ────────────────────────────────────────────────
      const marginState = await marginController.getMarginState(pos.userId);
      if (
        marginState.marginUsed > 0 &&
        Number.isFinite(marginState.marginLevelPct) &&
        marginState.marginLevelPct <= STOP_OUT_LEVEL_PCT
      ) {
        await this._close(
          pos,
          quote,
          "STOP_OUT",
          `Margin level ${marginState.marginLevelPct.toFixed(1)}% ≤ ${STOP_OUT_LEVEL_PCT}% stop-out`,
        );
      }
    }
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

    return this._close(pos, quote, "STOP_OUT", "Admin force-close");
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
        // Another concurrent path (stopout or another tick) closed this position first.
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
