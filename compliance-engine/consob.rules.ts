/**
 * CONSOB Rules — Italian financial market regulator (Commissione Nazionale per le Società e la Borsa).
 * CONSOB enforces MiFID II + additional Italian-specific requirements for CFD retail distribution.
 * Delegates to ESMA rules engine for leverage caps; adds Italian-specific disclosure requirements.
 */
import { esmaRules, ESMA_LEVERAGE_CAPS } from "./esma.rules.js";

export const CONSOB_MANDATORY_DISCLOSURES = [
  "CFDs sono strumenti complessi e comportano un rischio elevato di perdere denaro rapidamente a causa della leva finanziaria.",
  "Tra il 74% e l'89% dei conti degli investitori al dettaglio perde denaro quando negozia CFD.",
  "Si deve considerare se si è in grado di sostenere l'elevato rischio di perdere il denaro investito.",
];

export type ConsobCheck = {
  compliant:     boolean;
  disclosures:   string[];
  leverageCheck: ReturnType<typeof esmaRules.checkLeverage>;
};

export class ConsobRulesEngine {

  check(assetClass: string, requestedLeverage: number): ConsobCheck {
    const leverageCheck = esmaRules.checkLeverage(assetClass, requestedLeverage);
    return {
      compliant:   leverageCheck.allowed,
      disclosures: CONSOB_MANDATORY_DISCLOSURES,
      leverageCheck,
    };
  }

  getLeverageCap(assetClass: string): number {
    return ESMA_LEVERAGE_CAPS[assetClass] ?? 2;
  }
}

export const consobRules = new ConsobRulesEngine();
export default consobRules;
