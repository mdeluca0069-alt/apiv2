/**
 * migration/domains/index.ts — the 10 domains named in the migration
 * mission, in strict FK-dependency order. The ETL runner always processes
 * them in this order regardless of any --domains= filter's own ordering,
 * so a partial/filtered run can never accidentally violate a foreign key
 * (e.g. running "positions" without "orders" first).
 */
import type { DomainMigrator } from "../types.js";
import { usersMigrator } from "./users.js";
import { walletsMigrator } from "./wallets.js";
import { kycMigrator } from "./kyc.js";
import { settingsMigrator } from "./settings.js";
import { sessionsMigrator } from "./sessions.js";
import { ledgerMigrator } from "./ledger.js";
import { ordersMigrator } from "./orders.js";
import { positionsMigrator } from "./positions.js";
import { tradesMigrator } from "./trades.js";
import { auditMigrator } from "./audit.js";

// DomainMigrator's own generics default to Record<string, unknown> -- every
// individual migrator above is typed against its own concrete Source/Target
// shape (SourceUser/TargetUser, etc.) for safety within its own file, but
// the runner (etl.runner.ts) only ever needs the untyped default shape, so
// this array is intentionally typed against that default rather than a
// union of all 10 concrete shapes.
export const DOMAIN_ORDER: DomainMigrator[] = [
  usersMigrator,
  walletsMigrator,
  kycMigrator,
  settingsMigrator,
  sessionsMigrator,
  ledgerMigrator,
  ordersMigrator,
  positionsMigrator,
  tradesMigrator,
  auditMigrator,
] as unknown as DomainMigrator[];

export {
  usersMigrator, walletsMigrator, kycMigrator, settingsMigrator, sessionsMigrator,
  ledgerMigrator, ordersMigrator, positionsMigrator, tradesMigrator, auditMigrator,
};
