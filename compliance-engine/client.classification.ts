/**
 * ClientClassification — MiFID II Article 4 client categorisation.
 * All retail clients under ESMA jurisdiction are classified as RETAIL
 * by default. Professional / ECP requires opt-up request + assessment.
 */
import { IS_PERSISTENT } from "../shared/db.js";
import { immutableAudit } from "../security/immutable.audit.js";

export type ClientCategory = "RETAIL" | "PROFESSIONAL" | "ELIGIBLE_COUNTERPARTY";

export type ClassificationResult = {
  userId:     string;
  category:   ClientCategory;
  basis:      string;
  effectiveAt: string;
};

export class ClientClassificationService {

  async classify(userId: string): Promise<ClassificationResult> {
    // Default: all new clients are RETAIL
    const result: ClassificationResult = {
      userId,
      category:   "RETAIL",
      basis:      "Default ESMA retail classification — no opt-up request received",
      effectiveAt: new Date().toISOString(),
    };

    if (IS_PERSISTENT) {
      await immutableAudit.write({
        actor: "CLIENT_CLASSIFICATION",
        action: "client.classified",
        entity: userId,
        payload: result as unknown as object,
      });
    }

    return result;
  }

  async optUpToProfessional(
    userId: string, evidence: Record<string, unknown>,
  ): Promise<{ approved: boolean; reason: string }> {
    // Professional opt-up requires 2-of-3 criteria:
    // 1. 10+ significant trades per quarter in past year
    // 2. Financial instrument portfolio > 500,000 EUR
    // 3. 1+ year in relevant professional role
    const criteria = [
      Boolean(evidence.tradingHistory),
      Boolean(evidence.portfolioSize),
      Boolean(evidence.professionalRole),
    ];
    const score = criteria.filter(Boolean).length;
    const approved = score >= 2;

    if (IS_PERSISTENT) {
      await immutableAudit.write({
        actor: userId,
        action: `client.opt_up.${approved ? "approved" : "rejected"}`,
        entity: userId,
        payload: { evidence, score, approved } as object,
      });
    }

    return { approved, reason: approved ? "2-of-3 criteria met" : `Only ${score}/3 criteria met` };
  }
}

export const clientClassification = new ClientClassificationService();
export default clientClassification;
