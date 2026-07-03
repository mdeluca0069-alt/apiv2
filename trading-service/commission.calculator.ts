/**
 * CommissionCalculator — tiered brokerage commission schedule.
 *
 * Commission is charged per trade (open + close) as a function of notional value.
 * Tiers receive progressive discounts to reward higher-volume clients.
 *
 * This is the ONLY place where commission rates are defined.
 * SettlementEngine calls this at position close.  ExecutionEngine may call it
 * at position open (if per-open commission is required in future).
 */

import { assetClassOf } from "../liquidity-engine/liquidity.provider.js";

// ── Rate table ─────────────────────────────────────────────────────────────
// Base commission in basis points (bps) of notional value.
// 1 bps = 0.01% = $10 per $100,000 notional.

const BASE_BPS: Record<string, number> = {
  FX_MAJOR:  0.50,   // $5.00 per $1,000,000 notional
  FX_MINOR:  0.80,
  INDEX:     1.00,
  COMMODITY: 1.20,
  EQUITY:    2.00,
  CRYPTO:    2.50,
};

// ── Tier discount multipliers ─────────────────────────────────────────────
// Applied on top of the asset-class base rate.

const TIER_FACTOR: Record<string, number> = {
  STANDARD:   1.00,
  GOLD:       0.85,   // -15%
  PLATINUM:   0.70,   // -30%
  VIP:        0.50,   // -50%
  ENTERPRISE: 0.30,   // -70% (custom deals)
};

// ── Minimum commission floor ──────────────────────────────────────────────
// Prevents zero/micro commissions on tiny trades.

const MIN_COMMISSION_USD = 0.01;

export type CommissionParams = {
  symbol:    string;
  quantity:  number;
  exitPrice: number;
  tier?:     string;
};

export type CommissionResult = {
  commission: number;   // USD
  notional:   number;   // quantity × exitPrice
  rateBps:    number;   // effective rate after tier discount
};

export class CommissionCalculator {
  /**
   * Compute commission for the closing leg of a position.
   *
   * @param params.symbol    Instrument symbol (e.g. "EURUSD", "BTCUSD").
   * @param params.quantity  Position size in instrument units.
   * @param params.exitPrice Close fill price.
   * @param params.tier      Client account tier (defaults to "STANDARD").
   * @returns                Commission in USD, rounded to cent precision.
   */
  compute(params: CommissionParams): CommissionResult {
    const ac         = assetClassOf(params.symbol.toUpperCase().replace("/", ""));
    const baseBps    = BASE_BPS[ac] ?? 1.00;
    const tierFactor = TIER_FACTOR[params.tier ?? "STANDARD"] ?? 1.00;
    const rateBps    = baseBps * tierFactor;

    const notional   = params.quantity * params.exitPrice;
    const raw        = (notional * rateBps) / 10_000;
    const commission = Math.max(Number(raw.toFixed(2)), MIN_COMMISSION_USD);

    return { commission, notional: Number(notional.toFixed(8)), rateBps };
  }

  /**
   * Look up the effective bps rate for a symbol + tier combination.
   * Useful for display in account statements.
   */
  effectiveBps(symbol: string, tier = "STANDARD"): number {
    const ac         = assetClassOf(symbol.toUpperCase().replace("/", ""));
    const baseBps    = BASE_BPS[ac] ?? 1.00;
    const tierFactor = TIER_FACTOR[tier] ?? 1.00;
    return baseBps * tierFactor;
  }
}

export const commissionCalculator = new CommissionCalculator();
