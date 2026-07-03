/**
 * FillValidator — validates fill prices against market conditions.
 *
 * Best execution regulation (MiFID II Article 27) requires brokers to:
 *   1. Fill at best available price.
 *   2. Reject fills that deviate excessively from quoted price.
 *   3. Log all validation results for regulatory audit.
 *
 * Validation checks:
 *   PRICE_DEVIATION    — fill price deviates from quoted price by more than
 *                        the maximum allowed slippage for this asset class.
 *   ZERO_FILL_PRICE    — fill price is zero or negative.
 *   ZERO_QUANTITY      — filled quantity is zero or negative.
 *   PARTIAL_FILL_LIMIT — partial fills over 99% require special handling
 *                        (reserved for future implementation).
 *
 * Maximum deviation by asset class (in price units, not pips):
 *   FX_MAJOR:  5 pips   (0.00050)
 *   FX_MINOR:  8 pips   (0.00080)
 *   INDEX:     2.0 points
 *   COMMODITY: 0.5 points
 *   CRYPTO:    1.0% of price
 *   EQUITY:    0.1% of price
 */

import { assetClassOf } from "../liquidity-engine/liquidity.provider.js";

export type FillValidationStatus = "VALID" | "INVALID";

export type FillValidationResult = {
  status:     FillValidationStatus;
  violations: FillViolation[];
  quotedPrice: number;
  fillPrice:   number;
  deviation:   number;
  deviationPct: number;
};

export type FillViolation = {
  code:    string;
  message: string;
  severity: "WARN" | "REJECT";
};

// Maximum allowed price deviation from quoted price before fill is rejected
const MAX_DEVIATION: Record<string, number> = {
  FX_MAJOR:  0.0005,   // 5 pips
  FX_MINOR:  0.0008,   // 8 pips
  INDEX:     2.0,      // 2 index points
  COMMODITY: 0.5,      // 0.5 USD
  EQUITY:    0.01,     // $0.01 per share (1 cent)
};

// For crypto and high-value instruments, use percentage threshold
const MAX_DEVIATION_PCT: Record<string, number> = {
  CRYPTO: 0.005,  // 0.5%
  EQUITY: 0.001,  // 0.1%
};

export class FillValidator {

  /**
   * Validate a fill result against the quoted market price.
   *
   * @param symbol       — Trading instrument symbol.
   * @param side         — Order side (BUY buys at ask, SELL buys at bid).
   * @param quotedPrice  — The bid or ask price quoted to the client at order time.
   * @param fillPrice    — The actual average fill price returned by the fill engine.
   * @param fillQuantity — The quantity filled.
   * @returns FillValidationResult — { status, violations, deviation }
   */
  validate(params: {
    symbol:        string;
    side:          "BUY" | "SELL";
    quotedPrice:   number;
    fillPrice:     number;
    fillQuantity:  number;
  }): FillValidationResult {
    const violations: FillViolation[] = [];
    const { symbol, fillPrice, fillQuantity, quotedPrice } = params;

    // ── Basic sanity checks ────────────────────────────────────────────────────
    if (fillPrice <= 0) {
      violations.push({ code: "ZERO_FILL_PRICE", message: "Fill price must be positive", severity: "REJECT" });
    }

    if (fillQuantity <= 0) {
      violations.push({ code: "ZERO_QUANTITY", message: "Fill quantity must be positive", severity: "REJECT" });
    }

    if (violations.some((v) => v.severity === "REJECT")) {
      return {
        status: "INVALID", violations, quotedPrice, fillPrice,
        deviation: 0, deviationPct: 0,
      };
    }

    // ── Price deviation check ──────────────────────────────────────────────────
    const ac         = assetClassOf(symbol);
    const deviation  = Math.abs(fillPrice - quotedPrice);
    const deviationPct = quotedPrice > 0 ? deviation / quotedPrice : 0;

    // Use percentage-based threshold for crypto and equity
    const pctThreshold = MAX_DEVIATION_PCT[ac];
    const absThreshold = MAX_DEVIATION[ac] ?? (quotedPrice * 0.005); // 0.5% fallback

    const exceedsDeviation = pctThreshold !== undefined
      ? deviationPct > pctThreshold
      : deviation > absThreshold;

    if (exceedsDeviation) {
      const limit = pctThreshold !== undefined
        ? `${(pctThreshold * 100).toFixed(2)}%`
        : absThreshold.toFixed(6);

      violations.push({
        code:     "PRICE_DEVIATION_EXCEEDED",
        message:  `Fill price ${fillPrice} deviates ${deviation.toFixed(6)} from quoted ${quotedPrice} (limit: ${limit})`,
        severity: "WARN",   // Log but allow — market can move between quote and fill
      });
    }

    // For a BUY order at ask, fill should be ≤ quoted ask + slippage
    // For a SELL order at bid, fill should be ≥ quoted bid - slippage
    const adverseFill = params.side === "BUY"
      ? fillPrice > quotedPrice + absThreshold * 3
      : fillPrice < quotedPrice - absThreshold * 3;

    if (adverseFill) {
      violations.push({
        code:     "ADVERSE_FILL",
        message:  `Fill price ${fillPrice} is significantly worse than quoted ${quotedPrice} (3× slippage limit)`,
        severity: "REJECT",
      });
    }

    const hasReject = violations.some((v) => v.severity === "REJECT");

    return {
      status:      hasReject ? "INVALID" : "VALID",
      violations,
      quotedPrice,
      fillPrice,
      deviation:   Math.round(deviation * 1e8) / 1e8,
      deviationPct: Math.round(deviationPct * 1e6) / 1e6,
    };
  }
}

export const fillValidator = new FillValidator();
