/**
 * SlippageController — realistic slippage model for internal LP fills.
 *
 * Slippage in CFD trading has three components:
 *
 *   1. SPREAD SLIPPAGE (base):
 *      Half of the bid/ask spread. A market BUY crosses from mid to ask.
 *      This is always present and deterministic.
 *      Example: EURUSD spread=1.0 pip → 0.5 pip spread slippage.
 *
 *   2. MARKET IMPACT (size-based):
 *      Larger orders consume more liquidity levels in the book.
 *      Modelled as: notional / MARKET_IMPACT_DIVISOR × base_slippage
 *      Example: $100k order has more impact than $10k order.
 *
 *   3. VOLATILITY PREMIUM (regime-based):
 *      During high-volatility periods (large changePct), spreads widen
 *      and fills are worse. Modelled as a multiplier on base slippage.
 *
 * The model is DETERMINISTIC (no Math.random) — given the same inputs
 * it produces the same slippage. This is required for:
 *   - Consistent client statements
 *   - Regulatory best-execution reporting
 *   - Reproducible back-testing
 *
 * Outputs:
 *   slippagePips     — slippage in pip units (for client display)
 *   slippagePrice    — slippage in price units (added to fill price)
 *   fillPrice        — final adjusted fill price
 *   qualityScore     — 0-100, where 100 = perfect fill (zero slippage)
 */

import { assetClassOf } from "../liquidity-engine/liquidity.provider.js";

// ── Asset-class parameters ─────────────────────────────────────────────────────

type AssetSlippageParams = {
  pipSize:           number;   // 1 pip in price units
  maxSlippagePips:   number;   // hard cap on slippage
  marketImpactDivisor: number; // larger = less market impact
};

const ASSET_PARAMS: Record<string, AssetSlippageParams> = {
  FX_MAJOR:  { pipSize: 0.0001, maxSlippagePips: 3.0,  marketImpactDivisor: 1_000_000 },
  FX_MINOR:  { pipSize: 0.0001, maxSlippagePips: 5.0,  marketImpactDivisor: 500_000   },
  INDEX:     { pipSize: 0.1,    maxSlippagePips: 5.0,  marketImpactDivisor: 100_000   },
  COMMODITY: { pipSize: 0.01,   maxSlippagePips: 4.0,  marketImpactDivisor: 200_000   },
  EQUITY:    { pipSize: 0.01,   maxSlippagePips: 3.0,  marketImpactDivisor: 50_000    },
  CRYPTO:    { pipSize: 1.0,    maxSlippagePips: 10.0, marketImpactDivisor: 100_000   },
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type SlippageInput = {
  symbol:      string;
  side:        "BUY" | "SELL";
  quantity:    number;
  midPrice:    number;
  spread:      number;    // bid/ask spread in price units
  changePct:   number;    // 24h % change (proxy for volatility)
};

export type SlippageResult = {
  slippagePips:   number;   // pip units
  slippagePrice:  number;   // price units
  spreadComponent: number;  // spread contribution (pips)
  impactComponent: number;  // size contribution (pips)
  volComponent:    number;  // volatility contribution (pips)
  fillAdjustment:  number;  // price units to add to mid price for fill
  qualityScore:    number;  // 0-100 (100 = perfect)
};

// ── Controller ────────────────────────────────────────────────────────────────

export class SlippageController {

  /**
   * Compute deterministic slippage for a fill against internal LP.
   *
   * The fill adjustment represents the price penalty the client pays:
   *   BUY:  fillPrice = ask + fillAdjustment  (positive adjustment = worse fill)
   *   SELL: fillPrice = bid - fillAdjustment  (positive adjustment = worse fill)
   */
  compute(input: SlippageInput): SlippageResult {
    const ac     = assetClassOf(input.symbol.toUpperCase());
    const params = ASSET_PARAMS[ac] ?? ASSET_PARAMS.FX_MAJOR;

    // ── 1. Spread component (always present) ───────────────────────────────────
    // Client pays half the spread (mid → side price)
    const spreadPips = (input.spread / 2) / params.pipSize;

    // ── 2. Market impact component ─────────────────────────────────────────────
    // Larger notional = more price levels consumed in the book
    const notional     = input.quantity * input.midPrice;
    const impactPips   = (notional / params.marketImpactDivisor) * spreadPips;

    // ── 3. Volatility component ────────────────────────────────────────────────
    // High changePct (e.g. during news events) widens effective spread
    const volMagnitude = Math.abs(input.changePct);
    const volMultiplier = volMagnitude < 0.1 ? 0         // low vol: no premium
                        : volMagnitude < 0.5 ? 0.1       // medium: +10%
                        : volMagnitude < 1.0 ? 0.25      // high: +25%
                        : 0.5;                            // extreme: +50%
    const volPips = spreadPips * volMultiplier;

    // ── 4. Total slippage (capped) ─────────────────────────────────────────────
    const rawPips  = spreadPips + impactPips + volPips;
    const cappedPips = Math.min(rawPips, params.maxSlippagePips);
    const slippagePrice = cappedPips * params.pipSize;

    // Quality score: 100 = zero slippage, 0 = at max cap
    const qualityScore = Math.max(0, Math.round((1 - cappedPips / params.maxSlippagePips) * 100));

    // Fill adjustment: positive = client pays more
    const fillAdjustment = slippagePrice;

    return {
      slippagePips:    Math.round(cappedPips    * 100) / 100,
      slippagePrice:   Math.round(slippagePrice * 1e8) / 1e8,
      spreadComponent: Math.round(spreadPips    * 100) / 100,
      impactComponent: Math.round(impactPips    * 100) / 100,
      volComponent:    Math.round(volPips       * 100) / 100,
      fillAdjustment:  Math.round(fillAdjustment * 1e8) / 1e8,
      qualityScore,
    };
  }

  /**
   * Compute execution quality score for a completed fill.
   * Used in best-execution reporting.
   *
   * @param expectedPrice  — price quoted to client at order time
   * @param actualFillPrice — actual average fill price
   * @param spread          — bid/ask spread at fill time
   * @returns 0-100 score (100 = perfect fill at quoted price)
   */
  qualityScore(symbol: string, expectedPrice: number, actualFillPrice: number, _spread: number): number {
    const ac     = assetClassOf(symbol.toUpperCase());
    const params = ASSET_PARAMS[ac] ?? ASSET_PARAMS.FX_MAJOR;
    const deviation = Math.abs(actualFillPrice - expectedPrice);
    const maxDev    = params.maxSlippagePips * params.pipSize;
    return Math.max(0, Math.round((1 - deviation / maxDev) * 100));
  }
}

export const slippageController = new SlippageController();
