/**
 * migration/domains/kyc.ts — KycCase, one row per user (unique on userId,
 * same pattern as wallets.ts). apiv2-only Sumsub fields
 * (sumsubApplicantId/etc.) are simply never set by a migrated row -- v1
 * has no Sumsub integration (PRODUCTION_CUTOVER_REPORT.md §1.7), so there
 * is nothing to carry over; they stay null until a real Sumsub
 * verification happens post-cutover.
 */
import type { DomainMigrator, MigrationClients, ValidationIssue } from "../types.js";
import { upsertWithDiff } from "../upsert.helper.js";

export type SourceKycCase = {
  id:                string;
  userId:            string;
  status:            string;
  riskScore:         number;
  verificationScore: number;
  reviewNotes:       string | null;
  reviewedBy:        string | null;
  reviewedAt:        Date | null;
  completedAt:       Date | null;
  createdAt:         Date;
  updatedAt:         Date;
};

export type TargetKycCase = SourceKycCase;

export const kycMigrator: DomainMigrator<SourceKycCase, TargetKycCase> = {
  name: "kyc",

  countSql: `SELECT count(*)::int AS count FROM "KycCase"`,

  extractSql: (offset, limit) => `
    SELECT id, "userId", status, "riskScore", "verificationScore", "reviewNotes",
           "reviewedBy", "reviewedAt", "completedAt", "createdAt", "updatedAt"
    FROM "KycCase"
    ORDER BY "createdAt" ASC, id ASC
    OFFSET ${offset} LIMIT ${limit}
  `,

  transform: (row) => ({ ...row }),

  validate: async (row, { target }): Promise<ValidationIssue[]> => {
    const issues: ValidationIssue[] = [];
    const user = await target.user.findUnique({ where: { id: row.userId } });
    if (!user) issues.push({ domain: "kyc", sourceId: row.id, severity: "ERROR",
      message: `userId "${row.userId}" not found in target -- Users must be migrated before KYC.` });
    return issues;
  },

  upsert: async (row, { target }: MigrationClients) => {
    const result = await upsertWithDiff(
      () => target.kycCase.findUnique({ where: { userId: row.userId } }),
      () => target.kycCase.create({ data: row }),
      () => target.kycCase.update({ where: { userId: row.userId }, data: row }),
      row,
    );
    return { pk: { userId: row.userId }, ...result };
  },
};
