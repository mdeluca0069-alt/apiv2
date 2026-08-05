/**
 * cutover.deployment.checks.spec.ts
 *
 * CUTOVER REMEDIATION (Task 5) — regression coverage for the pure logic
 * behind the cutover execution package's scripts (cutover/
 * deployment.checks.ts). The scripts themselves (cutover-checklist.ts,
 * rollback-checklist.ts, rollback-verify.ts, smoke-test.ts,
 * preflight-check.ts) do real network/process I/O and are meant to be run
 * directly by a human against a real target -- this file covers the
 * decision logic they share, independent of any live system.
 */
import { describe, it, expect } from "vitest";
import { extractUrlsFromBundle, checkBundleTarget, summarizeChecklist, type ChecklistItem } from "../cutover/deployment.checks.js";

describe("extractUrlsFromBundle()", () => {
  it("extracts every distinct https:// URL from bundle source text", () => {
    const bundle = `const a="https://api.example.com/foo";const b="https://api.example.com/bar";const c="https://other.example.com";`;
    const urls = extractUrlsFromBundle(bundle);
    expect(urls).toContain("https://api.example.com/foo");
    expect(urls).toContain("https://api.example.com/bar");
    expect(urls).toContain("https://other.example.com");
  });

  it("deduplicates repeated URLs", () => {
    const bundle = `"https://api.example.com" "https://api.example.com" "https://api.example.com"`;
    expect(extractUrlsFromBundle(bundle)).toEqual(["https://api.example.com"]);
  });

  it("returns an empty array when no https URLs are present", () => {
    expect(extractUrlsFromBundle("const x = 1; function foo() {}")).toEqual([]);
  });

  it("ignores http:// (non-TLS) URLs -- a bundle should never reference one in production", () => {
    const urls = extractUrlsFromBundle(`"http://insecure.example.com"`);
    expect(urls).toEqual([]);
  });
});

describe("checkBundleTarget()", () => {
  it("pointsAtExpected: true when the bundle references the expected origin and nothing disallowed", () => {
    const bundle = `VITE_API_URL="https://apiv2.igfxpro.com" VITE_WS_URL="wss://apiv2.igfxpro.com/ws"`;
    const result = checkBundleTarget(bundle, "https://apiv2.igfxpro.com", ["https://legacy-v1.workers.dev"]);
    expect(result.pointsAtExpected).toBe(true);
    expect(result.matchedUrls).toContain("https://apiv2.igfxpro.com");
  });

  it("pointsAtExpected: false when the bundle does not reference the expected origin at all (the exact PHASE H finding this reproduces)", () => {
    const bundle = `VITE_API_URL="https://legacy-v1.workers.dev"`;
    const result = checkBundleTarget(bundle, "https://apiv2.igfxpro.com", []);
    expect(result.pointsAtExpected).toBe(false);
    expect(result.matchedUrls).toEqual([]);
  });

  it("pointsAtExpected: false when the bundle references the expected origin BUT ALSO a disallowed one (ambiguous/mixed deployment)", () => {
    const bundle = `"https://apiv2.igfxpro.com" "https://legacy-v1.workers.dev"`;
    const result = checkBundleTarget(bundle, "https://apiv2.igfxpro.com", ["https://legacy-v1.workers.dev"]);
    expect(result.pointsAtExpected).toBe(false);
  });

  it("works with no disallowed-origins list at all (rollback-verify's simplest invocation)", () => {
    const bundle = `"https://api.igfxpro.com"`;
    const result = checkBundleTarget(bundle, "https://api.igfxpro.com");
    expect(result.pointsAtExpected).toBe(true);
  });

  it("matches only URLs that START WITH the expected origin, not a substring match anywhere", () => {
    const bundle = `"https://evil-api.igfxpro.com.attacker.example"`;
    const result = checkBundleTarget(bundle, "https://api.igfxpro.com");
    expect(result.pointsAtExpected).toBe(false);
  });
});

describe("summarizeChecklist()", () => {
  function item(status: ChecklistItem["status"]): ChecklistItem {
    return { id: "x", description: "x", status };
  }

  it("allAutomatedPass: true when there are zero fail items, even with manual items present", () => {
    const summary = summarizeChecklist([item("pass"), item("manual"), item("pass")]);
    expect(summary).toEqual({ allAutomatedPass: true, manualCount: 1, failCount: 0, passCount: 2 });
  });

  it("allAutomatedPass: false when at least one item failed", () => {
    const summary = summarizeChecklist([item("pass"), item("fail"), item("manual")]);
    expect(summary.allAutomatedPass).toBe(false);
    expect(summary.failCount).toBe(1);
  });

  it("handles an empty checklist", () => {
    expect(summarizeChecklist([])).toEqual({ allAutomatedPass: true, manualCount: 0, failCount: 0, passCount: 0 });
  });
});
