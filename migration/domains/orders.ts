/**
 * migration/domains/orders.ts — Order. FKs to both User (userId) and
 * Instrument (symbol) -- validate() checks both, since apiv2's Instrument
 * catalog (119 instruments per project memory) may not perfectly cover
 * every symbol v1 ever traded, especially older/delisted ones.
 */
import type { DomainMigrator, MigrationClients, ValidationIssue } from "../types.js";
import { upsertWithDiff } from "../upsert.helper.js";

export type SourceOrder = {
  id:               string;
  clientOrderId:    string | null;
  userId:           string;
  symbol:           string;
  side:             string;
  type:             string;
  status:           string;
  quantity:         string;
  filledQuantity:   string;
  requestedPrice:   string | null;
  averageFillPrice: string | null;
  notional:         string;
  marginRequired:   string;
  leverage:         number;
  stopLoss:         string | null;
  takeProfit:       string | null;
  slippage:         string;
  fees:             string;
  riskCheckResult:  unknown;
  rejectionReason:  string | null;
  filledAt:         Date | null;
  createdAt:        Date;
};

export type TargetOrder = SourceOrder;

export const ordersMigrator: DomainMigrator<SourceOrder, TargetOrder> = {
  name: "orders",

  countSql: `SELECT count(*)::int AS count FROM "Order"`,

  extractSql: (offset, limit) => `
    SELECT id, "clientOrderId", "userId", symbol, side, type, status,
           quantity::text, "filledQuantity"::text, "requestedPrice"::text, "averageFillPrice"::text,
           notional::text, "marginRequired"::text, leverage, "stopLoss"::text, "takeProfit"::text,
           slippage::text, fees::text, "riskCheckResult", "rejectionReason", "filledAt", "createdAt"
    FROM "Order"
    ORDER BY "createdAt" ASC, id ASC
    OFFSET ${offset} LIMIT ${limit}
  `,

  transform: (row) => ({ ...row }),

  validate: async (row, { target }): Promise<ValidationIssue[]> => {
    const issues: ValidationIssue[] = [];
    const [user, instrument] = await Promise.all([
      target.user.findUnique({ where: { id: row.userId } }),
      target.instrument.findUnique({ where: { symbol: row.symbol } }),
    ]);
    if (!user) {
      issues.push({ domain: "orders", sourceId: row.id, severity: "ERROR",
        message: `userId "${row.userId}" not found in target -- Users must be migrated before Orders.` });
    }
    if (!instrument) {
      issues.push({ domain: "orders", sourceId: row.id, severity: "ERROR",
        message: `symbol "${row.symbol}" not found in target's Instrument catalog -- either add it (a delisted/legacy instrument) or exclude this row from the run.` });
    }
    return issues;
  },

  upsert: async (row, { target }: MigrationClients) => {
    // riskCheckResult is `unknown` here (raw jsonb from `pg`) vs Prisma's
    // generated InputJsonValue -- cast at the one point it actually
    // matters (the Prisma call), same pattern as audit.ts's payload field.
    const result = await upsertWithDiff(
      () => target.order.findUnique({ where: { id: row.id } }),
      () => target.order.create({ data: row as never }),
      () => target.order.update({ where: { id: row.id }, data: row as never }),
      row as Record<string, unknown>,
    );
    return { pk: { id: row.id }, ...result };
  },
};
