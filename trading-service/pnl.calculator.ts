/**
 * PnLCalculator — pure realised and unrealised P&L arithmetic.
 *
 * All methods are stateless and free of DB/IO side effects.
 * They are the single source of truth for P&L numbers across the platform:
 *   SettlementEngine, ReconciliationEngine, BalanceCalculator.
 *
 * Sign convention (CFD linear model):
 *   BUY:  P&L = (exitPrice - entryPrice) × quantity     [long = profit when price rises]
 *   SELL: P&L = (entryPrice - exitPrice) × quantity     [short = profit when price falls]
 */

export type PnLBreakdown = {
  /** Raw P&L before negative balance protection. */
  rawPnl:      number;
  /** P&L after negative balance protection (max loss = margin deposited). */
  cappedPnl:   number;
  /** P&L as a percentage of entry price × leverage. */
  pnlPercent:  number;
  /** Mark price used (bid for longs, ask for shorts). */
  markPrice:   number;
};

export class PnLCalculator {
  // ── Realised P&L ─────────────────────────────────────────────────────────

  /**
   * Compute realised P&L for a closed position.
   * Does NOT apply negative balance protection — call applyNBP() separately.
   */
  realized(
    side:       "BUY" | "SELL",
    quantity:   number,
    entryPrice: number,
    exitPrice:  number,
  ): number {
    const direction = side === "BUY" ? 1 : -1;
    return (exitPrice - entryPrice) * quantity * direction;
  }

  /**
   * P&L percentage relative to entry price.
   * Formula: ((exit - entry) / entry) × 100 × direction × leverage
   * (leverage is implicit in the position size for CFDs — percentage is price-only)
   */
  pnlPercent(
    side:       "BUY" | "SELL",
    entryPrice: number,
    exitPrice:  number,
  ): number {
    if (entryPrice === 0) return 0;
    const direction = side === "BUY" ? 1 : -1;
    return ((exitPrice - entryPrice) / entryPrice) * 100 * direction;
  }

  // ── Unrealised (mark-to-market) ──────────────────────────────────────────

  /**
   * Compute unrealised floating P&L for an open position.
   *
   * CFD mark-to-market convention:
   *   LONG:  valued at current bid (worst-case close price for the client)
   *   SHORT: valued at current ask
   */
  unrealized(
    side:       "BUY" | "SELL",
    quantity:   number,
    entryPrice: number,
    bid:        number,
    ask:        number,
  ): PnLBreakdown {
    const markPrice = side === "BUY" ? bid : ask;
    const direction = side === "BUY" ? 1 : -1;
    const rawPnl    = (markPrice - entryPrice) * quantity * direction;

    return {
      rawPnl,
      cappedPnl:  rawPnl,           // no NBP for floating P&L
      pnlPercent: this.pnlPercent(side, entryPrice, markPrice),
      markPrice,
    };
  }

  // ── Negative balance protection ───────────────────────────────────────────

  /**
   * Apply ESMA negative balance protection.
   * A client's loss cannot exceed the margin they deposited.
   *
   * @param rawPnl      Raw realised P&L (may be negative).
   * @param marginUsed  Margin deposited for this position (positive).
   * @returns           Capped P&L — worst case is -marginUsed.
   */
  applyNBP(rawPnl: number, marginUsed: number): number {
    return Math.max(rawPnl, -Math.abs(marginUsed));
  }

  /**
   * Net credit/debit to the wallet after a position closes.
   *
   *   netCredit = cappedPnl - commission - swap
   *
   * If netCredit > 0 → wallet balance increases.
   * If netCredit < 0 → wallet balance decreases (loss case).
   *
   * FASE 4.3 (RISK_ENGINE_FREEZE.md Bug #6): `cappedPnl` already caps raw
   * P&L at -marginUsed (applyNBP), but commission/swap were subtracted
   * afterward, uncapped -- a position could still debit the wallet for more
   * than its own deposited margin once fees are included, defeating the
   * point of NBP. `marginUsed` (optional, defaults to no cap so direct
   * callers/tests of the raw formula are unaffected) applies the same
   * ESMA guarantee to the actual wallet-moving number, not just the
   * P&L component of it.
   */
  netCredit(cappedPnl: number, commission: number, swap: number, marginUsed = Infinity): number {
    const raw = cappedPnl - commission - swap;
    return Math.max(raw, -Math.abs(marginUsed));
  }

  // ── Convenience ───────────────────────────────────────────────────────────

  /**
   * Full realised breakdown in one call.
   */
  settleClose(params: {
    side:       "BUY" | "SELL";
    quantity:   number;
    entryPrice: number;
    exitPrice:  number;
    marginUsed: number;
    commission: number;
    swap:       number;
  }): {
    rawPnl:     number;
    cappedPnl:  number;
    pnlPercent: number;
    commission: number;
    swap:       number;
    netCredit:  number;
  } {
    const rawPnl    = this.realized(params.side, params.quantity, params.entryPrice, params.exitPrice);
    const cappedPnl = this.applyNBP(rawPnl, params.marginUsed);
    const pct       = this.pnlPercent(params.side, params.entryPrice, params.exitPrice);
    const net       = this.netCredit(cappedPnl, params.commission, params.swap, params.marginUsed);

    return {
      rawPnl,
      cappedPnl,
      pnlPercent: Number(pct.toFixed(4)),
      commission: params.commission,
      swap:       params.swap,
      netCredit:  Number(net.toFixed(8)),
    };
  }
}

export const pnlCalculator = new PnLCalculator();
