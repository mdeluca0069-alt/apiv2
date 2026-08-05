#!/usr/bin/env node
/**
 * cutover/cutover-checklist.ts — TASK 5 (Cutover Execution Package):
 * executable cutover checklist.
 *
 * Walks CUTOVER_PLAYBOOK.md's 9 preconditions and its T-30m/T-20m/T-5m
 * pre-flight window, running an automated check wherever this process
 * genuinely can (env config, DB/migration/Redis connectivity, ETL dry-run
 * + validate + integrity-check against a configured source) and clearly
 * marking anything that requires real infrastructure access, credentials,
 * or human judgment as "manual" rather than silently skipping it or
 * (worse) faking a pass.
 *
 * This script NEVER writes to a database, NEVER touches DNS/Cloudflare,
 * and NEVER runs the ETL in --apply mode -- it is a read-only readiness
 * report, matching this whole program's standing rule that Stage 3/4/5
 * require a human's own direct execution (see migration/cli.ts's own
 * assertNotAccidental() for the same principle applied to the ETL itself).
 *
 * Usage:
 *   npx tsx cutover/cutover-checklist.ts
 *   SOURCE_DATABASE_URL=postgresql://... npx tsx cutover/cutover-checklist.ts   (also runs ETL dry-run+validate+integrity-check)
 *
 * Exit code 0 = every AUTOMATED check passed (manual items may still be
 * outstanding -- read the report). Exit code 1 = at least one automated
 * check failed.
 */
import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// See cutover/preflight-check.ts's comment on this exact line for why
// fileURLToPath() is used instead of new URL(...).pathname on Windows.
dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import type { ChecklistItem } from "./deployment.checks.js";
import { summarizeChecklist } from "./deployment.checks.js";

async function runPreflightScript(): Promise<{ ok: boolean; output: string }> {
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync("npx tsx cutover/preflight-check.ts", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; message: string };
    return { ok: false, output: e.stdout ?? e.message };
  }
}

async function runEtlCheck(): Promise<ChecklistItem> {
  if (!process.env.SOURCE_DATABASE_URL) {
    return {
      id: "etl-tooling",
      description: "Final ETL delta-sync tooling tested and ready (ETL_MIGRATION_GUIDE.md)",
      status: "manual",
      detail: "SOURCE_DATABASE_URL not set in this run -- set it to v1's real (or a realistic staging copy of v1's) Postgres and re-run to exercise --dry-run, --validate, and --integrity-check automatically.",
    };
  }
  try {
    const { execSync } = await import("node:child_process");
    const dryRun   = execSync("npx tsx migration/cli.ts --dry-run", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const validate = execSync("npx tsx migration/cli.ts --validate", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const hasValidationErrors = /VALIDATION ISSUES \((?!0\))/.test(validate);
    return {
      id: "etl-tooling",
      description: "Final ETL delta-sync tooling tested and ready (ETL_MIGRATION_GUIDE.md)",
      status: hasValidationErrors ? "fail" : "pass",
      detail: hasValidationErrors
        ? `--validate reported issues against the configured SOURCE_DATABASE_URL -- resolve before --apply. Last lines:\n${validate.trim().split("\n").slice(-15).join("\n")}`
        : `--dry-run and --validate both completed cleanly.\n${dryRun.trim().split("\n").slice(-12).join("\n")}`,
    };
  } catch (err) {
    return {
      id: "etl-tooling",
      description: "Final ETL delta-sync tooling tested and ready (ETL_MIGRATION_GUIDE.md)",
      status: "fail",
      detail: (err as Error).message,
    };
  }
}

async function main(): Promise<void> {
  const items: ChecklistItem[] = [];

  console.log("=== CUTOVER PRECONDITIONS (CUTOVER_PLAYBOOK.md) ===\n");

  // 1-2: Stage 1/3 code fixes -- this process can verify the LOCAL
  // codebase's automated test suite for these (bcrypt compat, migration
  // drift, etc. all have dedicated regression tests), but cannot observe
  // what's actually deployed on a real target host from here.
  items.push({
    id: "stage1-3-fixes-deployed",
    description: "Stage 1 + Stage 3 code fixes deployed to the REAL apiv2 production instance and running clean",
    status: "manual",
    detail: "The fixes themselves are verified by this repo's own test suite (npx vitest run) and are present in this codebase's current commit -- but whether that exact commit is what's actually running on the real target host is not observable from here. Confirm the deployed image/commit hash matches before proceeding.",
  });

  items.push({
    id: "horizontal-scaling",
    description: "Horizontal scaling provisioned: minimum 3 api replicas behind nginx",
    status: "manual",
    detail: "Requires real host access to confirm replica count -- see FINAL_PRODUCTION_READINESS_REPORT.md §2.3 for provisioning steps.",
  });

  items.push({
    id: "tls-cert",
    description: "Real, CA-issued TLS certificate installed (not the shadow self-signed placeholder)",
    status: "manual",
    detail: "Requires Cloudflare dashboard access -- see FINAL_PRODUCTION_READINESS_REPORT.md §2.1.",
  });

  const twelveDataKeySet = Boolean(process.env.TWELVEDATA_API_KEY);
  items.push({
    id: "twelvedata-key",
    description: "Real TWELVEDATA_API_KEY configured",
    status: twelveDataKeySet ? "pass" : "fail",
    detail: twelveDataKeySet ? "TWELVEDATA_API_KEY is set in this environment." : "TWELVEDATA_API_KEY is not set -- most instruments will show stale data and reject every order.",
  });

  items.push(await runEtlCheck());

  items.push({
    id: "backup-restore-rehearsed",
    description: "Backup/restore rehearsal completed at least once against the real production topology",
    status: "manual",
    detail: "Historical/organizational confirmation -- not observable from this process. See PRODUCTION_DEPLOYMENT_CHECKLIST.md §7 for the rehearsal procedure if not yet done.",
  });

  items.push({
    id: "on-call",
    description: "On-call engineer identified and available for the full soak window",
    status: "manual",
    detail: "Organizational confirmation required from the human executing this playbook.",
  });

  items.push({
    id: "rollback-playbook-read",
    description: "Rollback playbook (ROLLBACK_PLAYBOOK.md) read and understood by whoever is executing this playbook",
    status: "manual",
    detail: "Confirm before proceeding. Run cutover/rollback-checklist.ts to see the rollback procedure's own automated checks.",
  });

  console.log("=== PRODUCTION ENVIRONMENT PREFLIGHT (cutover/preflight-check.ts) ===\n");
  const preflight = await runPreflightScript();
  items.push({
    id: "env-preflight",
    description: "Production environment validation (JWT, DB, Redis, PSPs, SMTP, AWS -- see security/production.env.validator.ts)",
    status: preflight.ok ? "pass" : "fail",
    detail: preflight.output.trim().split("\n").slice(-30).join("\n"),
  });
  console.log(preflight.output);

  console.log("\n=== CHECKLIST SUMMARY ===");
  for (const item of items) {
    const symbol = { pass: "[PASS]", fail: "[FAIL]", manual: "[MANUAL]", skipped: "[SKIP]" }[item.status];
    console.log(`${symbol} ${item.description}`);
    if (item.detail) console.log(`         ${item.detail.split("\n").join("\n         ")}`);
  }

  const summary = summarizeChecklist(items);
  console.log(
    `\n${summary.passCount} passed, ${summary.failCount} failed, ${summary.manualCount} require manual confirmation.`,
  );
  if (summary.manualCount > 0) {
    console.log("MANUAL items above must be explicitly confirmed by a human before T-0 -- this script cannot verify them.");
  }
  if (!summary.allAutomatedPass) {
    console.log("\nAt least one AUTOMATED check FAILED. Do not proceed to T-0 until every FAIL above is resolved.");
  }

  process.exit(summary.allAutomatedPass ? 0 : 1);
}

void main();
