/**
 * migration/domains/users.ts — User is the dependency root: every other
 * domain's userId FK must resolve against an already-migrated User row, so
 * this always runs first (see DOMAIN_ORDER in migration/domains/index.ts).
 *
 * Password hashes are copied verbatim (still bcrypt, v1's format) -- NOT
 * re-hashed during migration. auth-service/password.hasher.ts's bcrypt
 * compatibility branch (PRODUCTION_CUTOVER_REPORT.md Stage 1) means a
 * migrated user logs in once with their original password and is silently
 * upgraded to Argon2id by the existing lazy-rehash path in
 * auth.service.ts's login() -- migrating the hash as-is is what makes that
 * possible; re-hashing here would require the user's plaintext password,
 * which this ETL never has access to.
 */
import type { DomainMigrator, MigrationClients, ValidationIssue } from "../types.js";
import { upsertWithDiff } from "../upsert.helper.js";

export type SourceUser = {
  id:          string;
  email:       string;
  password:    string;
  fullName:    string;
  role:        string;
  roles:       unknown;   // jsonb
  permissions: unknown;   // jsonb
  tier:        string;
  kycStatus:   string;
  tenantId:    string;
  createdAt:   Date;
};

export type TargetUser = SourceUser;

export const usersMigrator: DomainMigrator<SourceUser, TargetUser> = {
  name: "users",

  countSql: `SELECT count(*)::int AS count FROM "User"`,

  extractSql: (offset, limit) => `
    SELECT id, email, password, "fullName", role, roles, permissions, tier, "kycStatus", "tenantId", "createdAt"
    FROM "User"
    ORDER BY "createdAt" ASC, id ASC
    OFFSET ${offset} LIMIT ${limit}
  `,

  transform: (row) => ({
    id:          row.id,
    email:       row.email.toLowerCase().trim(),
    password:    row.password,
    fullName:    row.fullName,
    role:        row.role,
    roles:       row.roles,
    permissions: row.permissions,
    tier:        row.tier,
    kycStatus:   row.kycStatus,
    tenantId:    row.tenantId,
    createdAt:   row.createdAt,
  }),

  validate: async (row, { target }): Promise<ValidationIssue[]> => {
    const issues: ValidationIssue[] = [];

    const tenant = await target.tenant.findUnique({ where: { id: row.tenantId } });
    if (!tenant) {
      issues.push({
        domain: "users", sourceId: row.id, severity: "ERROR",
        message: `tenantId "${row.tenantId}" does not exist in target -- migrate Tenant rows first (out of the mission's 10 named domains; apiv2 ships a single default tenant today, see ETL_MIGRATION_GUIDE.md).`,
      });
    }

    const emailConflict = await target.user.findUnique({ where: { email: row.email } });
    if (emailConflict && emailConflict.id !== row.id) {
      issues.push({
        domain: "users", sourceId: row.id, severity: "ERROR",
        message: `email "${row.email}" already exists in target under a DIFFERENT id ("${emailConflict.id}") -- would violate the unique constraint. Resolve manually before running apply mode for this row.`,
      });
    }

    return issues;
  },

  upsert: async (row, { target }: MigrationClients) => {
    // roles/permissions are `unknown` (raw jsonb) vs Prisma's InputJsonValue -- see orders.ts's identical note.
    const result = await upsertWithDiff(
      () => target.user.findUnique({ where: { id: row.id } }),
      () => target.user.create({ data: row as never }),
      () => target.user.update({ where: { id: row.id }, data: row as never }),
      row as Record<string, unknown>,
    );
    return { pk: { id: row.id }, ...result };
  },
};
