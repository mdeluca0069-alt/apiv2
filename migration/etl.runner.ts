/**
 * migration/etl.runner.ts — generic orchestrator driving every domain
 * migrator through extract -> transform -> validate -> load, in three modes:
 *
 *   dry-run  — extract + transform only. Zero reads or writes against the
 *              TARGET database (not even a validation read) -- purely
 *              "what does the source data look like and how many rows are
 *              there," safe to run against a live source at any time.
 *   validate — extract + transform + validate() (read-only checks against
 *              the target: FK existence, conflicts) -- still zero writes.
 *              This is the real pre-flight: run it before "apply" and fix
 *              every reported ERROR first.
 *   apply    — extract + transform + validate + upsert. The only mode that
 *              writes to the target. Still refuses to load any row with an
 *              ERROR-severity validation issue (WARNING-severity rows are
 *              loaded, since a warning is informational, not a blocker).
 *
 * Idempotent by construction: re-running "apply" with unchanged source
 * data reports every row as `skippedIdempotent` (see upsert.helper.ts) and
 * performs zero additional writes.
 */
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  DomainMigrator, MigrationClients, RunOptions, DomainStats,
  MigrationRunSummary, ValidationIssue, RollbackEntry,
} from "./types.js";
import { DOMAIN_ORDER } from "./domains/index.js";

const DEFAULT_MANIFEST_DIR = join(process.cwd(), "migration", "runs");

export async function runMigration(
  clients: MigrationClients,
  options: RunOptions,
): Promise<MigrationRunSummary> {
  const runId     = randomUUID();
  const startedAt = new Date().toISOString();
  const domains   = options.domains?.length
    ? DOMAIN_ORDER.filter((d) => options.domains!.includes(d.name))
    : DOMAIN_ORDER;

  const domainStats: DomainStats[] = [];
  const allValidationIssues: ValidationIssue[] = [];
  const rollbackManifest: RollbackEntry[] = [];

  for (const domain of domains) {
    const stats = await runDomain(domain, clients, options, allValidationIssues, rollbackManifest);
    domainStats.push(stats);
  }

  const finishedAt = new Date().toISOString();
  const summary: MigrationRunSummary = {
    runId, mode: options.mode, startedAt, finishedAt,
    domains: domainStats, validationIssues: allValidationIssues,
  };

  if (options.mode === "apply" && rollbackManifest.length > 0) {
    summary.rollbackManifestPath = await writeRollbackManifest(runId, rollbackManifest, summary);
  }

  return summary;
}

async function runDomain(
  domain: DomainMigrator,
  clients: MigrationClients,
  options: RunOptions,
  issuesOut: ValidationIssue[],
  rollbackOut: RollbackEntry[],
): Promise<DomainStats> {
  const startTime = Date.now();
  const stats: DomainStats = {
    domain: domain.name, sourceRowCount: 0, extracted: 0, transformFailed: 0,
    validationErrors: 0, loaded: 0, skippedIdempotent: 0, failed: 0, durationMs: 0,
  };

  const countResult = await clients.source.query<{ count: number }>(domain.countSql);
  stats.sourceRowCount = countResult.rows[0]?.count ?? 0;

  const targetTotal = options.limit > 0
    ? Math.min(options.limit, stats.sourceRowCount)
    : stats.sourceRowCount;

  let offset = 0;
  while (offset < targetTotal) {
    const batchLimit = Math.min(options.batchSize, targetTotal - offset);
    const { rows: sourceRows } = await clients.source.query(domain.extractSql(offset, batchLimit));

    for (const sourceRow of sourceRows) {
      let targetRow: Record<string, unknown>;
      try {
        targetRow = domain.transform(sourceRow) as Record<string, unknown>;
        stats.extracted++;
      } catch (err) {
        stats.transformFailed++;
        issuesOut.push({
          domain: domain.name, sourceId: pickIdLike(sourceRow), severity: "ERROR",
          message: `transform() threw: ${(err as Error).message}`,
        });
        continue;
      }

      if (options.mode === "dry-run") continue; // extract+transform only, by design -- no target DB access at all

      const rowIssues = await domain.validate(targetRow, clients);
      if (rowIssues.length > 0) issuesOut.push(...rowIssues);
      const blockingErrors = rowIssues.filter((i) => i.severity === "ERROR");
      if (blockingErrors.length > 0) {
        stats.validationErrors += blockingErrors.length;
        continue; // never load a row with an unresolved ERROR
      }

      if (options.mode === "validate") continue; // pre-flight only -- no writes

      try {
        const result = await domain.upsert(targetRow, clients);
        if (result.outcome === "UNCHANGED") {
          stats.skippedIdempotent++;
        } else {
          stats.loaded++;
          rollbackOut.push({
            domain: domain.name, targetPk: result.pk,
            action: result.outcome === "CREATED" ? "CREATED" : "UPDATED",
            previous: result.previous,
          });
        }
      } catch (err) {
        stats.failed++;
        issuesOut.push({
          domain: domain.name, sourceId: pickIdLike(sourceRow), severity: "ERROR",
          message: `upsert() threw: ${(err as Error).message}`,
        });
      }
    }

    offset += batchLimit;
  }

  stats.durationMs = Date.now() - startTime;
  return stats;
}

function pickIdLike(row: unknown): string {
  const r = row as Record<string, unknown>;
  return String(r.id ?? r.refreshToken ?? "unknown");
}

async function writeRollbackManifest(
  runId: string,
  entries: RollbackEntry[],
  summary: MigrationRunSummary,
): Promise<string> {
  await mkdir(DEFAULT_MANIFEST_DIR, { recursive: true });
  const path = join(DEFAULT_MANIFEST_DIR, `${runId}.rollback.json`);
  await writeFile(path, JSON.stringify({ runId, generatedAt: new Date().toISOString(), summary: {
    mode: summary.mode, startedAt: summary.startedAt, finishedAt: summary.finishedAt,
    domainCounts: summary.domains.map((d) => ({ domain: d.domain, loaded: d.loaded, skippedIdempotent: d.skippedIdempotent })),
  }, entries }, null, 2), "utf8");
  return path;
}
