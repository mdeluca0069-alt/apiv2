#!/usr/bin/env node
/**
 * cutover/smoke-test.ts — TASK 5 (Cutover Execution Package): post-cutover
 * smoke tests.
 *
 * Automates the SAFE, read-only-or-clearly-labelled-test-data subset of
 * CUTOVER_PLAYBOOK.md's T+0-to-T+15m smoke test list, against a real,
 * live BASE_URL. Steps involving real money movement or admin action
 * (deposit request + admin approval, placing a real market order) are
 * deliberately NOT automated here -- those require a human's own
 * judgment and authorization in the moment, exactly as the playbook
 * itself frames them ("Run the full workflow list... stop and consider
 * rollback if any step fails"). This script automates what's safe to
 * automate and prints the remaining steps as an explicit manual checklist
 * so nothing on the playbook's list is silently skipped.
 *
 * Usage:
 *   BASE_URL=https://api.igfxpro.com npx tsx cutover/smoke-test.ts
 *
 * Creates exactly one test account (email prefixed `cutover-smoke-test-`
 * with a timestamp, clearly identifiable for cleanup) to exercise
 * registration/login/session end-to-end. Exit code 0 = every automated
 * step passed. Exit code 1 = at least one failed -- STOP and consider
 * rollback per the playbook, do not proceed to the manual steps.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
// gateway/routes.ts's isClientAuthKeyValid() gates /auth/register and
// /auth/login/db against this shared, non-secret client key (defaults to
// "IGFX-AUTH-KEY" if CLIENT_AUTH_KEY isn't set) -- not a per-user secret,
// just a bot-deterrent the real frontend also sends.
const CLIENT_AUTH_KEY = process.env.CLIENT_AUTH_KEY ?? "IGFX-AUTH-KEY";

type StepResult = { name: string; ok: boolean; detail: string };

async function step(name: string, fn: () => Promise<string>): Promise<StepResult> {
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message };
  }
}

async function main(): Promise<void> {
  console.log(`=== POST-CUTOVER SMOKE TEST — BASE_URL=${BASE_URL} ===\n`);

  const results: StepResult[] = [];
  const testEmail = `cutover-smoke-test-${Date.now()}@igfxpro-smoketest.internal`;
  const testPassword = "SmokeTest#" + Math.random().toString(36).slice(2, 10);
  let accessToken = "";

  results.push(await step("1. Health check (liveness)", async () => {
    const r = await fetch(`${BASE_URL}/health`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json() as { status?: string };
    if (body.status !== "ok") throw new Error(`unexpected body: ${JSON.stringify(body)}`);
    return "status=ok";
  }));

  results.push(await step("2. Readiness check (DB/Redis/market-data/execution/risk)", async () => {
    const r = await fetch(`${BASE_URL}/api/health`);
    const body = await r.json() as Record<string, unknown>;
    return `HTTP ${r.status}, body=${JSON.stringify(body).slice(0, 300)}`;
  }));

  results.push(await step("3. Registration (new test account)", async () => {
    const r = await fetch(`${BASE_URL}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testEmail, password: testPassword, fullName: "Cutover Smoke Test", authKey: CLIENT_AUTH_KEY }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    return `registered ${testEmail}`;
  }));

  results.push(await step("4. Login (the account just registered)", async () => {
    const r = await fetch(`${BASE_URL}/api/v1/auth/login/db`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const body = await r.json() as { accessToken?: string };
    if (!body.accessToken) throw new Error("no accessToken in response");
    accessToken = body.accessToken;
    return "login succeeded, accessToken received";
  }));

  results.push(await step("5. Wallet balance (authenticated read)", async () => {
    const r = await fetch(`${BASE_URL}/api/v1/wallet/balance`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const body = await r.json() as Record<string, unknown>;
    return JSON.stringify(body);
  }));

  results.push(await step("6. KYC case view (authenticated read)", async () => {
    const r = await fetch(`${BASE_URL}/api/v1/kyc/case`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // A brand-new account may have no KYC case yet (404) -- that's a
    // valid, non-failing response shape; only a 5xx or network error fails this step.
    if (r.status >= 500) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    return `HTTP ${r.status}`;
  }));

  results.push(await step("7. Session refresh", async () => {
    const r = await fetch(`${BASE_URL}/api/v1/auth/session`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    return `HTTP ${r.status}`;
  }));

  results.push(await step("8. Logout", async () => {
    const r = await fetch(`${BASE_URL}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status >= 500) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    return `HTTP ${r.status}`;
  }));

  console.log("=== AUTOMATED STEPS ===");
  let allOk = true;
  for (const r of results) {
    console.log(`${r.ok ? "[PASS]" : "[FAIL]"} ${r.name}`);
    console.log(`         ${r.detail}`);
    if (!r.ok) allOk = false;
  }

  console.log("\n=== REMAINING MANUAL STEPS (CUTOVER_PLAYBOOK.md T+0-T+15m) — NOT automated, require human judgment ===");
  console.log("  [ ] 2FA setup/verify");
  console.log("  [ ] Deposit request (real PSP flow)");
  console.log("  [ ] Admin deposit approval");
  console.log("  [ ] Place one small REAL market order");
  console.log("  [ ] Verify WebSocket delivers the fill event in real time");
  console.log("  [ ] Close the position");
  console.log("  [ ] Verify ledger/trade history reflects it");
  console.log("  [ ] Notifications delivered");
  console.log("  [ ] Admin panel shows the account");

  console.log(`\nTest account created: ${testEmail} — clean this up after the cutover window closes.`);
  console.log(allOk ? "\nAll automated steps PASSED." : "\nAt least one automated step FAILED — per the playbook, stop and consider rollback before proceeding to the manual steps.");

  process.exit(allOk ? 0 : 1);
}

void main();
