#!/usr/bin/env node
/**
 * migration/cli.ts — entrypoint for the igfxpro-api (v1) -> igfxpro-apiv2
 * production-cutover ETL. See ETL_MIGRATION_GUIDE.md for full usage.
 *
 *   npm run migrate:v1 -- --dry-run
 *   npm run migrate:v1 -- --validate
 *   npm run migrate:v1 -- --apply --domains=users,wallets
 *   npm run migrate:v1 -- --apply --integrity-check
 *
 * Requires SOURCE_DATABASE_URL (v1's Postgres) and DATABASE_URL (apiv2's,
 * reused from shared/db.ts -- the same variable the running server itself
 * uses) in the environment. Refuses to run in --apply mode against a
 * source or target that looks like a production host unless
 * ALLOW_PRODUCTION_MIGRATION=true is also set -- see assertNotAccidental()
 * below. This CLI never runs itself; a human always types the command.
 */
import { createSourceClient, assertSourceReadOnly } from "./source.client.js";
import { runMigration } from "./etl.runner.js";
import { runIntegrityChecks } from "./integrity.checker.js";
import type { RunMode, RunOptions } from "./types.js";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

function parseArgs(argv: string[]): RunOptions & { integrityCheck: boolean } {
  const has = (flag: string) => argv.includes(flag);
  const valueOf = (flag: string): string | undefined => {
    const withEquals = argv.find((a) => a.startsWith(`${flag}=`));
    if (withEquals) return withEquals.slice(flag.length + 1);
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };

  let mode: RunMode = "dry-run";
  if (has("--apply")) mode = "apply";
  else if (has("--validate")) mode = "validate";
  else if (has("--dry-run")) mode = "dry-run";

  const domainsArg = valueOf("--domains");
  const domains    = domainsArg ? domainsArg.split(",").map((d) => d.trim()) : undefined;

  return {
    mode,
    domains,
    batchSize: Number(valueOf("--batch-size") ?? 500),
    limit:     Number(valueOf("--limit") ?? 0),
    integrityCheck: has("--integrity-check"),
  };
}

/**
 * Refuses --apply against anything that looks like a real production
 * database unless the operator explicitly overrides. This is a blunt,
 * string-matching heuristic (not a security boundary) -- its only job is
 * to make "I meant --dry-run and fat-fingered --apply" or "I copy-pasted
 * the wrong .env" loud and immediate instead of silently writing to
 * production data.
 */
function assertNotAccidental(sourceUrl: string, targetUrl: string, mode: RunMode): void {
  if (mode !== "apply") return;
  if (process.env.ALLOW_PRODUCTION_MIGRATION === "true") return;

  const looksProd = (url: string) =>
    /render\.com|amazonaws\.com|rds\./i.test(url) && !/localhost|127\.0\.0\.1|host\.docker\.internal/i.test(url);

  if (looksProd(sourceUrl) || looksProd(targetUrl)) {
    console.error(
      "[migration] REFUSING TO RUN: --apply against a database host that looks like production " +
      "(matched render.com/amazonaws.com/rds. in the connection string). This tool has no special " +
      "authorization to touch production data on its own -- if you really mean to run this against " +
      "production, set ALLOW_PRODUCTION_MIGRATION=true explicitly and re-run. Per " +
      "PRODUCTION_CUTOVER_REPORT.md, Stage 3/4/5 (shadow testing, cutover, retirement) are NOT " +
      "authorized to run autonomously in this project and require the user's direct execution.",
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  if (!sourceUrl) {
    console.error("[migration] SOURCE_DATABASE_URL is not set -- point it at igfxpro-api (v1)'s Postgres. See ETL_MIGRATION_GUIDE.md.");
    process.exit(1);
  }
  if (!IS_PERSISTENT || !prisma) {
    console.error("[migration] DATABASE_URL is not set / target is not persistent -- this ETL writes through apiv2's own Prisma client, which needs a real target database.");
    process.exit(1);
  }

  assertNotAccidental(sourceUrl, process.env.DATABASE_URL ?? "", options.mode);

  const source = createSourceClient(sourceUrl);
  await assertSourceReadOnly(source);

  const clients = { source, target: prisma };

  console.log(`[migration] mode=${options.mode} domains=${options.domains?.join(",") ?? "ALL"} batchSize=${options.batchSize}${options.limit ? ` limit=${options.limit}` : ""}`);

  const summary = await runMigration(clients, options);

  console.log("\n=== MIGRATION SUMMARY ===");
  console.table(summary.domains.map((d) => ({
    domain: d.domain, source: d.sourceRowCount, extracted: d.extracted,
    loaded: d.loaded, unchanged: d.skippedIdempotent,
    "validation errors": d.validationErrors, failed: d.failed, ms: d.durationMs,
  })));

  if (summary.validationIssues.length > 0) {
    console.log(`\n=== VALIDATION ISSUES (${summary.validationIssues.length}) ===`);
    for (const issue of summary.validationIssues.slice(0, 50)) {
      console.log(`  [${issue.severity}] ${issue.domain}#${issue.sourceId}: ${issue.message}`);
    }
    if (summary.validationIssues.length > 50) {
      console.log(`  ... and ${summary.validationIssues.length - 50} more`);
    }
  }

  if (summary.rollbackManifestPath) {
    console.log(`\nRollback manifest written to: ${summary.rollbackManifestPath}`);
  }

  if (options.integrityCheck) {
    console.log("\n=== INTEGRITY CHECK ===");
    const checks = await runIntegrityChecks(clients);
    console.table(checks);
    const failures = checks.filter((c) => !c.match);
    if (failures.length > 0) {
      console.error(`\n[migration] INTEGRITY CHECK FAILED: ${failures.length} mismatch(es) -- see table above.`);
      process.exitCode = 1;
    } else {
      console.log("\n[migration] Integrity check passed: source and target agree on every row count and financial sum checked.");
    }
  }

  await source.end();
}

main().catch((err) => {
  console.error("[migration] FATAL:", err);
  process.exit(1);
});
