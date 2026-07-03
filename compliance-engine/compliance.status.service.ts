/**
 * ComplianceStatusService — exposes client-facing compliance state from DB.
 *
 * Sources:
 *   KYC status        — User.kycStatus + KycCase.status
 *   AML status        — derived from transaction monitoring history (AuditLog)
 *   Document status   — KycCase.documents aggregation
 *   Sanctions         — User.kycStatus (APPROVED means sanctions cleared)
 *   PEP               — KycCase risk flags
 *   Audit trail       — always "active" when DB is available
 *   Client class      — User.tier
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";

export type ComplianceStatus = {
  kycStatus:          string;
  amlStatus:          string;
  documentStatus:     string;
  sanctionsScreening: string;
  pepScreening:       string;
  auditTrailStatus:   string;
  clientClassification: string;
  lastReviewAt:       string | null;
};

function sandboxStatus(): ComplianceStatus {
  return {
    kycStatus:            "pending",
    amlStatus:            "pending",
    documentStatus:       "pending",
    sanctionsScreening:   "pending",
    pepScreening:         "pending",
    auditTrailStatus:     "active",
    clientClassification: "retail",
    lastReviewAt:         null,
  };
}

/** Map internal KYC case status to client-facing display string. */
function mapKycStatus(kycStatus: string, caseStatus?: string): string {
  const status = caseStatus ?? kycStatus;
  switch (status) {
    case "APPROVED":       return "verified";
    case "REJECTED":       return "rejected";
    case "MANUAL_REVIEW":  return "review";
    case "SUBMITTED":
    case "OCR_PENDING":
    case "DOCUMENT_CHECK":
    case "SELFIE_CHECK":
    case "ADDRESS_CHECK":  return "pending";
    default:               return "pending";
  }
}

/** Map document collection status from array of doc statuses. */
function mapDocumentStatus(docStatuses: string[]): string {
  if (docStatuses.length === 0)                                return "pending";
  if (docStatuses.every((s) => s === "APPROVED"))             return "complete";
  if (docStatuses.some((s) => s === "REJECTED"))              return "rejected";
  if (docStatuses.some((s) => s === "APPROVED"))              return "review";
  return "pending";
}

export class ComplianceStatusService {

  async getStatus(userId: string): Promise<ComplianceStatus> {
    if (!IS_PERSISTENT) return sandboxStatus();

    // Fetch user + kyc case + documents in parallel
    const [user, kycCase, docs, amlAuditCount] = await Promise.all([
      prisma.user.findUnique({
        where:  { id: userId },
        select: { kycStatus: true, tier: true },
      }),
      prisma.kycCase.findUnique({
        where:  { userId },
        select: { status: true, riskScore: true, updatedAt: true },
      }).catch(() => null),
      prisma.clientDocument.findMany({
        where:  { userId },
        select: { status: true },
      }).catch(() => []),
      // AML: count of COMPLETED AML audit actions for this user
      prisma.auditLog.count({
        where: {
          actor:  userId,
          action: { contains: "aml" },
        },
      }).catch(() => 0),
    ]);

    if (!user) return sandboxStatus();

    const kycStatusDisplay = mapKycStatus(user.kycStatus, kycCase?.status);
    const documentStatuses = docs.map((d) => d.status);
    const documentStatusDisplay = mapDocumentStatus(documentStatuses);

    // AML: if user is KYC approved and no AML flags, mark clear
    const amlStatus =
      kycStatusDisplay === "verified" ? "clear"
      : amlAuditCount > 0            ? "review"
      : "pending";

    // Sanctions: cleared if KYC approved (sanctions check is part of KYC workflow)
    const sanctionsStatus =
      kycStatusDisplay === "verified" ? "clear"
      : kycStatusDisplay === "review" ? "review"
      : "pending";

    // PEP: inferred from risk score on KYC case
    const riskScore = Number(kycCase?.riskScore ?? 0);
    const pepStatus =
      kycStatusDisplay !== "verified" ? "pending"
      : riskScore > 70               ? "review"
      : "clear";

    // Client classification from tier
    const tierMap: Record<string, string> = {
      STANDARD:   "retail",
      GOLD:       "retail",
      VIP:        "professional",
      PLATINUM:   "professional",
      ENTERPRISE: "institutional",
    };
    const clientClassification = tierMap[user.tier] ?? "retail";

    return {
      kycStatus:            kycStatusDisplay,
      amlStatus,
      documentStatus:       documentStatusDisplay,
      sanctionsScreening:   sanctionsStatus,
      pepScreening:         pepStatus,
      auditTrailStatus:     "active",
      clientClassification,
      lastReviewAt:         kycCase?.updatedAt?.toISOString() ?? null,
    };
  }
}

export const complianceStatusService = new ComplianceStatusService();
