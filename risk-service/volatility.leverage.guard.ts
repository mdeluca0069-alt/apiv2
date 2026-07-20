/**
 * VolatilityLeverageGuard — derates the leverage granted to a NEW position
 * while its symbol is currently volatile, instead of volatility only ever
 * widening the spread (a cost).
 *
 * RISK_ENGINE_FREEZE.md §5.5: dynamic.spread.engine.ts already measures live
 * volatility (+ economic-event) intensity per symbol on every tick
 * (getMultiplier(), 1.0 = normal, higher = more volatile/event risk), but
 * that signal only ever fed spread widening -- a client could still open a
 * new position at the full ESMA-capped leverage during a symbol's most
 * volatile moments, with the elevated risk showing up only as a wider
 * spread, never as a lower position size.
 *
 * Soft derating on top of leverage.guard.ts's static ESMA cap, applied the
 * same way leverage.guard.ts itself already works (silently reduce the
 * effective leverage rather than reject the order -- margin required simply
 * increases). Never raises leverage, never reduces below 1x.
 *
 * Deliberately reuses dynamicSpreadEngine's existing combined multiplier
 * (volatility x event) rather than isolating pure volatility: a scheduled
 * high-impact event is exactly the kind of condition that should also
 * derate new leverage, not just widen spread, so conflating the two here is
 * intentional, not a shortcut.
 */
import { dynamicSpreadEngine } from "../liquidity-engine/dynamic.spread.engine.js";

// Tiers keyed off dynamicSpreadEngine.getMultiplier(symbol). Thresholds sit
// well inside the engine's own maxSpreadMultiplier range (4.0-8.0 by asset
// class), so all three tiers are reachable in practice, not just in theory.
const VOLATILITY_LEVERAGE_TIERS: { minMultiplier: number; leverageFactor: number }[] = [
  { minMultiplier: 3.0, leverageFactor: 0.25 },
  { minMultiplier: 2.0, leverageFactor: 0.5  },
  { minMultiplier: 1.5, leverageFactor: 0.75 },
];

class VolatilityLeverageGuard {
  /** Leverage multiplier (0,1] to apply on top of the ESMA-capped leverage. 1 = no reduction. */
  factorFor(symbol: string): number {
    const multiplier = dynamicSpreadEngine.getMultiplier(symbol);
    for (const tier of VOLATILITY_LEVERAGE_TIERS) {
      if (multiplier >= tier.minMultiplier) return tier.leverageFactor;
    }
    return 1;
  }

  /** Applies volatility derating on top of an already ESMA-capped leverage value. */
  apply(symbol: string, cappedLeverage: number): number {
    const factor = this.factorFor(symbol);
    if (factor >= 1) return cappedLeverage;
    return Math.max(1, Math.floor(cappedLeverage * factor));
  }
}

export const volatilityLeverageGuard = new VolatilityLeverageGuard();
