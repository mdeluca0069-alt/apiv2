/**
 * migration/domains/audit.ts — AuditLog. Both schemas share the identical
 * shape (id, actor, action, entity, payload, createdAt) -- confirmed by
 * the Stage 1 audit's schema-diff pass, PRODUCTION_CUTOVER_REPORT.md §1.5.
 *
 * IMPORTANT, not a bug: migrated rows will NOT carry apiv2's hash-chain
 * metadata (`_chain_hash`/`_prev_hash`/`_severity`/`_written_at`/
 * `_hash_algo` inside `payload` -- see security/immutable.audit.ts, FASE 7
 * CLOSURE's work this same project went through). v1 never had a hash
 * chain at all, so there is nothing authentic to carry over -- these rows
 * simply fall outside `verifyChain()`'s verified window, identically to
 * how apiv2's own ~161K pre-existing legacy rows (written before its
 * hash-chain feature existed) are already treated: a real, permanent,
 * and correctly-labeled gap in the cryptographic chain's coverage, not
 * silently-wrong data.
 */
import type { DomainMigrator, MigrationClients, ValidationIssue } from "../types.js";
import { upsertWithDiff } from "../upsert.helper.js";

export type SourceAuditLog = {
  id:        string;
  actor:     string;
  action:    string;
  entity:    string;
  payload:   unknown; // jsonb
  createdAt: Date;
};

export type TargetAuditLog = SourceAuditLog;

export const auditMigrator: DomainMigrator<SourceAuditLog, TargetAuditLog> = {
  name: "audit",

  countSql: `SELECT count(*)::int AS count FROM "AuditLog"`,

  extractSql: (offset, limit) => `
    SELECT id, actor, action, entity, payload, "createdAt"
    FROM "AuditLog"
    ORDER BY "createdAt" ASC, id ASC
    OFFSET ${offset} LIMIT ${limit}
  `,

  transform: (row) => ({ ...row }),

  // No FK to check -- AuditLog.actor is a free-text label (often a
  // system/job name, not always a userId), by design on both schemas.
  validate: async (): Promise<ValidationIssue[]> => [],

  upsert: async (row, { target }: MigrationClients) => {
    const result = await upsertWithDiff(
      () => target.auditLog.findUnique({ where: { id: row.id } }),
      () => target.auditLog.create({ data: row as never }), // payload: unknown -> Prisma's InputJsonValue; see ETL_MIGRATION_GUIDE.md's note on Json fields
      () => target.auditLog.update({ where: { id: row.id }, data: row as never }),
      row as Record<string, unknown>,
    );
    return { pk: { id: row.id }, ...result };
  },
};
