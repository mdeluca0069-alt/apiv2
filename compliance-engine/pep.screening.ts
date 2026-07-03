/**
 * PEP Screening — Politically Exposed Persons check.
 *
 * PEPs require Enhanced Due Diligence (EDD) under AMLD5/6.
 * Production: integrate with World-Check, ComplyAdvantage, or Dow Jones RiskCenter.
 *
 * Configuration:
 *   PEP_PROVIDER=complyadvantage|world-check|internal
 *   PEP_API_KEY=<key>
 *   PEP_API_URL=<url>          (optional — provider-specific base URL)
 *
 * When PEP_PROVIDER is not set or set to "internal", this module routes ALL
 * cases to manual review (requiresEdd=true) and emits a risk.warning.
 * This is the SAFE FALLBACK — never silently clear PEP status without a real check.
 *
 * CRITICAL: Do NOT set requiresEdd=false or isPep=false without a live provider
 * in production — this constitutes an AMLD5/6 compliance failure.
 */
import { randomUUID } from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }  from "../events-bus/event.bus.js";

export type PepResult = {
  isPep:        boolean;
  category?:   "DOMESTIC_PEP" | "FOREIGN_PEP" | "INTERNATIONAL_ORG" | "FAMILY_MEMBER" | "CLOSE_ASSOCIATE";
  confidence:   number;
  requiresEdd:  boolean;
  screenedAt:   string;
  source:       string;
};

const PEP_PROVIDER = process.env.PEP_PROVIDER ?? "internal";
const PEP_API_KEY  = process.env.PEP_API_KEY  ?? "";
const PEP_API_URL  = process.env.PEP_API_URL  ?? "";

/**
 * Call the ComplyAdvantage API for PEP/sanctions check.
 * Returns null if the call fails — caller falls back to manual review.
 */
async function callComplyAdvantage(fullName: string, countryCode: string): Promise<PepResult | null> {
  if (!PEP_API_KEY) return null;

  const baseUrl = PEP_API_URL || "https://api.complyadvantage.com";
  const body = JSON.stringify({
    search_term: fullName,
    fuzziness:   0.6,
    filters: {
      types: ["pep", "sanction", "adverse-media"],
      ...(countryCode ? { entity_type: "person", countries: [countryCode] } : {}),
    },
  });

  const res = await fetch(`${baseUrl}/searches`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Token ${PEP_API_KEY}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as {
    data?: {
      hits?: Array<{
        match_types?: string[];
        score?: number;
        doc?: { types?: string[] };
      }>;
    };
  };

  const hits       = data?.data?.hits ?? [];
  const pepHits    = hits.filter((h) =>
    h.match_types?.some((t) => t === "pep") ||
    h.doc?.types?.some((t) => t === "pep"),
  );
  const topScore   = hits.length > 0 ? (hits[0]?.score ?? 0) : 0;
  const isPep      = pepHits.length > 0 && topScore >= 0.6;

  return {
    isPep,
    confidence:  topScore,
    requiresEdd: isPep,
    screenedAt:  new Date().toISOString(),
    source:      "complyadvantage",
  };
}

/**
 * Call the World-Check One API for PEP/sanctions check.
 * Returns null if the call fails — caller falls back to manual review.
 */
async function callWorldCheck(fullName: string, countryCode: string): Promise<PepResult | null> {
  if (!PEP_API_KEY || !PEP_API_URL) return null;

  const [apiId, apiKey] = PEP_API_KEY.split(":");
  if (!apiId || !apiKey) return null;

  const body = JSON.stringify({
    caseSystemId: randomUUID(),
    name:         fullName,
    nameTranslit: fullName,
    entityType:   "INDIVIDUAL",
    countryOfResidence: [countryCode],
    providerTypes: ["PEP", "SANCTION", "ADVERSE_MEDIA"],
  });

  const res = await fetch(`${PEP_API_URL}/screening-request`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "WC-Api-Id":    apiId,
      "WC-Api-Key":   apiKey,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as {
    hits?: Array<{ hitType?: string; score?: number }>;
  };

  const hits   = data?.hits ?? [];
  const pepHits = hits.filter((h) => h.hitType === "PEP");
  const isPep   = pepHits.length > 0;

  return {
    isPep,
    confidence:  isPep ? (pepHits[0]?.score ?? 0.8) : 0.0,
    requiresEdd: isPep,
    screenedAt:  new Date().toISOString(),
    source:      "world-check",
  };
}

export class PepScreening {

  /**
   * Screen a person for PEP status.
   *
   * When a live provider is configured (PEP_PROVIDER=complyadvantage|world-check),
   * calls the provider API. On API failure or when PEP_PROVIDER is "internal",
   * returns MANUAL_REVIEW_REQUIRED with requiresEdd=true. This ensures the case
   * is NEVER silently cleared — a human reviewer must always confirm.
   *
   * AMLD5/6 compliance note: returning isPep=false with confidence=0 without
   * a real provider check is a regulatory violation. This implementation enforces
   * the safe path: unknown = manual review.
   */
  async screen(userId: string, fullName: string, countryCode: string): Promise<PepResult> {
    const screenedAt = new Date().toISOString();

    let result: PepResult | null = null;

    if (PEP_PROVIDER === "complyadvantage") {
      result = await callComplyAdvantage(fullName, countryCode).catch((err) => {
        console.error("[pep-screening] ComplyAdvantage call failed:", (err as Error).message);
        return null;
      });
    } else if (PEP_PROVIDER === "world-check") {
      result = await callWorldCheck(fullName, countryCode).catch((err) => {
        console.error("[pep-screening] World-Check call failed:", (err as Error).message);
        return null;
      });
    }

    if (!result) {
      // No live provider or provider call failed — route to manual review.
      // NEVER return isPep=false with confidence=0 — that silently clears the check.
      const reason = PEP_PROVIDER === "internal"
        ? "No PEP provider configured — PEP_PROVIDER must be set to 'complyadvantage' or 'world-check' before live trading"
        : `PEP provider '${PEP_PROVIDER}' API call failed — falling back to manual review`;

      console.warn(`[pep-screening] MANUAL_REVIEW_REQUIRED for userId=${userId}: ${reason}`);

      result = {
        isPep:       false,       // unknown, not confirmed clear
        confidence:  0.0,
        requiresEdd: true,        // always true when we can't actually check
        screenedAt,
        source:      "MANUAL_REVIEW_REQUIRED",
      };
    }

    if (IS_PERSISTENT) {
      await (prisma as NonNullable<typeof prisma>).auditLog.create({
        data: {
          id:      randomUUID(),
          actor:   "PEP_SCREENING",
          action:  `pep.screen.${result.isPep ? "hit" : result.requiresEdd ? "manual-review" : "clear"}`,
          entity:  userId,
          payload: { fullName, countryCode, ...result } as object,
        },
      }).catch(() => {});

      if (result.isPep || result.requiresEdd) {
        (eventBus.emit as (...args: unknown[]) => void)("risk.warning", {
          userId,
          severity: result.isPep ? "HIGH" : "MEDIUM",
          reason:   result.isPep ? "PEP_HIT" : "PEP_MANUAL_REVIEW",
          message:  result.isPep
            ? `PEP screening HIT for ${fullName} — Enhanced Due Diligence required`
            : `PEP screening inconclusive for ${fullName} — manual review required`,
          payload: result,
          timestamp: screenedAt,
        });
      }
    }

    return result;
  }
}

export const pepScreening = new PepScreening();
export default pepScreening;
