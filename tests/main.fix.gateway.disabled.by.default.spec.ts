/**
 * main.fix.gateway.disabled.by.default.spec.ts
 *
 * FIX GATEWAY HARDENING — the entire point of this pass is that the FIX
 * acceptor must remain fully off unless an operator explicitly opts in
 * (FIX_GATEWAY_EXPOSURE_REVIEW.md: "FIX is fully dark today... by two
 * independent gates"). This is a static source-text regression guard
 * against someone accidentally loosening that gate in main.ts later —
 * e.g. changing it to a truthy-string check, defaulting to enabled, or
 * removing the guard while refactoring the surrounding bootstrap code.
 *
 * main.ts cannot be imported directly in tests — it starts a live HTTP/WS
 * server unconditionally on import (same constraint noted throughout this
 * program's test suite, e.g.
 * main.jobcoordinator.registration.completeness.spec.ts), so this checks
 * the source text itself rather than runtime behavior.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainTsSource = readFileSync(join(__dirname, "..", "main.ts"), "utf-8");

describe("main.ts FIX gateway startup gate", () => {
  it("REGRESSION GUARD: initFixAcceptor() is only ever called inside an explicit FIX_ENABLED === \"true\" check", () => {
    const initCallIndex = mainTsSource.indexOf("initFixAcceptor(");
    expect(initCallIndex, "initFixAcceptor( call site not found in main.ts").toBeGreaterThan(-1);

    // The nearest preceding `if (...)` before the call must be exactly the
    // strict-equality FIX_ENABLED check -- not a truthy check
    // (`if (process.env.FIX_ENABLED)`, which "false" as a *string* would
    // satisfy), and not some other unrelated guard.
    const precedingSource = mainTsSource.slice(0, initCallIndex);
    const lastIfIndex = precedingSource.lastIndexOf("if (");
    expect(lastIfIndex, "no `if (` found before the initFixAcceptor( call").toBeGreaterThan(-1);

    const guardCondition = precedingSource.slice(lastIfIndex, lastIfIndex + 80);
    expect(guardCondition).toContain('process.env.FIX_ENABLED === "true"');
  });

  it("does not call initFixAcceptor() unconditionally at module top level (outside any if-block)", () => {
    // A crude but effective check: every occurrence of initFixAcceptor(
    // must have "FIX_ENABLED" appearing somewhere in the 300 characters
    // immediately before it in the source.
    const matches = [...mainTsSource.matchAll(/initFixAcceptor\(/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      const windowStart = Math.max(0, m.index! - 300);
      const window = mainTsSource.slice(windowStart, m.index);
      expect(window).toContain("FIX_ENABLED");
    }
  });

  it("FIX_ENABLED is not set to \"true\" anywhere in this repo's own tracked env templates", () => {
    // .env.example documents the flag (operators need to discover it
    // exists) but must ship with it off -- a template that shipped
    // FIX_ENABLED=true would make every fresh checkout default to exposing
    // an unauthenticated-at-the-network-layer TCP listener.
    const envExamplePath = join(__dirname, "..", ".env.example");
    const envExample = readFileSync(envExamplePath, "utf-8");
    const match = envExample.match(/^FIX_ENABLED=(.*)$/m);
    expect(match, "FIX_ENABLED not documented in .env.example").not.toBeNull();
    expect(match![1]!.trim()).toBe("false");
  });
});
