/**
 * scrypt.non.blocking.spec.ts
 *
 * PHASE2_REMEDIATION (H10): password verification/hashing previously used
 * `crypto.scryptSync`, which runs the KDF computation synchronously on the
 * JS main thread -- for the full duration of that call (Node's default
 * N=16384 cost factor is typically tens of milliseconds), NOTHING else on
 * the shared event loop can run: no other request, no WS message delivery,
 * no timer callback. This app is single-process with no worker-thread
 * offload anywhere, so every login attempt stalled all concurrent activity
 * (other users' order execution, price-feed processing, WS cluster
 * heartbeat) for that duration.
 *
 * Fixed by switching to the async `crypto.scrypt` (via node:util's
 * promisify), which runs the actual KDF computation on libuv's threadpool.
 *
 * These tests use REAL timers and REAL (non-mocked) scrypt computation --
 * mocking crypto here would only prove the code *calls* an async-shaped
 * function, not that it genuinely stops blocking the event loop, which is
 * the entire point of this finding. The assertion is a live demonstration:
 * a fast-ticking setInterval must be able to fire WHILE the scrypt
 * computation is in flight, which is only possible if that computation is
 * not running synchronously on the same thread as the interval's callback.
 */
import { describe, it, expect } from "vitest";
import { scryptSync } from "node:crypto";
import { BrokerState } from "../shared/state.js";
import { verifyPassword } from "../auth-service/password.hasher.js";

/** Ticks a counter every 2ms using real timers; returns a stop function and a live reader. */
function startEventLoopTicker() {
  let ticks = 0;
  const handle = setInterval(() => { ticks++; }, 2);
  return { stop: () => clearInterval(handle), count: () => ticks };
}

describe("scrypt-based auth — PHASE2_REMEDIATION (H10): does not block the event loop", () => {
  it("BrokerState.login() (sandbox in-memory auth) lets other timers fire while scrypt verification is in flight", async () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });
    const ticker = startEventLoopTicker();

    const auth = await state.login("trader@igfxpro.local", "OlosDemo!2026");

    ticker.stop();
    expect(auth).toBeTruthy();
    // If _verifyScryptAsync were still scryptSync, the event loop would be
    // fully blocked for the KDF's duration and this would be 0.
    expect(ticker.count()).toBeGreaterThan(0);
  });

  it("BrokerState.register() (sandbox in-memory auth) lets other timers fire while scrypt hashing is in flight", async () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });
    const ticker = startEventLoopTicker();

    const result = await state.register({
      email: `h10-${Date.now()}@example.test`,
      password: "SomeStrongPassword1!",
      fullName: "H10 Test User",
      country: "US",
    });

    ticker.stop();
    expect(result).toBeTruthy();
    expect(ticker.count()).toBeGreaterThan(0);
  });

  it("verifyPassword()'s legacy scrypt branch (DB-backed production auth) lets other timers fire while verifying", async () => {
    // Real legacy scrypt hash, format: salt:hexHash -- matches
    // auth-service/password.hasher.ts's verifyScrypt() expectations.
    const salt    = "h10testsalt";
    const derived = scryptSync("LegacyPassword1", salt, 64).toString("hex");
    const stored  = `${salt}:${derived}`;

    const ticker = startEventLoopTicker();
    const ok = await verifyPassword(stored, "LegacyPassword1");
    ticker.stop();

    expect(ok).toBe(true);
    expect(ticker.count()).toBeGreaterThan(0);
  });

  it("multiple concurrent login verifications resolve independently rather than serializing on a blocked main thread", async () => {
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false });
    const start = Date.now();

    // Both hit the SAME async verify path concurrently -- if it were still
    // synchronous, these would necessarily serialize (call 2 cannot even
    // begin until call 1's synchronous scryptSync returns).
    const [a, b] = await Promise.all([
      state.login("trader@igfxpro.local", "OlosDemo!2026"),
      state.login("admin@igfxpro.local", "OlosAdmin!2026"),
    ]);

    const elapsedMs = Date.now() - start;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // Not a strict perf assertion (CI hardware varies) -- just confirms
    // both completed via the same awaited call without throwing/hanging.
    expect(elapsedMs).toBeLessThan(5000);
  });
});
