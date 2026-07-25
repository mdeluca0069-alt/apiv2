/**
 * migration/domains/wallets.ts — WalletAccount, one row per user (unique
 * on userId). Keyed on userId rather than id: id is an opaque generated
 * uuid on both sides with nothing else referencing it by FK, while userId
 * is the actual identity that matters and is already unique in both schemas.
 */
import type { DomainMigrator, MigrationClients, ValidationIssue } from "../types.js";
import { upsertWithDiff } from "../upsert.helper.js";

export type SourceWallet = {
  id:        string;
  userId:    string;
  currency:  string;
  balance:   string; // numeric comes back as string from `pg` by default -- Prisma's Decimal accepts a numeric string directly
  equity:    string;
  locked:    string;
  createdAt: Date;
};

export type TargetWallet = SourceWallet;

export const walletsMigrator: DomainMigrator<SourceWallet, TargetWallet> = {
  name: "wallets",

  countSql: `SELECT count(*)::int AS count FROM "WalletAccount"`,

  extractSql: (offset, limit) => `
    SELECT id, "userId", currency, balance::text, equity::text, locked::text, "createdAt"
    FROM "WalletAccount"
    ORDER BY "createdAt" ASC, id ASC
    OFFSET ${offset} LIMIT ${limit}
  `,

  transform: (row) => ({
    id: row.id, userId: row.userId, currency: row.currency,
    balance: row.balance, equity: row.equity, locked: row.locked,
    createdAt: row.createdAt,
  }),

  validate: async (row, { target }): Promise<ValidationIssue[]> => {
    const issues: ValidationIssue[] = [];
    const user = await target.user.findUnique({ where: { id: row.userId } });
    if (!user) {
      issues.push({
        domain: "wallets", sourceId: row.id, severity: "ERROR",
        message: `userId "${row.userId}" not found in target -- Users must be migrated before Wallets (see DOMAIN_ORDER).`,
      });
    }
    const balance = Number(row.balance);
    if (Number.isFinite(balance) && balance < 0) {
      issues.push({
        domain: "wallets", sourceId: row.id, severity: "WARNING",
        message: `negative balance (${row.balance}) copied from source as-is -- apiv2's own invariants.sql flags negative balances; investigate the source row before/after migrating rather than silently accepting it.`,
      });
    }
    return issues;
  },

  upsert: async (row, { target }: MigrationClients) => {
    const result = await upsertWithDiff(
      () => target.walletAccount.findUnique({ where: { userId: row.userId } }),
      () => target.walletAccount.create({ data: row }),
      () => target.walletAccount.update({ where: { userId: row.userId }, data: row }),
      row,
    );
    return { pk: { userId: row.userId }, ...result };
  },
};
