/**
 * migration/domains/trades.ts — Fill (v1's individual trade executions
 * against an Order, called "Trades" in the migration mission's naming).
 * Depends on Order (always) and Position (when positionId is set).
 */
import type { DomainMigrator, MigrationClients, ValidationIssue } from "../types.js";
import { upsertWithDiff } from "../upsert.helper.js";

export type SourceFill = {
  id:                string;
  orderId:           string;
  positionId:        string | null;
  quantity:          string;
  price:             string;
  liquidityProvider: string;
  slippage:          string;
  fees:              string;
  createdAt:         Date;
};

export type TargetFill = SourceFill;

export const tradesMigrator: DomainMigrator<SourceFill, TargetFill> = {
  name: "trades",

  countSql: `SELECT count(*)::int AS count FROM "Fill"`,

  extractSql: (offset, limit) => `
    SELECT id, "orderId", "positionId", quantity::text, price::text,
           "liquidityProvider", slippage::text, fees::text, "createdAt"
    FROM "Fill"
    ORDER BY "createdAt" ASC, id ASC
    OFFSET ${offset} LIMIT ${limit}
  `,

  transform: (row) => ({ ...row }),

  validate: async (row, { target }): Promise<ValidationIssue[]> => {
    const issues: ValidationIssue[] = [];
    const order = await target.order.findUnique({ where: { id: row.orderId } });
    if (!order) issues.push({ domain: "trades", sourceId: row.id, severity: "ERROR",
      message: `orderId "${row.orderId}" not found in target -- Orders must be migrated before Trades.` });
    if (row.positionId) {
      const position = await target.position.findUnique({ where: { id: row.positionId } });
      if (!position) issues.push({ domain: "trades", sourceId: row.id, severity: "ERROR",
        message: `positionId "${row.positionId}" not found in target -- Positions must be migrated before Trades.` });
    }
    return issues;
  },

  upsert: async (row, { target }: MigrationClients) => {
    const result = await upsertWithDiff(
      () => target.fill.findUnique({ where: { id: row.id } }),
      () => target.fill.create({ data: row }),
      () => target.fill.update({ where: { id: row.id }, data: row }),
      row,
    );
    return { pk: { id: row.id }, ...result };
  },
};
