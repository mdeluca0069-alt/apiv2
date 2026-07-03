/**
 * AppropriatenessTest — MiFID II Article 25 retail client suitability assessment.
 * Delegates to MifidEngine. Provides a standalone callable interface.
 */
import { mifidEngine } from "./mifid.engine.js";
export type { AppropriatenessResult } from "./mifid.engine.js";

export const appropriatenessTest = {
  assess: (userId: string, answers: Record<string, unknown>) =>
    mifidEngine.assessAppropriateness(userId, answers),
};

export default appropriatenessTest;
