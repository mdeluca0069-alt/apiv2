/**
 * migration/domains/ledger.ts — LedgerEntry. apiv2's composite primary key
 * `(id, createdAt)` (Task-14 monthly partitioning, see schema.prisma's own
 * comment on the model) is why every find/update here keys on BOTH fields,
 * not `id` alone -- PRODUCTION_CUTOVER_REPORT.md §1.5 flagged this as the
 * one real structural difference from v1's schema that this ETL must
 * account for explicitly.
 *
 * DISCOVERED DURING LIVE TESTING (not caught by the schema-diff audit,
 * which only compares column shapes, not CHECK constraint contents):
 * apiv2's LedgerEntry.type has a Postgres CHECK constraint restricting it
 * to a fixed value set. Cross-referencing v1's actual `type:` literals
 * (grepped across every ledgerEntry.create() call site in igfxpro-api/src)
 * against that constraint found ONE incompatible value: v1's
 * `position-closer.ts` writes `"TRADE_PNL"` for realized P&L on position
 * close, which apiv2's constraint does not allow. Every other v1 type
 * value in real use (DEPOSIT_REQUEST, WITHDRAW_REQUEST, MARGIN_LOCK,
 * MARGIN_RELEASE, ADJUSTMENT, ADMIN_CAPITAL_ALLOCATION) is already valid
 * as-is. Mapped to apiv2's own `"PNL_SETTLEMENT"` -- the constant
 * settlement.engine.ts itself uses for "net P&L from SettlementEngine
 * (may be +/-)" (reconciliation.engine.ts's own comment on the same
 * constant), the exact semantic match for v1's realized-P&L entries.
 */
import type { DomainMigrator, MigrationClients, ValidationIssue } from "../types.js";
import { upsertWithDiff } from "../upsert.helper.js";

/** apiv2's real CHECK constraint (LedgerEntry_type_check), confirmed live against a running instance. */
const TARGET_ALLOWED_TYPES = new Set([
  "DEPOSIT_REQUEST", "DEPOSIT_CREDIT", "WITHDRAW_REQUEST", "ADMIN_CAPITAL_ALLOCATION",
  "MARGIN_RESERVED", "MARGIN_RELEASED", "MARGIN_LOCK", "MARGIN_RELEASE",
  "PNL_CREDIT", "PNL_DEBIT", "PNL_SETTLEMENT", "COMMISSION", "SWAP", "ADJUSTMENT", "FEE", "DOCUMENT_EVENT",
]);

/** v1 type value -> apiv2 type value, for the one confirmed incompatibility. Identity for everything else. */
function mapLedgerType(v1Type: string): string {
  if (v1Type === "TRADE_PNL") return "PNL_SETTLEMENT";
  return v1Type;
}

export type SourceLedgerEntry = {
  id:             string;
  userId:         string;
  currency:       string;
  amount:         string;
  type:           string;
  reference:      string;
  status:         string;
  note:           string;
  runningBalance: string | null;
  debitAccount:   string | null;
  creditAccount:  string | null;
  createdAt:      Date;
};

export type TargetLedgerEntry = SourceLedgerEntry;

export const ledgerMigrator: DomainMigrator<SourceLedgerEntry, TargetLedgerEntry> = {
  name: "ledger",

  countSql: `SELECT count(*)::int AS count FROM "LedgerEntry"`,

  extractSql: (offset, limit) => `
    SELECT id, "userId", currency, amount::text, type, reference, status, note,
           "runningBalance"::text, "debitAccount", "creditAccount", "createdAt"
    FROM "LedgerEntry"
    ORDER BY "createdAt" ASC, id ASC
    OFFSET ${offset} LIMIT ${limit}
  `,

  transform: (row) => ({ ...row, type: mapLedgerType(row.type) }),

  validate: async (row, { target }): Promise<ValidationIssue[]> => {
    const issues: ValidationIssue[] = [];
    const user = await target.user.findUnique({ where: { id: row.userId } });
    if (!user) {
      issues.push({
        domain: "ledger", sourceId: row.id, severity: "ERROR",
        message: `userId "${row.userId}" not found in target -- Users must be migrated before Ledger.`,
      });
    }
    if (!TARGET_ALLOWED_TYPES.has(row.type)) {
      issues.push({
        domain: "ledger", sourceId: row.id, severity: "ERROR",
        message: `type "${row.type}" is not in apiv2's LedgerEntry_type_check allowed set even after mapLedgerType() -- a v1 type value this ETL doesn't yet know how to map. Add it to mapLedgerType() in migration/domains/ledger.ts after confirming the correct apiv2 equivalent.`,
      });
    }
    return issues;
  },

  upsert: async (row, { target }: MigrationClients) => {
    // Composite key -- @@id([id, createdAt]) -- so every find/update below
    // must supply both, using Prisma's compound-key input name
    // `id_createdAt` (Prisma's generated name: <field1>_<field2>, in
    // declaration order from the @@id([...]) attribute).
    const compoundWhere = { id_createdAt: { id: row.id, createdAt: row.createdAt } };
    const result = await upsertWithDiff(
      () => target.ledgerEntry.findUnique({ where: compoundWhere }),
      () => target.ledgerEntry.create({ data: row }),
      () => target.ledgerEntry.update({ where: compoundWhere, data: row }),
      row,
    );
    return { pk: { id: row.id, createdAt: row.createdAt.toISOString() }, ...result };
  },
};
