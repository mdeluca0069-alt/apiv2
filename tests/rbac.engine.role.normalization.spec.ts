/**
 * tests/rbac.engine.role.normalization.spec.ts
 *
 * FASE 7 CLOSURE, Phase D — regression coverage for a real, previously
 * undetected RBAC bug: the live role vocabulary issued end-to-end
 * (auth-service/auth.service.ts's JWTs, reconstructed by
 * shared/state.ts's resolvePrincipal) is short-form and lowercase
 * ("trader"/"admin"/"super_admin"/"risk"/"compliance"). rbac.engine.ts's
 * authorize() uppercased roles before comparing against RoleName, which
 * correctly resolves "admin"->"ADMIN" and "super_admin"->"SUPER_ADMIN" but
 * NOT "risk"->"RISK" (RoleName uses "RISK_MANAGER") or
 * "compliance"->"COMPLIANCE" (RoleName uses "COMPLIANCE_OFFICER") --
 * meaning a risk-manager-only or compliance-officer-only staff account
 * (no "admin" role) was silently granted ZERO permissions by every
 * permission.middleware.ts-protected route (~30 registered routes,
 * confirmed the sole enforcement layer), always failing closed. Not a
 * privilege-escalation or bypass vector (confirmed: the mismatch always
 * contributes zero permissions, never grants), but a real, live
 * availability/correctness bug for exactly those two roles.
 */
import { describe, it, expect } from "vitest";
import { rbacEngine, normalizeRole } from "../security/rbac.engine.js";

describe("normalizeRole()", () => {
  it("maps the real lowercase/short-form JWT role vocabulary to canonical RoleName", () => {
    expect(normalizeRole("trader")).toBe("TRADER");
    expect(normalizeRole("admin")).toBe("ADMIN");
    expect(normalizeRole("super_admin")).toBe("SUPER_ADMIN");
    // The two that were previously broken:
    expect(normalizeRole("risk")).toBe("RISK_MANAGER");
    expect(normalizeRole("compliance")).toBe("COMPLIANCE_OFFICER");
  });

  it("is a no-op for already-canonical RoleName values (rbacEngine.allRoles-driven callers)", () => {
    for (const role of rbacEngine.allRoles) {
      expect(normalizeRole(role)).toBe(role);
    }
  });
});

describe("RBACEngine.authorize() — risk/compliance role regression", () => {
  it("grants a risk-only account (JWT role \"risk\", no \"admin\") the RISK_MANAGER permission set", () => {
    const result = rbacEngine.authorize({
      userId: "u1", roles: ["risk"] as unknown as import("../security/rbac.engine.js").RoleName[], resource: "risk", action: "write",
    });
    expect(result.allowed).toBe(true);
  });

  it("grants a compliance-only account (JWT role \"compliance\", no \"admin\") the COMPLIANCE_OFFICER permission set", () => {
    const result = rbacEngine.authorize({
      userId: "u1", roles: ["compliance"] as unknown as import("../security/rbac.engine.js").RoleName[], resource: "compliance", action: "write",
    });
    expect(result.allowed).toBe(true);
  });

  it("still correctly denies a bare trader from risk:write (proves the fix didn't over-grant)", () => {
    const result = rbacEngine.authorize({
      userId: "u1", roles: ["trader"] as unknown as import("../security/rbac.engine.js").RoleName[], resource: "risk", action: "write",
    });
    expect(result.allowed).toBe(false);
  });

  it("a multi-role account (admin + compliance + risk, matching prisma/seed.ts's admin user) still gets full access", () => {
    const result = rbacEngine.authorize({
      userId: "u1", roles: ["admin", "compliance", "risk"] as unknown as import("../security/rbac.engine.js").RoleName[], resource: "capital", action: "approve",
    });
    expect(result.allowed).toBe(true);
  });
});

describe("RBACEngine.getEffectivePermissions() — GET /api/v1/security/status regression", () => {
  it("returns a non-empty permission list for real lowercase JWT roles (previously always empty via an unsafe `as never` cast)", () => {
    const perms = rbacEngine.getEffectivePermissions(["risk"]);
    expect(perms.length).toBeGreaterThan(0);
    expect(perms).toContain("risk:write:all");
  });

  it("is unaffected for rbacEngine.allRoles-driven callers (GET /api/v1/admin/security/rbac-matrix)", () => {
    for (const role of rbacEngine.allRoles) {
      expect(rbacEngine.getEffectivePermissions([role]).length).toBeGreaterThan(0);
    }
  });
});
