/**
 * ws.token.expiry.spec.ts
 *
 * PHASE C PENTEST (JWT/session finding #3): verifyClient() (main.ts)
 * validates the JWT once, at WS handshake, but nothing thereafter
 * re-checked token validity for the life of the connection -- a socket
 * opened with a soon-to-expire access token kept its userId/tenantId
 * trusted (used to route pushToUser/pushToStaff real-time events) past
 * the JWT's own `exp`. main.ts's 30s keepalive loop now calls
 * isTokenExpired() on every tick and closes the socket once the
 * authenticating token's exp has passed.
 */
import { describe, it, expect } from "vitest";
import { isTokenExpired } from "../realtime-infra/ws.token.expiry.js";

describe("isTokenExpired() — PHASE C PENTEST (JWT/session finding #3)", () => {
  it("returns false for a token whose exp is in the future", () => {
    const nowMs = Date.now();
    const exp = Math.floor(nowMs / 1000) + 300; // 5 minutes from now
    expect(isTokenExpired(exp, nowMs)).toBe(false);
  });

  it("returns true for a token whose exp has already passed", () => {
    const nowMs = Date.now();
    const exp = Math.floor(nowMs / 1000) - 60; // expired 1 minute ago
    expect(isTokenExpired(exp, nowMs)).toBe(true);
  });

  it("returns true at the exact moment of expiry (boundary)", () => {
    const nowMs = 1_700_000_000_000;
    const exp = nowMs / 1000; // exactly now, in seconds
    expect(isTokenExpired(exp, nowMs)).toBe(true);
  });

  it("returns false when no exp is present (sandbox-mode unauthenticated socket)", () => {
    expect(isTokenExpired(undefined, Date.now())).toBe(false);
  });

  it("correctly interprets exp in SECONDS, not milliseconds (matches the JWT exp claim convention)", () => {
    // A common unit-confusion bug: if exp were mistakenly compared as
    // milliseconds directly against Date.now(), a real token expiring
    // ~1 hour from now (exp in seconds, a huge number when misread as ms
    // would actually be far in the FUTURE relative to epoch-ms "now" --
    // but the inverse mistake, treating a real future epoch-SECONDS value
    // as already-elapsed milliseconds, is the actual failure mode this
    // guards): a token expiring 1 hour from now must not be reported
    // expired.
    const nowMs = Date.now();
    const oneHourFromNowSeconds = Math.floor(nowMs / 1000) + 3600;
    expect(isTokenExpired(oneHourFromNowSeconds, nowMs)).toBe(false);
  });
});
