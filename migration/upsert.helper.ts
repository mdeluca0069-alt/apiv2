/**
 * migration/upsert.helper.ts — shared idempotent-upsert-with-diff logic
 * every domain migrator's `upsert()` delegates to.
 *
 * "Idempotent execution" (a Stage 2 requirement) means more than "create if
 * missing, overwrite if present" -- re-running the exact same extraction
 * twice with no source changes must report the second run as a true no-op
 * (UNCHANGED, zero writes), not silently re-issue an identical UPDATE every
 * time. This does a shallow field comparison before writing so the
 * migration's own statistics/rollback manifest accurately reflect what
 * actually changed, and so a second run against an unmodified source is
 * cheap (a read, not a write) rather than hammering the target DB.
 */

export type UpsertOutcome = {
  outcome: "CREATED" | "UPDATED" | "UNCHANGED";
  previous?: Record<string, unknown>;
};

/**
 * Compares only the keys present in `next` (the fields this migration
 * actually cares about) -- `existing` may carry additional target-only
 * columns (e.g. apiv2-only idempotency fields on Notification/OutboxEvent,
 * see PRODUCTION_CUTOVER_REPORT.md §1.5) that a v1-sourced row never sets
 * and must never be flagged as "changed" just because v1 doesn't know
 * about them.
 */
export function diffFields(
  existing: Record<string, unknown> | null,
  next: Record<string, unknown>,
): { changed: boolean; previous: Record<string, unknown> } {
  if (!existing) return { changed: true, previous: {} };

  const previous: Record<string, unknown> = {};
  let changed = false;

  for (const key of Object.keys(next)) {
    const a = normalize(existing[key]);
    const b = normalize(next[key]);
    if (a !== b) {
      changed = true;
      previous[key] = existing[key];
    }
  }

  return { changed, previous };
}

/**
 * DISCOVERED DURING LIVE TESTING: Prisma's Decimal (decimal.js under the
 * hood) does NOT preserve trailing zeros in `.toString()` -- a column
 * value Postgres reports as "15000.50000000" (via `numeric::text`, which
 * this ETL's extractSql queries use to avoid floating-point round-tripping
 * through `pg`) comes back from Prisma's own `findUnique()` as
 * Decimal("15000.5"). A naive string comparison flagged every single
 * financial field as "changed" on every re-run, defeating the whole point
 * of the idempotency check -- re-running the ETL against unchanged source
 * data re-wrote every Decimal-bearing row every time instead of reporting
 * it UNCHANGED. Fixed by numerically normalizing anything that parses as a
 * finite number (via a fixed, generous decimal precision) before falling
 * back to string comparison for genuinely non-numeric values (ids, enums,
 * free text).
 */
function normalize(value: unknown): string {
  if (value === null || value === undefined) return " null";
  if (value instanceof Date) return value.toISOString();

  // Prisma Decimal / numeric-like objects with their own toString()
  if (typeof value === "object" && "toString" in value && typeof (value as { toString(): string }).toString === "function"
      && value.constructor?.name !== "Object" && value.constructor?.name !== "Array") {
    return normalizeNumericIfPossible((value as { toString(): string }).toString());
  }
  if (typeof value === "string") return normalizeNumericIfPossible(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function normalizeNumericIfPossible(s: string): string {
  // Only treat it as numeric if the ENTIRE string is a valid number --
  // otherwise a numeric-looking-prefix id/reference (rare, but real: e.g.
  // reference columns sometimes embed a leading amount) could be silently
  // truncated by Number()'s lenient parsing.
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n.toFixed(10);
  }
  return s;
}

/**
 * Generic idempotent upsert: find -> diff -> create/update/skip.
 * `find`/`create`/`update` are the three Prisma delegate calls the caller
 * already knows how to make (kept as plain functions rather than a single
 * generic Prisma-typed helper -- each model's `where` shape differs enough,
 * notably LedgerEntry/TradeAudit's composite (id, createdAt) key, that a
 * fully generic version would need unsafe casts anyway; this way every
 * domain file keeps its own Prisma call fully typed, and only the
 * find-diff-create/update CONTROL FLOW is shared).
 */
export async function upsertWithDiff(
  find:   () => Promise<Record<string, unknown> | null>,
  create: () => Promise<Record<string, unknown>>,
  update: (previous: Record<string, unknown>) => Promise<Record<string, unknown>>,
  next:   Record<string, unknown>,
): Promise<UpsertOutcome> {
  const existing = await find();
  if (!existing) {
    await create();
    return { outcome: "CREATED" };
  }

  const { changed, previous } = diffFields(existing, next);
  if (!changed) {
    return { outcome: "UNCHANGED" };
  }

  await update(previous);
  return { outcome: "UPDATED", previous };
}
