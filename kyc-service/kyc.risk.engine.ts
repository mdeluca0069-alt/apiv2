/**
 * KycRiskEngine — automated pre-approval checks on submitted KYC data.
 *
 * Runs after OCR extraction and before human review.
 * Generates a risk score (0–100, higher = more risk) and a list of flags.
 *
 * Checks:
 *   1. Expired document
 *   2. Document expiry too close (< 6 months)
 *   3. Underage account (< 18 years)
 *   4. Name mismatch between document and account profile
 *   5. Restricted country
 *   6. Duplicate document number (same doc used by another account)
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import type { OcrExtractedFields } from "./ocr.provider.js";

// Countries not permitted under ESMA/FATF framework
const RESTRICTED_COUNTRIES = new Set([
  "KP", // North Korea
  "IR", // Iran
  "SY", // Syria
  "CU", // Cuba
  "SD", // Sudan
  "LY", // Libya (limited)
  "MM", // Myanmar
  "SO", // Somalia
]);

export type KycRiskFlag = {
  code:     string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  message:  string;
};

export type KycRiskAssessment = {
  riskScore:          number;    // 0–100
  verificationScore:  number;    // 0–100
  autoApprove:        boolean;
  autoReject:         boolean;
  flags:              KycRiskFlag[];
  assessedAt:         string;
};

const ONE_YEAR_MS  = 365.25 * 86_400_000;
const SIX_MONTHS_MS = 183 * 86_400_000;

function parseDate(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export class KycRiskEngine {

  async assess(
    userId:        string,
    extracted:     OcrExtractedFields,
    documentNumber?: string,
  ): Promise<KycRiskAssessment> {
    const flags: KycRiskFlag[] = [];
    let riskScore = 0;
    const now     = new Date();

    // ── 1. Expiry date checks ────────────────────────────────────────────────
    const expiry = parseDate(extracted.expiryDate);
    if (expiry !== null) {
      if (expiry < now) {
        flags.push({
          code: "DOCUMENT_EXPIRED",
          severity: "CRITICAL",
          message: `Document expired on ${extracted.expiryDate}`,
        });
        riskScore += 40;
      } else if (expiry.getTime() - now.getTime() < SIX_MONTHS_MS) {
        flags.push({
          code: "DOCUMENT_EXPIRY_SOON",
          severity: "MEDIUM",
          message: `Document expires within 6 months (${extracted.expiryDate})`,
        });
        riskScore += 10;
      }
    }

    // ── 2. Age check ─────────────────────────────────────────────────────────
    const dob = parseDate(extracted.dateOfBirth);
    if (dob !== null) {
      const ageYears = (now.getTime() - dob.getTime()) / ONE_YEAR_MS;
      if (ageYears < 18) {
        flags.push({
          code: "UNDERAGE",
          severity: "CRITICAL",
          message: `Account holder appears to be under 18 (DoB: ${extracted.dateOfBirth})`,
        });
        riskScore += 50;
      }
    }

    // ── 3. Country restriction ───────────────────────────────────────────────
    const country = extracted.issuingCountry?.toUpperCase();
    if (country && RESTRICTED_COUNTRIES.has(country)) {
      flags.push({
        code: "RESTRICTED_COUNTRY",
        severity: "CRITICAL",
        message: `Issuing country '${country}' is on the restricted list`,
      });
      riskScore += 60;
    }

    // ── 4. Name mismatch ─────────────────────────────────────────────────────
    if (extracted.fullName && IS_PERSISTENT) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true },
      });
      if (user) {
        const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
        const docName  = normalize(extracted.fullName);
        const profName = normalize(user.fullName);
        // Simple heuristic: check if all tokens of profile name appear in doc name
        const profileTokens = profName.split(" ").filter(Boolean);
        const allMatch = profileTokens.every((t) => docName.includes(t));
        if (!allMatch && profName.length > 2) {
          flags.push({
            code: "NAME_MISMATCH",
            severity: "HIGH",
            message: `Profile name '${user.fullName}' does not match document '${extracted.fullName}'`,
          });
          riskScore += 25;
        }
      }
    }

    // ── 5. Duplicate document number ─────────────────────────────────────────
    if (documentNumber && IS_PERSISTENT) {
      // KycDocument.caseId → KycCase has no Prisma @relation, so filter by caseId directly
      const thisCase = await prisma.kycCase.findUnique({ where: { userId }, select: { id: true } });
      const dup = await prisma.kycDocument.findFirst({
        where: {
          documentNumber,
          status: { not: "REJECTED" },
          ...(thisCase ? { NOT: { caseId: thisCase.id } } : {}),
        },
        select: { id: true },
      });
      if (dup) {
        flags.push({
          code: "DUPLICATE_DOCUMENT",
          severity: "CRITICAL",
          message: `Document number '${documentNumber}' is already associated with another account`,
        });
        riskScore += 70;
      }
    }

    // ── Score clamp + auto-decision ──────────────────────────────────────────
    riskScore = Math.min(100, riskScore);
    const criticalFlags  = flags.filter((f) => f.severity === "CRITICAL");
    const verificationScore = Math.max(0, 100 - riskScore);

    const autoReject  = criticalFlags.length > 0;
    const autoApprove = !autoReject && riskScore === 0 && flags.length === 0;

    return {
      riskScore,
      verificationScore,
      autoApprove,
      autoReject,
      flags,
      assessedAt: now.toISOString(),
    };
  }
}

export const kycRiskEngine = new KycRiskEngine();
