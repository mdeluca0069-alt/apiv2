/**
 * LeverageLimits — enforcement layer on top of esma.rules.ts.
 * Provides broker-configurable limits that may be tighter than ESMA minimums.
 */
import { ESMA_LEVERAGE_CAPS } from "./esma.rules.js";
import { IS_PERSISTENT } from "../shared/db.js";
import { immutableAudit } from "../security/immutable.audit.js";

// Broker may tighten limits below ESMA maximums
const BROKER_LEVERAGE_OVERRIDES: Partial<Record<string, number>> = {
  CRYPTO: 2,   // keep at ESMA minimum — no exceptions
};

export type LimitResult = {
  assetClass:   string;
  requestedLev: number;
  esmaMax:      number;
  brokerMax:    number;
  effective:    number;
  compliant:    boolean;
};

export class LeverageLimitsService {

  getLimit(assetClass: string): number {
    const esmaMax   = ESMA_LEVERAGE_CAPS[assetClass] ?? 2;
    const brokerMax = BROKER_LEVERAGE_OVERRIDES[assetClass] ?? esmaMax;
    return Math.min(esmaMax, brokerMax);
  }

  check(assetClass: string, requestedLev: number): LimitResult {
    const esmaMax   = ESMA_LEVERAGE_CAPS[assetClass] ?? 2;
    const brokerMax = BROKER_LEVERAGE_OVERRIDES[assetClass] ?? esmaMax;
    const effective = Math.min(requestedLev, esmaMax, brokerMax);
    return {
      assetClass,
      requestedLev,
      esmaMax,
      brokerMax,
      effective,
      compliant: requestedLev <= effective,
    };
  }

  async checkFromDb(userId: string, assetClass: string, requestedLev: number): Promise<LimitResult> {
    const result = this.check(assetClass, requestedLev);

    if (!result.compliant && IS_PERSISTENT) {
      await immutableAudit.write({
        actor:   userId,
        action:  "leverage.limit_exceeded",
        entity:  userId,
        payload: result as unknown as object,
      });
    }

    return result;
  }
}

export const leverageLimits = new LeverageLimitsService();
export default leverageLimits;
