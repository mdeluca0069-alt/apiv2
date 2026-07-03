/**
 * KycService — orchestrates the full KYC verification workflow.
 *
 * Workflow states:
 *   SUBMITTED → OCR_PENDING → DOCUMENT_CHECK → SELFIE_CHECK
 *   → ADDRESS_CHECK → APPROVED | REJECTED | MANUAL_REVIEW
 *
 * Each step creates an immutable KycVerificationStep row.
 * Every admin action writes to AuditLog.
 */
import { randomUUID }    from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { ocrProvider, type OcrDocumentType } from "./ocr.provider.js";
import { livenessProvider }   from "./liveness.provider.js";
import { kycRiskEngine }      from "./kyc.risk.engine.js";
import { sumsubProvider }     from "./sumsub.provider.js";
import type { SumsubWebhookPayload } from "./sumsub.provider.js";
import { eventBus }           from "../events-bus/event.bus.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type KycCaseStatus =
  | "SUBMITTED"
  | "OCR_PENDING"
  | "DOCUMENT_CHECK"
  | "SELFIE_CHECK"
  | "ADDRESS_CHECK"
  | "MANUAL_REVIEW"
  | "APPROVED"
  | "REJECTED";

export type KycDocumentKey =
  | "PASSPORT"
  | "SELFIE"
  | "PROOF_OF_ADDRESS"
  | "NATIONAL_ID"
  | "DRIVERS_LICENSE";

export type DocumentUploadInput = {
  userId:      string;
  documentKey: KycDocumentKey;
  label:       string;
  fileName:    string;
  mimeType?:   string;
  content:     string;    // base64 (data: URI or raw)
};

export type KycCaseSummary = {
  id:                string;
  userId:            string;
  status:            KycCaseStatus;
  riskScore:         number;
  verificationScore: number;
  flags:             unknown[];
  documents:         KycDocumentSummary[];
  steps:             KycStepSummary[];
  createdAt:         string;
  updatedAt:         string;
};

export type KycDocumentSummary = {
  id:              string;
  documentKey:     string;
  label:           string;
  status:          string;
  fileName?:       string;
  extractedData?:  unknown;
  livenessScore?:  number;
  rejectionReason?: string;
  createdAt:       string;
};

export type KycStepSummary = {
  id:         string;
  stepType:   string;
  status:     string;
  provider?:  string;
  confidence?: number;
  createdAt:  string;
};

// ─── In-memory fallback for sandbox mode ─────────────────────────────────────

const _sandboxCases = new Map<string, KycCaseSummary>();

// ─── KycService ───────────────────────────────────────────────────────────────

export class KycService {

  /**
   * Get or create a KYC case for the user.
   */
  async getOrCreateCase(userId: string): Promise<KycCaseSummary> {
    if (!IS_PERSISTENT) {
      if (!_sandboxCases.has(userId)) {
        _sandboxCases.set(userId, {
          id: randomUUID(), userId, status: "SUBMITTED",
          riskScore: 0, verificationScore: 0, flags: [],
          documents: [], steps: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      return _sandboxCases.get(userId)!;
    }

    const existing = await prisma.kycCase.findUnique({ where: { userId } });
    if (existing) {
      const [steps, documents] = await Promise.all([
        prisma.kycVerificationStep.findMany({ where: { caseId: existing.id } }),
        prisma.kycDocument.findMany({ where: { caseId: existing.id } }),
      ]);
      return this._toSummary({ ...existing, steps, documents });
    }

    const row = await prisma.kycCase.create({ data: { userId } });
    await this._audit("SYSTEM", "kyc.case_created", userId, { userId });
    const [steps, documents] = await Promise.all([
      prisma.kycVerificationStep.findMany({ where: { caseId: row.id } }),
      prisma.kycDocument.findMany({ where: { caseId: row.id } }),
    ]);
    return this._toSummary({ ...row, steps, documents });
  }

  /**
   * Accept a document upload, run OCR + risk engine, update the case.
   */
  async uploadDocument(input: DocumentUploadInput): Promise<KycDocumentSummary> {
    const { userId, documentKey, label, fileName, mimeType, content } = input;

    if (!IS_PERSISTENT) {
      const kase = await this.getOrCreateCase(userId);
      const doc: KycDocumentSummary = {
        id: randomUUID(), documentKey, label, status: "PENDING",
        fileName, createdAt: new Date().toISOString(),
      };
      kase.documents.push(doc);
      _sandboxCases.set(userId, kase);
      return doc;
    }

    // Ensure case exists
    const kase = await this.getOrCreateCase(userId);

    // ── OCR / liveness ────────────────────────────────────────────────────────
    let extractedData: unknown     = null;
    let livenessScore: number | null = null;
    let documentNumber: string | undefined;

    if (documentKey === "SELFIE") {
      const liveness = await livenessProvider.verify(content);
      livenessScore  = liveness.livenessScore;
      extractedData  = liveness;

      await this._addStep(kase.id, "SELFIE_CHECK", liveness.provider, liveness.livenessScore, {
        status: liveness.status, spoofAttempt: liveness.spoofAttempt,
      });
    } else {
      const docType: OcrDocumentType =
        documentKey === "PASSPORT"          ? "PASSPORT"          :
        documentKey === "NATIONAL_ID"       ? "NATIONAL_ID"       :
        documentKey === "DRIVERS_LICENSE"   ? "DRIVERS_LICENSE"   :
        documentKey === "PROOF_OF_ADDRESS"  ? "PROOF_OF_ADDRESS"  :
        "NATIONAL_ID";

      const ocr = await ocrProvider.extract(content, docType);
      extractedData  = { ...ocr.extractedFields, _provider: ocr.provider };
      documentNumber = ocr.extractedFields.documentNumber;

      await this._addStep(kase.id, "OCR_PENDING", ocr.provider, ocr.confidence, {
        status: ocr.status, documentType: docType,
      });

      // Risk engine assessment
      if (docType !== "PROOF_OF_ADDRESS") {
        const risk = await kycRiskEngine.assess(userId, ocr.extractedFields, documentNumber);
        await this._addStep(kase.id, "DOCUMENT_CHECK", "internal-risk-engine", risk.verificationScore / 100, {
          riskScore: risk.riskScore, flags: risk.flags,
        });

        // Update case risk scores
        await prisma.kycCase.update({
          where: { id: kase.id },
          data: {
            riskScore:         risk.riskScore,
            verificationScore: risk.verificationScore,
            status:            risk.autoReject ? "REJECTED" : risk.autoApprove ? "DOCUMENT_CHECK" : "DOCUMENT_CHECK",
          },
        });

        if (risk.autoReject) {
          await this._rejectCase(kase.id, "SYSTEM", "Auto-rejected: " + risk.flags.map((f) => f.message).join("; "));
        }
      } else {
        await this._addStep(kase.id, "ADDRESS_CHECK", ocrProvider.name, 0, {});
      }
    }

    // Persist the document
    const doc = await prisma.kycDocument.create({
      data: {
        caseId:         kase.id,
        documentKey,
        label,
        status:         "PENDING",
        fileName,
        mimeType:       mimeType ?? "application/octet-stream",
        documentNumber: documentNumber ?? null,
        extractedData:  extractedData as object ?? {},
        livenessScore:  livenessScore,
      },
    });

    // Update case to MANUAL_REVIEW if all required docs are in
    await this._advanceCaseStatus(kase.id, userId);

    eventBus.emit("kyc.document_uploaded", {
      userId, documentKey, caseId: kase.id, timestamp: new Date().toISOString(),
    });

    return {
      id:             doc.id,
      documentKey:    doc.documentKey,
      label:          doc.label,
      status:         doc.status,
      fileName:       doc.fileName ?? undefined,
      extractedData:  doc.extractedData,
      livenessScore:  doc.livenessScore ?? undefined,
      createdAt:      doc.createdAt.toISOString(),
    };
  }

  /**
   * Admin: approve a KYC case.
   */
  async approveCase(caseId: string, adminId: string, notes?: string): Promise<void> {
    if (!IS_PERSISTENT) {
      throw Object.assign(
        new Error("KYC case approval requires a database connection. This operation is not available in sandbox mode."),
        { status: 503 },
      );
    }

    const kase = await prisma.kycCase.findUnique({ where: { id: caseId } });
    if (!kase) throw new Error(`KYC case not found: ${caseId}`);

    await prisma.$transaction(async (tx) => {
      await tx.kycCase.update({
        where: { id: caseId },
        data: {
          status:      "APPROVED",
          reviewedBy:  adminId,
          reviewNotes: notes ?? null,
          reviewedAt:  new Date(),
          completedAt: new Date(),
        },
      });

      // Update user's kycStatus in User table
      await tx.user.update({
        where: { id: kase.userId },
        data:  { kycStatus: "approved" },
      });

      await tx.auditLog.create({
        data: {
          id:      randomUUID(),
          actor:   adminId,
          action:  "kyc.case_approved",
          entity:  caseId,
          payload: { userId: kase.userId, notes } as object,
        },
      });
    }, { maxWait: 10000, timeout: 15000 });

    eventBus.emit("kyc.approved", {
      userId: kase.userId, caseId, adminId, timestamp: new Date().toISOString(),
    });
  }

  /**
   * Admin: reject a KYC case.
   */
  async rejectCase(caseId: string, adminId: string, reason: string): Promise<void> {
    if (!IS_PERSISTENT) {
      throw Object.assign(
        new Error("KYC case rejection requires a database connection. This operation is not available in sandbox mode."),
        { status: 503 },
      );
    }
    await this._rejectCase(caseId, adminId, reason);
  }

  /**
   * Admin: request additional documents.
   */
  async requestMoreDocuments(
    caseId:       string,
    adminId:      string,
    documentsNeeded: string[],
    notes?:       string,
  ): Promise<void> {
    if (!IS_PERSISTENT) {
      throw Object.assign(
        new Error("Requesting additional KYC documents requires a database connection. This operation is not available in sandbox mode."),
        { status: 503 },
      );
    }

    await prisma.kycCase.update({
      where: { id: caseId },
      data: {
        status:      "SUBMITTED",
        reviewedBy:  adminId,
        reviewNotes: notes ?? null,
      },
    });

    await this._audit(adminId, "kyc.additional_docs_requested", caseId, {
      documentsNeeded, notes,
    });

    const kase = await prisma.kycCase.findUnique({ where: { id: caseId }, select: { userId: true } });
    if (kase) {
      eventBus.emit("kyc.docs_requested", {
        userId: kase.userId, caseId, documentsNeeded, adminId, timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Admin: list all cases pending review.
   */
  async getPendingCases(limit = 50): Promise<KycCaseSummary[]> {
    if (!IS_PERSISTENT) return [];

    const rows = await prisma.kycCase.findMany({
      where:   { status: { in: ["DOCUMENT_CHECK", "SELFIE_CHECK", "ADDRESS_CHECK", "MANUAL_REVIEW"] } },
      orderBy: { createdAt: "asc" },
      take:    limit,
    });

    return Promise.all(rows.map(async (r) => {
      const [steps, documents] = await Promise.all([
        prisma.kycVerificationStep.findMany({ where: { caseId: r.id } }),
        prisma.kycDocument.findMany({ where: { caseId: r.id } }),
      ]);
      return this._toSummary({ ...r, steps, documents });
    }));
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async _addStep(
    caseId:     string,
    stepType:   string,
    provider:   string,
    confidence: number,
    result:     object,
  ): Promise<void> {
    const passed = confidence > 0.5;
    await prisma.kycVerificationStep.create({
      data: {
        caseId,
        stepType,
        status:   passed ? "PASSED" : "INCONCLUSIVE",
        provider,
        confidence,
        result:   result as object,
      },
    });
  }

  private async _rejectCase(caseId: string, actorId: string, reason: string): Promise<void> {
    const kase = await prisma.kycCase.findUnique({ where: { id: caseId } });
    if (!kase) return;

    await prisma.$transaction(async (tx) => {
      await tx.kycCase.update({
        where: { id: caseId },
        data: {
          status:      "REJECTED",
          reviewedBy:  actorId,
          reviewNotes: reason,
          reviewedAt:  new Date(),
          completedAt: new Date(),
        },
      });

      await tx.user.update({
        where: { id: kase.userId },
        data:  { kycStatus: "rejected" },
      });

      await tx.auditLog.create({
        data: {
          id:      randomUUID(),
          actor:   actorId,
          action:  "kyc.case_rejected",
          entity:  caseId,
          payload: { userId: kase.userId, reason } as object,
        },
      });
    }, { maxWait: 10000, timeout: 15000 });

    eventBus.emit("kyc.rejected", {
      userId: kase.userId, caseId, reason, actorId, timestamp: new Date().toISOString(),
    });
  }

  private async _advanceCaseStatus(caseId: string, _userId: string): Promise<void> {
    const docs = await prisma.kycDocument.findMany({ where: { caseId } });
    const hasPassport = docs.some((d) =>
      d.documentKey === "PASSPORT" || d.documentKey === "NATIONAL_ID" || d.documentKey === "DRIVERS_LICENSE"
    );
    const hasSelfie  = docs.some((d) => d.documentKey === "SELFIE");
    const hasAddress = docs.some((d) => d.documentKey === "PROOF_OF_ADDRESS");

    let nextStatus: KycCaseStatus = "SUBMITTED";
    if (hasPassport && hasSelfie && hasAddress) nextStatus = "MANUAL_REVIEW";
    else if (hasPassport && hasSelfie)          nextStatus = "ADDRESS_CHECK";
    else if (hasPassport)                       nextStatus = "SELFIE_CHECK";

    await prisma.kycCase.update({
      where: { id: caseId },
      data:  { status: nextStatus },
    });
  }

  // ─── Sumsub integration ────────────────────────────────────────────────────

  /**
   * Get or create a Sumsub applicant for the user and return an SDK access token.
   * Called by GET /api/v1/kyc/sumsub/access-token.
   */
  async getSumsubAccessToken(userId: string): Promise<{ token: string; applicantId: string }> {
    if (!sumsubProvider.isConfigured) {
      throw new Error("SUMSUB_NOT_CONFIGURED: Set SUMSUB_APP_TOKEN and SUMSUB_SECRET_KEY in .env");
    }

    // Ensure KYC case exists in our DB
    const kase = await this.getOrCreateCase(userId);

    // Get or create Sumsub applicant
    let applicantId = (kase as Record<string, unknown>).sumsubApplicantId as string | undefined;

    if (!applicantId && IS_PERSISTENT) {
      // Check if applicant already exists in Sumsub (by externalUserId = our userId)
      const db = prisma as NonNullable<typeof prisma>;
      const user = await db.user.findUnique({
        where:  { id: userId },
        select: { email: true },
      });

      const existing = await sumsubProvider.getApplicantByExternalId(userId).catch(() => null);
      if (existing?.id) {
        applicantId = existing.id;
      } else {
        const created = await sumsubProvider.createApplicant(userId, user?.email ?? undefined);
        applicantId = created.id;
      }

      // Persist the applicant ID
      await db.kycCase.update({
        where: { id: kase.id },
        data:  { sumsubApplicantId: applicantId },
      });
    }

    if (!applicantId) throw new Error("SUMSUB_APPLICANT_NOT_CREATED");

    const token = await sumsubProvider.generateAccessToken(userId);
    return { token, applicantId };
  }

  /**
   * Process an incoming Sumsub webhook event.
   * Called by POST /api/v1/kyc/sumsub/webhook.
   *
   * Sumsub sends applicantReviewed when a decision is made:
   *   reviewAnswer: GREEN → APPROVED
   *   reviewAnswer: RED   → REJECTED (with reject labels)
   */
  async processSumsubWebhook(rawBody: string, digestHeader: string): Promise<void> {
    // 1. Verify HMAC signature
    const valid = sumsubProvider.verifyWebhookSignature(rawBody, digestHeader);
    if (!valid) {
      throw new Error("WEBHOOK_SIGNATURE_INVALID");
    }

    const event = JSON.parse(rawBody) as SumsubWebhookPayload;
    const { applicantId, externalUserId, type, reviewResult, inspectionId } = event;

    // We only act on review decisions
    if (type !== "applicantReviewed" && type !== "applicantPending" && type !== "applicantOnHold") {
      return;
    }

    if (!IS_PERSISTENT) return;
    const db = prisma as NonNullable<typeof prisma>;

    // Find the KYC case by Sumsub applicant ID (or externalUserId = our userId)
    const kase = await db.kycCase.findFirst({
      where: applicantId
        ? { sumsubApplicantId: applicantId }
        : { userId: externalUserId ?? "" },
      select: { id: true, userId: true },
    });

    if (!kase) {
      console.warn(`[sumsub-webhook] No KYC case for applicantId=${applicantId}`);
      return;
    }

    const reviewAnswer = reviewResult?.reviewAnswer;
    const newStatus    = sumsubProvider.mapReviewToStatus(reviewAnswer, event.reviewStatus);
    const rejectLabels = reviewResult?.rejectLabels?.join(", ") ?? undefined;
    const clientComment = reviewResult?.clientComment ?? reviewResult?.moderationComment ?? undefined;

    await db.$transaction(async (tx) => {
      await tx.kycCase.update({
        where: { id: kase.id },
        data: {
          status:              newStatus,
          sumsubReviewStatus:  event.reviewStatus ?? null,
          sumsubReviewAnswer:  reviewAnswer ?? null,
          sumsubInspectionId:  inspectionId ?? null,
          sumsubWebhookData:   event as object,
          reviewedBy:          "sumsub",
          reviewNotes:         rejectLabels ?? clientComment ?? null,
          reviewedAt:          reviewAnswer ? new Date() : undefined,
          completedAt:         (reviewAnswer === "GREEN" || reviewAnswer === "RED") ? new Date() : undefined,
        },
      });

      if (reviewAnswer === "GREEN") {
        await tx.user.update({
          where: { id: kase.userId },
          data:  { kycStatus: "approved" },
        });
      } else if (reviewAnswer === "RED") {
        await tx.user.update({
          where: { id: kase.userId },
          data:  { kycStatus: "rejected" },
        });
      }

      await tx.auditLog.create({
        data: {
          id:      randomUUID(),
          actor:   "sumsub",
          action:  `kyc.sumsub.${type}`,
          entity:  kase.id,
          payload: {
            applicantId, externalUserId, type,
            reviewAnswer, reviewStatus: event.reviewStatus,
            rejectLabels: reviewResult?.rejectLabels,
          } as object,
        },
      });
    }, { maxWait: 10000, timeout: 15000 });

    // Emit domain events
    if (reviewAnswer === "GREEN") {
      eventBus.emit("kyc.approved", {
        userId: kase.userId, caseId: kase.id, adminId: "sumsub",
        timestamp: new Date().toISOString(),
      });
    } else if (reviewAnswer === "RED") {
      eventBus.emit("kyc.rejected", {
        userId: kase.userId, caseId: kase.id,
        reason: rejectLabels ?? "Rejected by Sumsub automated review",
        actorId: "sumsub", timestamp: new Date().toISOString(),
      });
    }

    console.log(`[sumsub-webhook] Processed ${type} for userId=${kase.userId} → status=${newStatus}`);
  }

  private async _audit(actor: string, action: string, entity: string, payload: object): Promise<void> {
    if (!IS_PERSISTENT) return;
    await prisma.auditLog.create({
      data: { id: randomUUID(), actor, action, entity, payload: payload as object },
    });
  }

  private _toSummary(row: {
    id: string; userId: string; status: string; riskScore: number; verificationScore: number;
    createdAt: Date; updatedAt: Date;
    steps: unknown[]; documents: unknown[];
  }): KycCaseSummary {
    return {
      id:                row.id,
      userId:            row.userId,
      status:            row.status as KycCaseStatus,
      riskScore:         row.riskScore,
      verificationScore: row.verificationScore,
      flags:             [],
      documents:         (row.documents as Record<string, unknown>[]).map((d) => ({
        id:              String(d.id),
        documentKey:     String(d.documentKey),
        label:           String(d.label),
        status:          String(d.status),
        fileName:        d.fileName ? String(d.fileName) : undefined,
        extractedData:   d.extractedData,
        livenessScore:   d.livenessScore ? Number(d.livenessScore) : undefined,
        rejectionReason: d.rejectionReason ? String(d.rejectionReason) : undefined,
        createdAt:       d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt),
      })),
      steps: (row.steps as Record<string, unknown>[]).map((s) => ({
        id:         String(s.id),
        stepType:   String(s.stepType),
        status:     String(s.status),
        provider:   s.provider ? String(s.provider) : undefined,
        confidence: s.confidence ? Number(s.confidence) : undefined,
        createdAt:  s.createdAt instanceof Date ? s.createdAt.toISOString() : String(s.createdAt),
      })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export const kycService = new KycService();
