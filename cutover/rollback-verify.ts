#!/usr/bin/env node
/**
 * cutover/rollback-verify.ts — TASK 5 (Cutover Execution Package):
 * rollback verification.
 *
 * ROLLBACK_PLAYBOOK.md §Steps 3 explicitly calls out that "v1 and apiv2
 * responses are close enough in shape that a purely visual check is not
 * sufficient; verify via a response header or endpoint known to differ."
 * This script automates exactly that verification, for BOTH directions:
 * confirms which backend origin a live frontend build's deployed JS
 * bundle actually references, by fetching the real bundle and searching
 * it for URLs -- the same technique PHASE H's due-diligence audit used
 * manually to first discover the frontend was still pointed at v1.
 *
 * Usage:
 *   npx tsx cutover/rollback-verify.ts --frontend https://www.igfxpro.com --expect https://api.igfxpro.com --disallow https://igfxpro-api.m-deluca0069.workers.dev
 *
 * Exit code 0 = the deployed bundle references the expected origin and
 * does NOT reference any disallowed origin. Exit code 1 = otherwise, or
 * on any fetch error. Entirely read-only -- fetches two public URLs and
 * nothing else.
 */
import { checkBundleTarget } from "./deployment.checks.js";

function parseArgs(argv: string[]): { frontend?: string; expect?: string; disallow: string[] } {
  const valueOf = (flag: string) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const disallow = argv
    .map((a, i) => (a === "--disallow" ? argv[i + 1] : undefined))
    .filter((v): v is string => Boolean(v));
  return { frontend: valueOf("--frontend"), expect: valueOf("--expect"), disallow };
}

async function findBundleUrl(frontendUrl: string): Promise<string> {
  const html = await (await fetch(frontendUrl)).text();
  const match = html.match(/src="(\/assets\/[^"]+\.js)"/) ?? html.match(/src="([^"]+\.js)"/);
  if (!match) throw new Error(`could not find a <script src=...> bundle reference in ${frontendUrl}'s HTML`);
  const bundlePath = match[1]!;
  return bundlePath.startsWith("http") ? bundlePath : new URL(bundlePath, frontendUrl).toString();
}

async function main(): Promise<void> {
  const { frontend, expect, disallow } = parseArgs(process.argv.slice(2));
  if (!frontend || !expect) {
    console.error("Usage: npx tsx cutover/rollback-verify.ts --frontend <url> --expect <origin> [--disallow <origin> ...]");
    process.exit(2);
  }

  console.log(`[rollback-verify] fetching ${frontend} ...`);
  const bundleUrl = await findBundleUrl(frontend);
  console.log(`[rollback-verify] deployed bundle: ${bundleUrl}`);

  const bundleText = await (await fetch(bundleUrl)).text();
  const result = checkBundleTarget(bundleText, expect, disallow);

  console.log(`\nExpected origin:    ${expect}`);
  console.log(`Disallowed origins: ${disallow.join(", ") || "(none specified)"}`);
  console.log(`Matched URLs:       ${result.matchedUrls.join(", ") || "(none)"}`);
  console.log(`All https URLs referenced in bundle: ${result.allUrls.slice(0, 10).join(", ")}${result.allUrls.length > 10 ? ` ... (${result.allUrls.length} total)` : ""}`);

  if (result.pointsAtExpected) {
    console.log(`\n[PASS] ${frontend} is correctly pointed at ${expect}.`);
    process.exit(0);
  } else {
    console.log(`\n[FAIL] ${frontend} does NOT correctly reference ${expect} (or references a disallowed origin instead).`);
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error(`[rollback-verify] ERROR: ${(err as Error).message}`);
  process.exit(1);
});
