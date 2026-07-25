/**
 * migration/domains/positions.ts — Position. FKs to User, Order, and
 * Instrument -- must run after both users and orders in DOMAIN_ORDER.
 */
import type { DomainMigrator, MigrationClients, ValidationIssue } from "../types.js";
import { upsertWithDiff } from "../upsert.helper.js";

export type SourcePosition = {
  id:                string;
  userId:            string;
  orderId:           string;
  symbol:            string;
  side:              string;
  quantity:          string;
  entryPrice:        string;
  markPrice:         string;
  pnl:               string;
  pnlPercent:        string;
  marginUsed:        string;
  leverage:          number;
  stopLoss:          string | null;
  takeProfit:        string | null;
  exitPrice:         string | null;
  status:            string;
  openedAt:          Date;
  closedAt:          Date | null;
  openedByAutopilot: boolean;
  initialStopLoss:   string | null;
  breakEvenApplied:  boolean;
  trailingActive:    boolean;
};

export type TargetPosition = SourcePosition;

export const positionsMigrator: DomainMigrator<SourcePosition, TargetPosition> = {
  name: "positions",

  countSql: `SELECT count(*)::int AS count FROM "Position"`,

  extractSql: (offset, limit) => `
    SELECT id, "userId", "orderId", symbol, side, quantity::text, "entryPrice"::text,
           "markPrice"::text, pnl::text, "pnlPercent"::text, "marginUsed"::text, leverage,
           "stopLoss"::text, "takeProfit"::text, "exitPrice"::text, status, "openedAt", "closedAt",
           "openedByAutopilot", "initialStopLoss"::text, "breakEvenApplied", "trailingActive"
    FROM "Position"
    ORDER BY "openedAt" ASC, id ASC
    OFFSET ${offset} LIMIT ${limit}
  `,

  transform: (row) => ({ ...row }),

  validate: async (row, { target }): Promise<ValidationIssue[]> => {
    const issues: ValidationIssue[] = [];
    const [user, order, instrument] = await Promise.all([
      target.user.findUnique({ where: { id: row.userId } }),
      target.order.findUnique({ where: { id: row.orderId } }),
      target.instrument.findUnique({ where: { symbol: row.symbol } }),
    ]);
    if (!user) issues.push({ domain: "positions", sourceId: row.id, severity: "ERROR",
      message: `userId "${row.userId}" not found in target.` });
    if (!order) issues.push({ domain: "positions", sourceId: row.id, severity: "ERROR",
      message: `orderId "${row.orderId}" not found in target -- Orders must be migrated before Positions.` });
    if (!instrument) issues.push({ domain: "positions", sourceId: row.id, severity: "ERROR",
      message: `symbol "${row.symbol}" not found in target's Instrument catalog.` });
    return issues;
  },

  upsert: async (row, { target }: MigrationClients) => {
    const result = await upsertWithDiff(
      () => target.position.findUnique({ where: { id: row.id } }),
      () => target.position.create({ data: row }),
      () => target.position.update({ where: { id: row.id }, data: row }),
      row,
    );
    return { pk: { id: row.id }, ...result };
  },
};
