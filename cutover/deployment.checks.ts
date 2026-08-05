/**
 * cutover/deployment.checks.ts — pure, testable logic shared by the
 * cutover execution package's scripts (cutover-checklist.ts,
 * rollback-checklist.ts, rollback-verify.ts). Kept separate from the
 * scripts themselves (which do real network/process I/O and are meant to
 * be run by a human, never imported) so the decision logic is unit-
 * testable without needing a live frontend/backend to test against.
 */

/**
 * Extracts every `https://...` URL referenced in a deployed frontend
 * bundle's source text. Used to determine which backend a live frontend
 * build is actually pointed at, the same way PHASE H's due-diligence
 * audit did manually (fetch the bundle, grep for the API URL) -- this
 * makes that check repeatable and scriptable instead of a one-off manual
 * investigation.
 */
export function extractUrlsFromBundle(bundleText: string): string[] {
  const matches = bundleText.matchAll(/https:\/\/[a-zA-Z0-9.\-_/]+/g);
  return [...new Set([...matches].map((m) => m[0]))];
}

export type BundleTargetCheck = {
  pointsAtExpected: boolean;
  matchedUrls:      string[];
  allUrls:          string[];
};

/**
 * Checks whether a deployed frontend bundle's source references the
 * expected backend origin (e.g. apiv2's real host after cutover, or v1's
 * host after a rollback) and does NOT reference any of the explicitly
 * disallowed origins (e.g. the OTHER backend, which should be fully
 * absent from a correctly-deployed build).
 */
export function checkBundleTarget(
  bundleText: string,
  expectedOrigin: string,
  disallowedOrigins: string[] = [],
): BundleTargetCheck {
  const allUrls = extractUrlsFromBundle(bundleText);
  const matchedUrls = allUrls.filter((u) => u.startsWith(expectedOrigin));
  const disallowedHit = allUrls.some((u) => disallowedOrigins.some((d) => u.startsWith(d)));
  return {
    pointsAtExpected: matchedUrls.length > 0 && !disallowedHit,
    matchedUrls,
    allUrls,
  };
}

export type ChecklistItem = {
  id:          string;
  description: string;
  status:      "pass" | "fail" | "manual" | "skipped";
  detail?:     string;
};

/** Aggregates a list of checklist items into an overall verdict. Pure so
 *  the pass/fail/manual-counting logic itself is independently testable,
 *  separate from however a given script chooses to print it. */
export function summarizeChecklist(items: ChecklistItem[]): {
  allAutomatedPass: boolean;
  manualCount:      number;
  failCount:        number;
  passCount:        number;
} {
  const failCount   = items.filter((i) => i.status === "fail").length;
  const manualCount = items.filter((i) => i.status === "manual").length;
  const passCount   = items.filter((i) => i.status === "pass").length;
  return { allAutomatedPass: failCount === 0, manualCount, failCount, passCount };
}
