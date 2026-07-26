/**
 * permission.middleware.public.paths.spec.ts
 *
 * PRODUCTION CUTOVER Stage 2 — found via live validation (a real
 * POST /api/v1/auth/register/db against a running server returned 403
 * FORBIDDEN "unauthenticated") that PUBLIC_PATHS anchored the register
 * pattern with `$`, matching ONLY the bare `/api/v1/auth/register` path.
 * `/register/db` (gateway/routes.ts) is the actual endpoint used whenever
 * IS_PERSISTENT is true -- i.e. every real, database-backed deployment,
 * including the one this production-cutover migration targets. Since a
 * brand new user has no JWT by definition, this made registration
 * completely unreachable in any real deployment. `/login` already handled
 * this correctly (deliberately unanchored, per its own comment) -- this
 * proves `/register` now matches the same way, and that the fix didn't
 * accidentally make a genuinely-protected route public.
 */
import { describe, it, expect } from "vitest";
import { permissionMiddleware } from "../security/permission.middleware.js";

describe("PermissionMiddleware.checkRoute() — auth PUBLIC_PATHS coverage", () => {
  it("allows POST /api/v1/auth/register/db with no principal -- the bug this fix closes", () => {
    const result = permissionMiddleware.checkRoute("POST", "/api/v1/auth/register/db", null);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("public path");
  });

  it("still allows the bare /api/v1/auth/register path with no principal", () => {
    const result = permissionMiddleware.checkRoute("POST", "/api/v1/auth/register", null);
    expect(result.allowed).toBe(true);
  });

  it("still allows /api/v1/auth/login and /api/v1/auth/login/db with no principal (unchanged, already-correct behavior)", () => {
    expect(permissionMiddleware.checkRoute("POST", "/api/v1/auth/login", null).allowed).toBe(true);
    expect(permissionMiddleware.checkRoute("POST", "/api/v1/auth/login/db", null).allowed).toBe(true);
  });

  it("does NOT make an unrelated, genuinely-protected route public just because it starts similarly", () => {
    // Sanity check that the fix's un-anchored regex didn't overreach --
    // a real user-data route must still require authentication.
    const result = permissionMiddleware.checkRoute("GET", "/api/v1/wallet", null);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("unauthenticated");
  });

  it("does NOT make the 2FA verify/login-completion route public (only /2fa/setup is, deliberately)", () => {
    const result = permissionMiddleware.checkRoute("POST", "/api/v1/auth/2fa/verify", null);
    expect(result.allowed).toBe(false);
  });
});

describe("PermissionMiddleware.checkRoute() — real health-check endpoints must be reachable with no principal", () => {
  // PRODUCTION CUTOVER Stage 3 — found via live shadow-environment testing:
  // docker-compose.prod.yml's healthcheck was repointed at /api/health
  // (real DB/Redis checks, shared/health.check.ts) instead of /health
  // (process-alive only) earlier this same Stage -- but /^\/health/ only
  // matches the bare path, not /api/health or /api/v1/health, so every
  // healthcheck invocation (including Docker's own, confirmed live from
  // inside the running container) got 403 FORBIDDEN "unauthenticated."
  // An orchestrator's health probe never carries a JWT -- a health
  // endpoint gated on authentication cannot function as a healthcheck.
  it("allows GET /api/health with no principal", () => {
    const result = permissionMiddleware.checkRoute("GET", "/api/health", null);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("public path");
  });

  it("allows GET /api/v1/health with no principal", () => {
    const result = permissionMiddleware.checkRoute("GET", "/api/v1/health", null);
    expect(result.allowed).toBe(true);
  });

  it("still allows the original bare /health path with no principal (unchanged)", () => {
    expect(permissionMiddleware.checkRoute("GET", "/health", null).allowed).toBe(true);
  });
});
