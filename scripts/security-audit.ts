#!/usr/bin/env tsx
/**
 * scripts/security-audit.ts — Dependency vulnerability audit.
 *
 * Runs `npm audit --json`, parses the output, and exits non-zero if any
 * HIGH or CRITICAL vulnerability is found.
 *
 * Usage:  npx tsx scripts/security-audit.ts
 */

import { execSync } from "node:child_process";

interface NpmAuditVulnerability {
  severity: string;
  title:    string;
  url:      string;
  fixAvailable?: boolean | { name: string; version: string };
}

interface NpmAuditReport {
  metadata?: {
    vulnerabilities?: {
      info?:     number;
      low?:      number;
      moderate?: number;
      high?:     number;
      critical?: number;
      total?:    number;
    };
  };
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
}

function runAudit(): void {
  console.log("[security-audit] running npm audit...\n");

  let raw: string;
  try {
    raw = execSync("npm audit --json", {
      cwd:      new URL("../", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
      encoding: "utf8",
      stdio:    ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities are found — the stdout
    // still contains valid JSON, so we grab it from the error object.
    const execError = err as { stdout?: string; stderr?: string };
    raw = execError.stdout ?? "";
    if (!raw) {
      console.error("[security-audit] npm audit failed with no output:", execError.stderr);
      process.exit(1);
    }
  }

  let report: NpmAuditReport;
  try {
    report = JSON.parse(raw) as NpmAuditReport;
  } catch {
    console.error("[security-audit] failed to parse npm audit JSON output");
    console.error(raw.slice(0, 2000));
    process.exit(1);
  }

  const meta  = report.metadata?.vulnerabilities ?? {};
  const high  = meta.high     ?? 0;
  const crit  = meta.critical ?? 0;
  const total = meta.total    ?? 0;

  console.log("Vulnerability summary:");
  console.log(`  critical : ${crit}`);
  console.log(`  high     : ${high}`);
  console.log(`  moderate : ${meta.moderate ?? 0}`);
  console.log(`  low      : ${meta.low      ?? 0}`);
  console.log(`  info     : ${meta.info     ?? 0}`);
  console.log(`  total    : ${total}`);
  console.log();

  if (high > 0 || crit > 0) {
    console.error(`[security-audit] FAILED — ${crit} critical + ${high} high vulnerabilities detected\n`);

    const vulns = report.vulnerabilities ?? {};
    for (const [name, vuln] of Object.entries(vulns)) {
      if (vuln.severity === "high" || vuln.severity === "critical") {
        const fix = typeof vuln.fixAvailable === "object"
          ? ` — fix: npm install ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}`
          : vuln.fixAvailable === true ? " — fix available" : " — no fix available";
        console.error(`  [${vuln.severity.toUpperCase()}] ${name}: ${vuln.title}${fix}`);
        if (vuln.url) console.error(`          ${vuln.url}`);
      }
    }
    console.error("\nRun: npm audit fix\n");
    process.exit(1);
  }

  console.log("[security-audit] PASSED — no high or critical vulnerabilities found");
  process.exit(0);
}

runAudit();
