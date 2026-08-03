/**
 * main.jobcoordinator.registration.completeness.spec.ts
 *
 * CUTOVER READINESS AUDIT (2026-08-04): the "recovery-stuck-order-sweep"
 * job (added in PHASE E) called jobCoordinator.tryLead("recovery-stuck-
 * order-sweep")/.release(...) but was never passed to
 * jobCoordinator.register(...) anywhere in main.ts. JobCoordinator._get()
 * throws `job "..." not registered — call register() first` for any
 * unregistered id (realtime-infra/job.coordinator.ts) -- since tryLead()
 * is called before the interval body's own try/catch, this became an
 * unhandled promise rejection every 2 minutes (non-fatal only because
 * main.ts's unhandledRejection handler logs and swallows it), and more
 * importantly meant the periodic sweep itself silently never ran past the
 * one-time startup call -- regressing the exact gap that job's own PHASE E
 * fix was meant to close.
 *
 * main.ts cannot be imported directly in tests (it starts a live HTTP/WS
 * server unconditionally on import, the same constraint noted throughout
 * this program's test suite) -- this is a static source-text check
 * instead: every `jobCoordinator.tryLead("<id>")` call site in main.ts
 * must have a corresponding `jobCoordinator.register({ id: "<id>"` call
 * somewhere in the same file. This catches the exact bug class (a new
 * scheduled job wired to tryLead/release without ever being registered),
 * not just this one instance of it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainTsSource = readFileSync(join(__dirname, "..", "main.ts"), "utf-8");

function extractTryLeadIds(source: string): string[] {
  const matches = source.matchAll(/jobCoordinator\.tryLead\(\s*"([^"]+)"\s*\)/g);
  return [...new Set([...matches].map((m) => m[1]!))];
}

function extractRegisteredIds(source: string): Set<string> {
  const matches = source.matchAll(/jobCoordinator\.register\(\{\s*id:\s*"([^"]+)"/g);
  return new Set([...matches].map((m) => m[1]!));
}

describe("main.ts — every jobCoordinator.tryLead() call site has a matching register() (PHASE 2 cutover audit)", () => {
  it("finds at least one tryLead() call and at least one register() call (sanity check the regexes still match main.ts's current style)", () => {
    const tryLeadIds = extractTryLeadIds(mainTsSource);
    const registeredIds = extractRegisteredIds(mainTsSource);
    expect(tryLeadIds.length).toBeGreaterThan(5);
    expect(registeredIds.size).toBeGreaterThan(5);
  });

  it("every job id passed to tryLead() is registered via jobCoordinator.register()", () => {
    const tryLeadIds = extractTryLeadIds(mainTsSource);
    const registeredIds = extractRegisteredIds(mainTsSource);

    const unregistered = tryLeadIds.filter((id) => !registeredIds.has(id));

    expect(unregistered).toEqual([]);
  });

  it("specifically confirms recovery-stuck-order-sweep is registered (the exact regression this audit found)", () => {
    const registeredIds = extractRegisteredIds(mainTsSource);
    expect(registeredIds.has("recovery-stuck-order-sweep")).toBe(true);
  });
});
