/**
 * SwapCalculator — overnight financing (rollover) charge engine.
 *
 * Swaps accrue when a CFD position is held past the daily rollover cutoff
 * (typically 22:00–00:00 UTC depending on the broker).  IGFXPRO uses 22:00 UTC.
 *
 * Wednesday swap:
 *   FX and commodity markets settle T+2.  A position held through Wednesday
 *   incurs 3× the normal swap (covers Saturday and Sunday settlement).
 *   Indices/equities/crypto follow their own schedules — simplified here to 1×.
 *
 * Rates are annualised and applied daily as: notional × annualRate / 365 / 100.
 * A negative swap debits the client; a positive swap credits the client.
 *
 * This is the ONLY place where swap rates are defined.
 */

import { assetClassOf } from "../liquidity-engine/liquidity.provider.js";

// ── Swap rate table (annualised %) ────────────────────────────────────────
// Long  = swap charged on BUY positions (negative = client pays)
// Short = swap charged on SELL positions

type SwapRate = { long: number; short: number };

const SWAP_RATES: Record<string, SwapRate> = {
  FX_MAJOR:  { long: -3.50, short:  1.20 },
  FX_MINOR:  { long: -4.00, short:  1.50 },
  INDEX:     { long: -5.00, short: -2.00 },  // indices: negative both sides
  COMMODITY: { long: -3.00, short: -1.50 },
  EQUITY:    { long: -4.50, short: -2.50 },
  CRYPTO:    { long: -15.0, short: -10.0 },  // crypto: high negative rates
};

export type SwapParams = {
  symbol:    string;
  side:      "BUY" | "SELL";
  quantity:  number;
  midPrice:  number;
  openedAt:  Date;
  closedAt?: Date;           // defaults to now
};

export type SwapResult = {
  totalSwap:  number;        // USD, negative = debit client
  perNight:   number;
  nights:     number;
  rateAnnual: number;        // annualised % rate used
};

export class SwapCalculator {
  /**
   * Compute total overnight swap charge for a closing position.
   *
   * @returns SwapResult.totalSwap — negative means the client pays.
   */
  compute(params: SwapParams): SwapResult {
    const closedAt   = params.closedAt ?? new Date();
    const nights     = this._countNights(params.openedAt, closedAt, params.symbol);
    const perNight   = this._onNight(params.symbol, params.side, params.quantity, params.midPrice);
    const totalSwap  = Number((perNight * nights).toFixed(2));
    const ac         = assetClassOf(params.symbol.toUpperCase().replace("/", ""));
    const rates      = SWAP_RATES[ac] ?? SWAP_RATES.FX_MAJOR;
    const rateAnnual = params.side === "BUY" ? rates.long : rates.short;

    return { totalSwap, perNight, nights, rateAnnual };
  }

  /**
   * Preview swap for a single night (used by frontend).
   */
  preview(symbol: string, side: "BUY" | "SELL", quantity: number, midPrice: number): number {
    return this._onNight(symbol, side, quantity, midPrice);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _onNight(symbol: string, side: "BUY" | "SELL", quantity: number, midPrice: number): number {
    const ac       = assetClassOf(symbol.toUpperCase().replace("/", ""));
    const rates    = SWAP_RATES[ac] ?? SWAP_RATES.FX_MAJOR;
    const annual   = side === "BUY" ? rates.long : rates.short;
    const notional = quantity * midPrice;
    return Number(((notional * annual) / 365 / 100).toFixed(8));
  }

  /**
   * Count how many rollover nights fall between openedAt and closedAt.
   * Rollover is at 22:00 UTC.
   * Wednesdays incur 3× for FX/commodities (T+2 settlement weekend coverage).
   */
  private _countNights(openedAt: Date, closedAt: Date, symbol: string): number {
    const ROLLOVER_HOUR_UTC = 22;

    // Adjust open/close times so they're relative to the rollover boundary
    const openMs  = openedAt.getTime();
    const closeMs = closedAt.getTime();
    if (closeMs <= openMs) return 0;

    const ac       = assetClassOf(symbol.toUpperCase().replace("/", ""));
    const useTriple = ac === "FX_MAJOR" || ac === "FX_MINOR" || ac === "COMMODITY";

    let nights = 0;
    // Walk day-by-day from open to close
    const start = new Date(openMs);
    start.setUTCHours(ROLLOVER_HOUR_UTC, 0, 0, 0);

    // If openedAt is after rollover on its day, the first rollover is the next day
    if (openedAt.getUTCHours() >= ROLLOVER_HOUR_UTC) {
      start.setUTCDate(start.getUTCDate() + 1);
    }

    const cursor = new Date(start);
    while (cursor.getTime() <= closeMs) {
      const dow = cursor.getUTCDay(); // 0=Sun, 3=Wed, 6=Sat
      // Skip Saturday rollover (markets closed)
      if (dow !== 6) {
        // Wednesday counts as 3 nights for FX/commodities (covers Sat+Sun)
        nights += (dow === 3 && useTriple) ? 3 : 1;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return nights;
  }
}

export const swapCalculator = new SwapCalculator();
