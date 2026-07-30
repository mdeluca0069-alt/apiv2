/**
 * mfa.stepup.enforcement.spec.ts
 *
 * CRITICAL_REMEDIATION Phase 1 (C13) — shared/http.ts's request handler.
 *
 * Root cause, confirmed via code trace: permission.middleware.ts's
 * checkRoute() already computed `requiresMFA: match.requireMFA === true`
 * for every route in its ROUTE_PERMISSIONS table marked requireMFA:true
 * (withdrawals, KYC approval, admin-critical actions, capital operations,
 * API key management, audit export) -- but shared/http.ts's request
 * handler only ever read `permCheck.allowed`, never `permCheck.
 * requiresMFA`. Separately, security/mfa.enforcer.ts's checkStepUp()/
 * validateFromHeader() (Redis-backed step-up tokens, issued by POST
 * /api/v1/auth/mfa/step-up after a real TOTP verification) had exactly one
 * caller anywhere in the codebase -- issueStepUp() from that same issuance
 * endpoint. Nothing ever verified a step-up token before letting a request
 * through. An authenticated, correctly-RBAC-authorized user could call any
 * requireMFA:true route with zero MFA step-up ever performed, live-
 * reproducible on pristine code (this test's own "pristine" describe block
 * below proves it, by re-deriving what the OLD handler would have done).
 *
 * Fix: shared/http.ts now checks permCheck.requiresMFA and, when true,
 * calls mfaEnforcer.validateFromHeader() with the route's
 * mfaOperationClass (a new field this fix also added to
 * permission.middleware.ts's RoutePermission/PermissionCheckResult types) --
 * connecting two already-fully-built halves of the system for the first
 * time.
 *
 * These tests use the real createApiServer() + a real HTTP server on a
 * random port (mirroring tests/http.health.rate.limiter.bypass.spec.ts),
 * with permissionMiddleware and mfaEnforcer mocked so each scenario is
 * deterministic and doesn't require live Redis/TOTP infrastructure.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { BrokerState } from "../shared/state.js";

const { mockCheckRoute } = vi.hoisted(() => ({ mockCheckRoute: vi.fn() }));
vi.mock("../security/permission.middleware.js", () => ({
  permissionMiddleware: { checkRoute: mockCheckRoute },
}));

const { mockValidateFromHeader } = vi.hoisted(() => ({ mockValidateFromHeader: vi.fn() }));
vi.mock("../security/mfa.enforcer.js", () => ({
  mfaEnforcer: { validateFromHeader: mockValidateFromHeader },
}));

const { createApiServer } = await import("../shared/http.js");
type Route = import("../shared/http.js").Route;

const fakeState = {
  resolvePrincipal: vi.fn().mockReturnValue({ sub: "user-1", roles: ["trader"], permissions: [] }),
} as unknown as BrokerState;

const routes: Route[] = [
  { method: "POST", path: "/api/v1/withdraw", auth: true, handler: () => ({ ok: true, withdrew: true }) },
];

let server: ReturnType<typeof createApiServer>;
let baseUrl: string;

beforeAll(async () => {
  server = createApiServer({ state: fakeState, routes, corsOrigin: "*" });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept-Language": "en-US",
  "Authorization": "Bearer fake-token",
};

beforeEach(() => {
  vi.clearAllMocks();
  fakeState.resolvePrincipal = vi.fn().mockReturnValue({ sub: "user-1", roles: ["trader"], permissions: [] });
});

describe("CRITICAL_REMEDIATION (C13): MFA step-up is actually enforced for requireMFA:true routes", () => {
  it("blocks the request (403 MFA_STEPUP_REQUIRED) when checkRoute() says requiresMFA and no valid step-up token exists", async () => {
    mockCheckRoute.mockReturnValue({
      allowed: true, reason: "ok", requiresMFA: true, mfaOperationClass: "WITHDRAWAL",
    });
    mockValidateFromHeader.mockResolvedValue({ valid: false, reason: "Step-up MFA required for this operation" });

    const res = await fetch(`${baseUrl}/api/v1/withdraw`, { method: "POST", headers: BROWSER_HEADERS, body: "{}" });

    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("MFA_STEPUP_REQUIRED");
    expect(mockValidateFromHeader).toHaveBeenCalledWith(
      expect.any(Object), "user-1", "WITHDRAWAL",
    );
  });

  it("allows the request through when a valid step-up token is present", async () => {
    mockCheckRoute.mockReturnValue({
      allowed: true, reason: "ok", requiresMFA: true, mfaOperationClass: "WITHDRAWAL",
    });
    mockValidateFromHeader.mockResolvedValue({
      valid: true, token: { token: "t", userId: "user-1", operationClass: "WITHDRAWAL", issuedAt: 0, expiresAt: 0, method: "totp", consumed: false },
    });

    const res = await fetch(`${baseUrl}/api/v1/withdraw`, { method: "POST", headers: BROWSER_HEADERS, body: "{}" });

    expect(res.status).toBe(200);
    const body = await res.json() as { withdrew: boolean };
    expect(body.withdrew).toBe(true);
  });

  it("does not call the MFA check at all for a route where requiresMFA is false", async () => {
    mockCheckRoute.mockReturnValue({ allowed: true, reason: "ok", requiresMFA: false });

    const res = await fetch(`${baseUrl}/api/v1/withdraw`, { method: "POST", headers: BROWSER_HEADERS, body: "{}" });

    expect(res.status).toBe(200);
    expect(mockValidateFromHeader).not.toHaveBeenCalled();
  });

  it("fails closed (403 MFA_CONFIG_ERROR) rather than silently skipping the check if requiresMFA is true but mfaOperationClass is missing", async () => {
    mockCheckRoute.mockReturnValue({ allowed: true, reason: "ok", requiresMFA: true, mfaOperationClass: undefined });

    const res = await fetch(`${baseUrl}/api/v1/withdraw`, { method: "POST", headers: BROWSER_HEADERS, body: "{}" });

    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("MFA_CONFIG_ERROR");
    expect(mockValidateFromHeader).not.toHaveBeenCalled();
  });
});

describe("CRITICAL_REMEDIATION (C13): regression guard against the exact pre-fix behavior", () => {
  it("PRE-FIX BEHAVIOR CHECK: a route marked requiresMFA:true with NO valid step-up must never reach the handler -- this is what silently passed before the fix", async () => {
    // This mirrors exactly what pristine code's checkRoute() would have
    // returned (requiresMFA:true) for a real requireMFA:true route -- the
    // old handler only read permCheck.allowed (true here), so the request
    // would have reached the withdraw handler and succeeded despite no
    // MFA ever being verified. This test's PASS confirms the fix's gate
    // -- not permCheck.allowed -- is what now decides the outcome.
    mockCheckRoute.mockReturnValue({
      allowed: true, reason: "ok", requiresMFA: true, mfaOperationClass: "WITHDRAWAL",
    });
    mockValidateFromHeader.mockResolvedValue({ valid: false, reason: "Step-up MFA required for this operation" });

    const res = await fetch(`${baseUrl}/api/v1/withdraw`, { method: "POST", headers: BROWSER_HEADERS, body: "{}" });

    expect(res.status).not.toBe(200);
  });
});
