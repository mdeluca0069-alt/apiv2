/**
 * migration/domains/settings.ts — NotificationPreference, the closest
 * literal match to "Settings" among the shared per-user preference tables
 * (Watchlist/AutopilotConfig are the others -- not migrated here, but
 * follow the exact same one-row-per-user pattern if a future run needs
 * them; adding a domain is a single new file plus one line in
 * domains/index.ts, see ETL_MIGRATION_GUIDE.md).
 */
import type { DomainMigrator, MigrationClients, ValidationIssue } from "../types.js";
import { upsertWithDiff } from "../upsert.helper.js";

export type SourceNotificationPreference = {
  id:           string;
  userId:       string;
  emailEnabled: boolean;
  smsEnabled:   boolean;
  pushEnabled:  boolean;
  inAppEnabled: boolean;
  categories:   unknown; // jsonb
  updatedAt:    Date;
  createdAt:    Date;
};

export type TargetNotificationPreference = SourceNotificationPreference;

export const settingsMigrator: DomainMigrator<SourceNotificationPreference, TargetNotificationPreference> = {
  name: "settings",

  countSql: `SELECT count(*)::int AS count FROM "NotificationPreference"`,

  extractSql: (offset, limit) => `
    SELECT id, "userId", "emailEnabled", "smsEnabled", "pushEnabled", "inAppEnabled",
           categories, "updatedAt", "createdAt"
    FROM "NotificationPreference"
    ORDER BY "createdAt" ASC, id ASC
    OFFSET ${offset} LIMIT ${limit}
  `,

  transform: (row) => ({ ...row }),

  validate: async (row, { target }): Promise<ValidationIssue[]> => {
    const issues: ValidationIssue[] = [];
    const user = await target.user.findUnique({ where: { id: row.userId } });
    if (!user) issues.push({ domain: "settings", sourceId: row.id, severity: "ERROR",
      message: `userId "${row.userId}" not found in target -- Users must be migrated before Settings.` });
    return issues;
  },

  upsert: async (row, { target }: MigrationClients) => {
    // categories is `unknown` (raw jsonb) vs Prisma's InputJsonValue -- see orders.ts's identical note.
    const result = await upsertWithDiff(
      () => target.notificationPreference.findUnique({ where: { userId: row.userId } }),
      () => target.notificationPreference.create({ data: row as never }),
      () => target.notificationPreference.update({ where: { userId: row.userId }, data: row as never }),
      row as Record<string, unknown>,
    );
    return { pk: { userId: row.userId }, ...result };
  },
};
