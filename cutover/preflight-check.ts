#!/usr/bin/env node
/**
 * cutover/preflight-check.ts — TASK 5 (Cutover Execution Package):
 * production validation script.
 *
 * Runs the same checks main.ts enforces at real startup
 * (validateProductionEnvironment, checkJwtCutoverConfig), plus live
 * connectivity checks this process's own boot sequence doesn't itself
 * perform standalone (DB reachability + migration status, Redis
 * reachability). Meant to be run BEFORE a real deploy, so a
 * misconfiguration is caught by a human reading this script's output,
 * not by main.ts refusing to boot in front of a deploy pipeline.
 *
 * Usage:
 *   npx tsx cutover/preflight-check.ts
 *   NODE_ENV=production npx tsx cutover/preflight-check.ts   (checks production-only rules)
 *
 * Exit code 0 = all automated checks passed. Exit code 1 = at least one
 * failed -- read the printed detail before proceeding. This script never
 * modifies anything; every check is read-only.
 */
import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// new URL(...).pathname is NOT a safe filesystem path on Windows (yields
// a leading-slash form like "/C:/Users/..." that some path-joining logic,
// including dotenv's own, mis-resolves into "C:\C:\Users\..." -- confirmed
// live while building this script). fileURLToPath() is the robust,
// cross-platform-correct way to do this conversion.
dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import { validateProductionEnvironment } from "../security/production.env.validator.js";
import { checkJwtCutoverConfig } from "../security/jwt.cutover.guard.js";

type CheckResult = { name: string; ok: boolean; detail: string };

async function checkDatabase(): Promise<CheckResult> {
  if (!process.env.DATABASE_URL) {
    return { name: "PostgreSQL connectivity", ok: false, detail: "DATABASE_URL not set" };
  }
  try {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$disconnect();
    return { name: "PostgreSQL connectivity", ok: true, detail: "connected, SELECT 1 succeeded" };
  } catch (err) {
    return { name: "PostgreSQL connectivity", ok: false, detail: (err as Error).message };
  }
}

async function checkMigrationStatus(): Promise<CheckResult> {
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync("npx prisma migrate status", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const upToDate = output.includes("Database schema is up to date");
    return {
      name: "Prisma migration status",
      ok: upToDate,
      detail: upToDate ? "up to date" : output.trim().slice(-500),
    };
  } catch (err) {
    return { name: "Prisma migration status", ok: false, detail: (err as Error).message.slice(-500) };
  }
}

async function checkRedis(): Promise<CheckResult> {
  if (!process.env.REDIS_URL && !process.env.REDIS_SENTINELS) {
    return { name: "Redis connectivity", ok: true, detail: "not configured (optional -- app degrades gracefully without it)" };
  }
  try {
    const { initRedis, resolveRedisTarget } = await import("../shared/redis.js");
    const target = resolveRedisTarget(process.env, "redis://localhost:6379");
    const redis  = await initRedis(target);
    const pong   = await redis.ping();
    return { name: "Redis connectivity", ok: pong === "PONG", detail: `ping -> ${pong}` };
  } catch (err) {
    return { name: "Redis connectivity", ok: false, detail: (err as Error).message };
  }
}

async function main(): Promise<void> {
  const isProduction = process.env.NODE_ENV === "production";
  console.log(`[preflight] NODE_ENV=${process.env.NODE_ENV ?? "(unset)"} isProduction=${isProduction}\n`);

  const results: CheckResult[] = [];

  // ── Same logic main.ts's own startup gate enforces -- run it here too so
  //    a human can see it BEFORE a real deploy attempt, not just discover
  //    it when the process refuses to boot. ──────────────────────────────
  const envReport = validateProductionEnvironment(process.env, isProduction);
  for (const issue of envReport.issues) {
    results.push({
      name: `env: ${issue.integration}`,
      ok: issue.severity !== "error",
      detail: issue.message,
    });
  }
  if (envReport.issues.length === 0) {
    results.push({ name: "Production environment validation", ok: true, detail: "no issues" });
  }

  const jwtCheck = checkJwtCutoverConfig(process.env);
  results.push({
    name: "JWT cutover config",
    ok: jwtCheck.ok,
    detail: jwtCheck.ok
      ? (jwtCheck.cutoverModeActive ? "JWT_CUTOVER_MODE=true, HS256 confirmed" : "JWT_CUTOVER_MODE not active")
      : jwtCheck.error,
  });

  // ── Live connectivity checks (best-effort -- only run in isolation, no
  //    dependency on the rest of the app booting). ───────────────────────
  results.push(await checkDatabase());
  results.push(await checkMigrationStatus());
  results.push(await checkRedis());

  console.log("=== PREFLIGHT CHECK RESULTS ===");
  let allOk = true;
  for (const r of results) {
    const symbol = r.ok ? "[PASS]" : "[FAIL]";
    if (!r.ok) allOk = false;
    console.log(`${symbol} ${r.name}`);
    if (r.detail) console.log(`         ${r.detail}`);
  }

  console.log(`\n${allOk ? "ALL AUTOMATED CHECKS PASSED" : "ONE OR MORE CHECKS FAILED"} — ${results.filter((r) => r.ok).length}/${results.length} passed.`);
  console.log(
    "\nNote: this script cannot verify TLS certificate validity, Cloudflare DNS routing, host " +
    "provisioning, or on-call staffing -- those remain manual/credential actions per " +
    "CUTOVER_PLAYBOOK.md's own preconditions list. Run cutover/cutover-checklist.ts for the full " +
    "precondition walkthrough including those items.",
  );

  process.exit(allOk ? 0 : 1);
}

void main();
