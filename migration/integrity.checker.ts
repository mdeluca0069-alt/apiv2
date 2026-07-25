/**
 * migration/integrity.checker.ts — POST-migration verification: for every
 * row that exists in the SOURCE, confirm it landed in the TARGET (and, for
 * the two financial domains, that the source and target agree on the
 * aggregate sum over exactly those rows). Run this after every real
 * ("apply") migration, before treating it as trustworthy.
 *
 * DISCOVERED DURING LIVE TESTING: an earlier version of this checker did a
 * blind `SELECT count(*)` on both sides. That is only meaningful against a
 * freshly-provisioned, empty target -- against any target that already has
 * its own pre-existing data (every real apiv2 environment above a brand
 * new install, including this project's own dev database), a blind count
 * compares two unrelated numbers and reports a false failure. Fixed by
 * scoping every check to exactly the set of IDs the source actually
 * contains: fetch the source's id list, then ask the target "of these
 * specific IDs, how many/what sum exists" -- a claim about the migration's
 * own rows, independent of whatever else is in the target.
 */
import type { MigrationClients } from "./types.js";

export type IntegrityCheckResult = {
  domain:  string;
  check:   string;
  sourceValue: string;
  targetValue: string;
  match:   boolean;
};

export async function runIntegrityChecks(clients: MigrationClients): Promise<IntegrityCheckResult[]> {
  const results: IntegrityCheckResult[] = [];

  results.push(await scopedCountCheck(clients, "users", "User", "id",
    async (ids) => clients.target.user.count({ where: { id: { in: ids } } })));

  results.push(await scopedCountCheck(clients, "wallets", "WalletAccount", "id",
    async (ids) => clients.target.walletAccount.count({ where: { id: { in: ids } } })));

  results.push(await scopedCountCheck(clients, "kyc", "KycCase", "id",
    async (ids) => clients.target.kycCase.count({ where: { id: { in: ids } } })));

  results.push(await scopedCountCheck(clients, "settings", "NotificationPreference", "id",
    async (ids) => clients.target.notificationPreference.count({ where: { id: { in: ids } } })));

  results.push(await scopedCountCheck(clients, "sessions", "Session", "refreshToken",
    async (ids) => clients.target.session.count({ where: { refreshToken: { in: ids } } }),
    `WHERE "expiresAt" > now()`));

  results.push(await scopedCountCheck(clients, "ledger", "LedgerEntry", "id",
    async (ids) => clients.target.ledgerEntry.count({ where: { id: { in: ids } } })));

  results.push(await scopedCountCheck(clients, "orders", "Order", "id",
    async (ids) => clients.target.order.count({ where: { id: { in: ids } } })));

  results.push(await scopedCountCheck(clients, "positions", "Position", "id",
    async (ids) => clients.target.position.count({ where: { id: { in: ids } } })));

  results.push(await scopedCountCheck(clients, "trades", "Fill", "id",
    async (ids) => clients.target.fill.count({ where: { id: { in: ids } } })));

  results.push(await scopedCountCheck(clients, "audit", "AuditLog", "id",
    async (ids) => clients.target.auditLog.count({ where: { id: { in: ids } } })));

  // Financial cross-checks, scoped the same way: sum ONLY over the wallet/
  // ledger rows that came from the source, not the target's grand total.
  results.push(await scopedSumCheck(
    clients, "wallets", "sum(balance) [scoped to migrated rows]", "WalletAccount", "id", "balance",
    async (ids) => {
      const agg = await clients.target.walletAccount.aggregate({ _sum: { balance: true }, where: { id: { in: ids } } });
      return agg._sum.balance?.toString() ?? "0";
    },
  ));

  results.push(await scopedSumCheck(
    clients, "ledger", "sum(amount) [scoped to migrated rows]", "LedgerEntry", "id", "amount",
    async (ids) => {
      const agg = await clients.target.ledgerEntry.aggregate({ _sum: { amount: true }, where: { id: { in: ids } } });
      return agg._sum.amount?.toString() ?? "0";
    },
  ));

  return results;
}

async function fetchSourceIds(
  clients: MigrationClients, table: string, idColumn: string, extraWhere = "",
): Promise<string[]> {
  const { rows } = await clients.source.query<Record<string, string>>(
    `SELECT "${idColumn}" AS id FROM "${table}" ${extraWhere}`,
  );
  return rows.map((r) => r.id);
}

async function scopedCountCheck(
  clients: MigrationClients, domain: string, table: string, idColumn: string,
  targetCount: (ids: string[]) => Promise<number>, extraWhere = "",
): Promise<IntegrityCheckResult> {
  const ids = await fetchSourceIds(clients, table, idColumn, extraWhere);
  const targetValue = ids.length === 0 ? 0 : await targetCount(ids);
  return {
    domain, check: "row_count (scoped to source ids)",
    sourceValue: String(ids.length), targetValue: String(targetValue),
    match: ids.length === targetValue,
  };
}

async function scopedSumCheck(
  clients: MigrationClients, domain: string, check: string, table: string, idColumn: string, sumColumn: string,
  targetSum: (ids: string[]) => Promise<string>,
): Promise<IntegrityCheckResult> {
  const ids = await fetchSourceIds(clients, table, idColumn);
  if (ids.length === 0) {
    return { domain, check, sourceValue: "0.00000000", targetValue: "0.00000000", match: true };
  }
  const { rows } = await clients.source.query<{ s: string }>(
    `SELECT coalesce(sum("${sumColumn}"), 0)::text AS s FROM "${table}" WHERE id = ANY($1::text[])`,
    [ids],
  );
  const sourceValue = normalizeDecimal(rows[0]?.s ?? "0");
  const targetValue = normalizeDecimal(await targetSum(ids));
  return { domain, check, sourceValue, targetValue, match: sourceValue === targetValue };
}

/** Strips trailing zeros / normalizes representation so "100.00000000" === "100" compares equal. */
function normalizeDecimal(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(8) : value;
}
