import { prisma } from "../shared/db.js";
import { ESMA_LEVERAGE_CAPS } from "../shared/contracts.js";

export type LeverageCheckResult = {
  effectiveLeverage: number;
  capped:            boolean;
  requestedLeverage: number;
  cap:               number;
};

export class LeverageGuard {
  /**
   * Silently caps leverage at the ESMA retail limit for the asset class.
   * Never rejects — capping is the compliant behaviour.
   */
  check(assetClass: string, requestedLeverage: number): LeverageCheckResult {
    const cap             = ESMA_LEVERAGE_CAPS[assetClass] ?? 2;
    const effectiveLeverage = Math.min(requestedLeverage, cap);
    return {
      effectiveLeverage,
      capped:            effectiveLeverage < requestedLeverage,
      requestedLeverage,
      cap,
    };
  }

  async getInstrument(symbol: string) {
    const instrument = await prisma.instrument.findUnique({
      where:  { symbol },
      select: { assetClass: true, minTradeSize: true, maxLeverageRetail: true, precision: true },
    });
    if (!instrument) throw new Error(`INSTRUMENT_NOT_FOUND:${symbol}`);
    return instrument;
  }

  computeNotional(quantity: number, price: number): number {
    return quantity * price;
  }

  computeMarginRequired(notional: number, effectiveLeverage: number): number {
    if (effectiveLeverage <= 0) throw new Error("Invalid leverage");
    return notional / effectiveLeverage;
  }
}

export const leverageGuard = new LeverageGuard();
