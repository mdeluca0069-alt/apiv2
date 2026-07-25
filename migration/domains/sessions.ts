/**
 * migration/domains/sessions.ts — Session (refresh tokens). PK is the
 * opaque `refreshToken` string itself, not a separate `id` column, on both
 * schemas.
 *
 * Only NOT-YET-EXPIRED sessions are extracted (see extractSql's WHERE
 * clause) -- an expired session is worthless to migrate and copying it
 * just adds noise to the target table. RECOMMENDATION (see
 * ETL_MIGRATION_GUIDE.md): consider skipping this domain entirely for the
 * real cutover. It is implemented here because the migration mission
 * named it explicitly, but a user's session naturally re-establishes on
 * their next login against apiv2 regardless -- migrating live sessions
 * only saves already-logged-in users from one extra login prompt at the
 * exact moment of cutover, at the cost of carrying live bearer credentials
 * through the ETL pipeline. A reasonable, defensible choice either way;
 * this tool supports both (skip via --domains= that excludes "sessions").
 */
import type { DomainMigrator, MigrationClients, ValidationIssue } from "../types.js";
import { upsertWithDiff } from "../upsert.helper.js";

export type SourceSession = {
  refreshToken: string;
  userId:       string;
  createdAt:    Date;
  expiresAt:    Date;
};

export type TargetSession = SourceSession;

export const sessionsMigrator: DomainMigrator<SourceSession, TargetSession> = {
  name: "sessions",

  countSql: `SELECT count(*)::int AS count FROM "Session" WHERE "expiresAt" > now()`,

  extractSql: (offset, limit) => `
    SELECT "refreshToken", "userId", "createdAt", "expiresAt"
    FROM "Session"
    WHERE "expiresAt" > now()
    ORDER BY "createdAt" ASC, "refreshToken" ASC
    OFFSET ${offset} LIMIT ${limit}
  `,

  transform: (row) => ({ ...row }),

  validate: async (row, { target }): Promise<ValidationIssue[]> => {
    const issues: ValidationIssue[] = [];
    const user = await target.user.findUnique({ where: { id: row.userId } });
    if (!user) issues.push({ domain: "sessions", sourceId: row.refreshToken.slice(0, 8) + "...", severity: "ERROR",
      message: `userId "${row.userId}" not found in target -- Users must be migrated before Sessions.` });
    return issues;
  },

  upsert: async (row, { target }: MigrationClients) => {
    const result = await upsertWithDiff(
      () => target.session.findUnique({ where: { refreshToken: row.refreshToken } }),
      () => target.session.create({ data: row }),
      () => target.session.update({ where: { refreshToken: row.refreshToken }, data: row }),
      row,
    );
    return { pk: { refreshToken: row.refreshToken.slice(0, 8) + "..." }, ...result };
  },
};
