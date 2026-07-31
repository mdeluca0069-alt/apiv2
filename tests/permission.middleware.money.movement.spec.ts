/**
 * permission.middleware.money.movement.spec.ts
 *
 * PHASE2_REMEDIATION (H16/N1) — a full admin-route RBAC audit found that
 * POST /admin/deposits/:id/{approve,reject} and /admin/withdrawals/:id/
 * {approve,reject} -- the actual money-movement authorization points --
 * matched no ROUTE_PERMISSIONS entry at all: any of admin/risk/compliance/
 * super_admin could approve a real withdrawal with no RBAC restriction and
 * no MFA step-up, despite POST /api/v1/withdraw (the client-initiated
 * side) already requiring CRITICAL+MFA.
 *
 * The same audit found three ROUTE_PERMISSIONS entries (/admin/users,
 * /admin/trading/pause, /admin/settings) that matched NO real route
 * anywhere in gateway/routes.ts -- dead rules giving a false sense of
 * coverage while the actual routes they were presumably meant to cover
 * (/admin/client-accounts, /admin/client/:email, /admin/client/tier,
 * /admin/client/kyc, /admin/trading/kill-switch, /admin/broker/spread)
 * had zero fine-grained protection. /admin/client/kyc specifically was a
 * segregation-of-duties BYPASS: it sets kycStatus directly and was
 * reachable by any of the 4 roles, while the "official" KYC approval flow
 * was already correctly RBAC-restricted to kyc:approve (RISK_MANAGER
 * excluded).
 *
 * These tests call permissionMiddleware.checkRoute() directly (mirroring
 * tests/permission.middleware.public.paths.spec.ts's established
 * pattern), using lowercase role strings to match the real shape JWTs
 * issue in this codebase (rbac.engine.ts's normalizeRole() canonicalizes
 * them internally).
 */
import { describe, it, expect } from "vitest";
import { permissionMiddleware } from "../security/permission.middleware.js";
import type { TokenPayload } from "../shared/security.js";

function principal(roles: string[]): TokenPayload {
  return { sub: "staff-1", email: "staff@igfxpro.com", tenantId: "tenant_igfxpro", roles, permissions: [] } as unknown as TokenPayload;
}

describe("PHASE2_REMEDIATION (H16/N1): admin deposit/withdrawal approval RBAC + MFA", () => {
  it("POST /admin/withdrawals/:id/approve requires MFA and is allowed for admin", () => {
    const result = permissionMiddleware.checkRoute("POST", "/api/v1/admin/withdrawals/entry-1/approve", principal(["admin"]));
    expect(result.allowed).toBe(true);
    expect(result.requiresMFA).toBe(true);
    expect(result.mfaOperationClass).toBe("WITHDRAWAL");
  });

  it("POST /admin/withdrawals/:id/approve is DENIED for risk-only staff -- wallet:write is not granted to RISK_MANAGER", () => {
    const result = permissionMiddleware.checkRoute("POST", "/api/v1/admin/withdrawals/entry-1/approve", principal(["risk"]));
    expect(result.allowed).toBe(false);
  });

  it("POST /admin/withdrawals/:id/approve is DENIED for compliance-only staff -- wallet:write is not granted to COMPLIANCE_OFFICER", () => {
    const result = permissionMiddleware.checkRoute("POST", "/api/v1/admin/withdrawals/entry-1/approve", principal(["compliance"]));
    expect(result.allowed).toBe(false);
  });

  it("POST /admin/deposits/:id/approve requires MFA and is allowed for admin", () => {
    const result = permissionMiddleware.checkRoute("POST", "/api/v1/admin/deposits/entry-2/approve", principal(["admin"]));
    expect(result.allowed).toBe(true);
    expect(result.requiresMFA).toBe(true);
    expect(result.mfaOperationClass).toBe("CAPITAL_OPERATION");
  });

  it("POST /admin/deposits/:id/approve is DENIED for risk-only staff", () => {
    const result = permissionMiddleware.checkRoute("POST", "/api/v1/admin/deposits/entry-2/approve", principal(["risk"]));
    expect(result.allowed).toBe(false);
  });

  it("reject routes are RBAC-restricted the same as approve, but do not require MFA (no money moves)", () => {
    const withdrawReject = permissionMiddleware.checkRoute("POST", "/api/v1/admin/withdrawals/entry-1/reject", principal(["admin"]));
    expect(withdrawReject.allowed).toBe(true);
    expect(withdrawReject.requiresMFA).toBeFalsy();

    const deniedForRisk = permissionMiddleware.checkRoute("POST", "/api/v1/admin/withdrawals/entry-1/reject", principal(["risk"]));
    expect(deniedForRisk.allowed).toBe(false);
  });

  it("super_admin can approve (universal access)", () => {
    const result = permissionMiddleware.checkRoute("POST", "/api/v1/admin/withdrawals/entry-1/approve", principal(["super_admin"]));
    expect(result.allowed).toBe(true);
  });
});

describe("PHASE2_REMEDIATION (H16): dead ROUTE_PERMISSIONS rules repointed to real routes", () => {
  it("GET /admin/client-accounts is now covered (was previously matched by the dead /admin/users rule)", () => {
    const result = permissionMiddleware.checkRoute("GET", "/api/v1/admin/client-accounts", principal(["compliance"]));
    expect(result.allowed).toBe(true); // users:read:all is granted broadly
  });

  it("GET /admin/client/:email is now covered", () => {
    const result = permissionMiddleware.checkRoute("GET", "/api/v1/admin/client/trader@example.com", principal(["risk"]));
    expect(result.allowed).toBe(true);
  });

  it("POST /admin/client/tier requires MFA and admin-level RBAC", () => {
    const result = permissionMiddleware.checkRoute("POST", "/api/v1/admin/client/tier", principal(["admin"]));
    expect(result.allowed).toBe(true);
    expect(result.requiresMFA).toBe(true);
  });

  it("CRITICAL_REMEDIATION (H16): POST /admin/client/kyc -- the segregation-of-duties bypass route -- now requires kyc:approve, denying risk-only staff exactly like the official KYC approval endpoint", () => {
    const forRisk = permissionMiddleware.checkRoute("POST", "/api/v1/admin/client/kyc", principal(["risk"]));
    expect(forRisk.allowed).toBe(false);

    const forCompliance = permissionMiddleware.checkRoute("POST", "/api/v1/admin/client/kyc", principal(["compliance"]));
    expect(forCompliance.allowed).toBe(true);
    expect(forCompliance.requiresMFA).toBe(true);
    expect(forCompliance.mfaOperationClass).toBe("KYC_APPROVAL");

    const forAdmin = permissionMiddleware.checkRoute("POST", "/api/v1/admin/client/kyc", principal(["admin"]));
    expect(forAdmin.allowed).toBe(true);
  });

  it("POST /admin/trading/kill-switch (the admin path) now matches the same risk:override rule as its non-admin sibling, denying compliance-only staff", () => {
    const forCompliance = permissionMiddleware.checkRoute("POST", "/api/v1/admin/trading/kill-switch", principal(["compliance"]));
    expect(forCompliance.allowed).toBe(false);

    const forRisk = permissionMiddleware.checkRoute("POST", "/api/v1/admin/trading/kill-switch", principal(["risk"]));
    expect(forRisk.allowed).toBe(true);
    expect(forRisk.requiresMFA).toBe(true);
  });

  it("POST /admin/broker/spread now requires settings:configure (admin-only) instead of the dead /admin/settings rule", () => {
    const forAdmin = permissionMiddleware.checkRoute("POST", "/api/v1/admin/broker/spread", principal(["admin"]));
    expect(forAdmin.allowed).toBe(true);
    expect(forAdmin.requiresMFA).toBe(true);

    // settings:configure:all is only granted to ADMIN in rbac.engine.ts's
    // matrix -- RISK_MANAGER/COMPLIANCE_OFFICER only have settings:read.
    const forRisk = permissionMiddleware.checkRoute("POST", "/api/v1/admin/broker/spread", principal(["risk"]));
    expect(forRisk.allowed).toBe(false);
  });

  it("DELETE /admin/users no longer matches anything (the dead rule is removed, not repointed -- no real DELETE admin route exists)", () => {
    const result = permissionMiddleware.checkRoute("DELETE", "/api/v1/admin/users/some-id", principal(["admin"]));
    // Falls through to "no route-level permission rule" -- still requires
    // authentication (checked earlier in the pipeline) but this specific
    // rule no longer fires since nothing in routes.ts is a DELETE /admin/users.
    expect(result.reason).toBe("no route-level permission rule — base auth sufficient");
  });
});
