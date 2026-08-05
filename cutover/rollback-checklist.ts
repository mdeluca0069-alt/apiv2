#!/usr/bin/env node
/**
 * cutover/rollback-checklist.ts — TASK 5 (Cutover Execution Package):
 * rollback checklist.
 *
 * Walks ROLLBACK_PLAYBOOK.md's procedure, running an automated check
 * wherever this process can (v1's own health, right now, matters more
 * than ever here -- ROLLBACK_PLAYBOOK.md's entire zero-downtime guarantee
 * assumes v1 is healthy and available as the fallback target; if it
 * isn't, rolling back does not actually restore service). This script
 * NEVER executes the rollback itself (no frontend redeploy, no DNS
 * change) -- it is a pre-flight/post-flight verification tool for a
 * human executing the documented procedure by hand, per this whole
 * program's standing rule that Stage 3/4/5 require direct human
 * execution.
 *
 * Usage:
 *   npx tsx cutover/rollback-checklist.ts --v1-url https://api.igfxpro.com
 *   npx tsx cutover/rollback-checklist.ts --v1-url https://api.igfxpro.com --frontend https://www.igfxpro.com --v1-origin https://api.igfxpro.com --apiv2-origin https://apiv2.igfxpro.com
 */
import type { ChecklistItem } from "./deployment.checks.js";
import { summarizeChecklist, checkBundleTarget } from "./deployment.checks.js";

function parseArgs(argv: string[]) {
  const valueOf = (flag: string) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  return {
    v1Url:       valueOf("--v1-url"),
    frontend:    valueOf("--frontend"),
    v1Origin:    valueOf("--v1-origin"),
    apiv2Origin: valueOf("--apiv2-origin"),
  };
}

async function checkV1Health(v1Url: string): Promise<ChecklistItem> {
  try {
    const r = await fetch(`${v1Url}/health`);
    const ok = r.status === 200;
    return {
      id: "v1-health",
      description: "v1 is healthy and available as the rollback target",
      status: ok ? "pass" : "fail",
      detail: `GET ${v1Url}/health -> HTTP ${r.status}. ${ok ? "" : "ROLLBACK_PLAYBOOK.md's zero-downtime guarantee assumes v1 is healthy -- if it is not, rolling back will NOT restore service. Restore v1's own health first, or expect real downtime during rollback."}`,
    };
  } catch (err) {
    return {
      id: "v1-health",
      description: "v1 is healthy and available as the rollback target",
      status: "fail",
      detail: `Could not reach ${v1Url}: ${(err as Error).message}`,
    };
  }
}

async function main(): Promise<void> {
  const { v1Url, frontend, v1Origin, apiv2Origin } = parseArgs(process.argv.slice(2));
  if (!v1Url) {
    console.error("Usage: npx tsx cutover/rollback-checklist.ts --v1-url <url> [--frontend <url> --v1-origin <origin> --apiv2-origin <origin>]");
    process.exit(2);
  }

  const items: ChecklistItem[] = [];

  console.log("=== ROLLBACK PRECONDITION CHECK ===\n");
  items.push(await checkV1Health(v1Url));

  items.push({
    id: "v1-database-untouched",
    description: "v1's database was never modified during the apiv2 window",
    status: "manual",
    detail: "By design (see ROLLBACK_PLAYBOOK.md \"Why rollback is fast and safe by construction\"), v1's database is never written to while apiv2 serves traffic -- this is a design invariant, not something observable by a health check. Confirm no out-of-band change was made.",
  });

  if (frontend && v1Origin) {
    console.log(`\n=== FRONTEND TARGET CHECK (post-rollback) ===\n`);
    try {
      const html = await (await fetch(frontend)).text();
      const match = html.match(/src="(\/assets\/[^"]+\.js)"/) ?? html.match(/src="([^"]+\.js)"/);
      if (!match) throw new Error("could not find a bundle reference in the frontend HTML");
      const bundleUrl = match[1]!.startsWith("http") ? match[1]! : new URL(match[1]!, frontend).toString();
      const bundleText = await (await fetch(bundleUrl)).text();
      const result = checkBundleTarget(bundleText, v1Origin, apiv2Origin ? [apiv2Origin] : []);
      items.push({
        id: "frontend-points-at-v1",
        description: `Frontend (${frontend}) points back at v1 (${v1Origin}) after rollback`,
        status: result.pointsAtExpected ? "pass" : "fail",
        detail: `bundle=${bundleUrl}, matched=${result.matchedUrls.join(", ") || "(none)"}`,
      });
    } catch (err) {
      items.push({
        id: "frontend-points-at-v1",
        description: `Frontend (${frontend}) points back at v1 (${v1Origin}) after rollback`,
        status: "fail",
        detail: (err as Error).message,
      });
    }
  } else {
    items.push({
      id: "frontend-points-at-v1",
      description: "Frontend points back at v1 after rollback",
      status: "manual",
      detail: "Re-run with --frontend <url> --v1-origin <origin> [--apiv2-origin <origin>] to automate this check, or use cutover/rollback-verify.ts directly.",
    });
  }

  items.push({
    id: "reconciliation",
    description: "Any apiv2-only writes between T-0 and the rollback decision are reverse-reconciled into v1 before telling users \"you're back on the old system\"",
    status: "manual",
    detail: "Run the ETL (migration/cli.ts) in the reverse direction, dry-run/validated first, exactly as the forward migration was. See ROLLBACK_PLAYBOOK.md's Data Reconciliation section.",
  });

  items.push({
    id: "stakeholder-notification",
    description: "Stakeholders notified that rollback occurred, with the specific abort criterion that triggered it",
    status: "manual",
    detail: "Human/organizational action.",
  });

  console.log("\n=== ROLLBACK CHECKLIST SUMMARY ===");
  for (const item of items) {
    const symbol = { pass: "[PASS]", fail: "[FAIL]", manual: "[MANUAL]", skipped: "[SKIP]" }[item.status];
    console.log(`${symbol} ${item.description}`);
    if (item.detail) console.log(`         ${item.detail}`);
  }

  const summary = summarizeChecklist(items);
  console.log(`\n${summary.passCount} passed, ${summary.failCount} failed, ${summary.manualCount} require manual confirmation.`);
  process.exit(summary.allAutomatedPass ? 0 : 1);
}

void main();
