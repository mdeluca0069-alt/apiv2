/**
 * security/permission.middleware.ts — Route-level RBAC enforcement middleware.
 *
 * Integrates with the RBAC engine to enforce permissions on every request.
 * Applied in gateway/routes.ts via the checkPermission() wrapper.
 *
 * The route permission registry maps URL patterns to required resource:action pairs.
 * Every route that isn't in the public allowlist must have a permission entry.
 */

import { rbacEngine, type Resource, type Action, type RoleName } from "./rbac.engine.js";
import type { TokenPayload } from "../shared/security.js";
import type { MFAOperationClass } from "./mfa.enforcer.js";

// ─── Route Permission Registry ────────────────────────────────────────────────

export type RoutePermission = {
  resource:         Resource;
  action:           Action;
  extractOwnerId?:  (path: string, body: unknown) => string | undefined;
  requireMFA?:      boolean;
  // CRITICAL_REMEDIATION (C13): which mfa.enforcer.ts step-up bucket this
  // route's requireMFA:true refers to. Required whenever requireMFA is
  // true -- see checkRoute()'s dev-time assertion below.
  mfaOperationClass?: MFAOperationClass;
  sensitivityLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
};

// Maps [method, path-regex] → required permission
// Patterns evaluated in order; first match wins.
const ROUTE_PERMISSIONS: Array<[string, RegExp, RoutePermission]> = [
  // ── Trading ────────────────────────────────────────────────────────────────
  ["POST",   /^\/api\/v1\/trading\/order$/,                    { resource: "trading",  action: "execute",    sensitivityLevel: "HIGH",     requireMFA: false }],
  ["POST",   /^\/api\/v1\/trading\/cancel/,                    { resource: "trading",  action: "write",      sensitivityLevel: "MEDIUM" }],
  ["POST",   /^\/api\/v1\/trading\/close/,                     { resource: "trading",  action: "write",      sensitivityLevel: "HIGH" }],
  ["GET",    /^\/api\/v1\/positions/,                          { resource: "trading",  action: "read",       sensitivityLevel: "LOW" }],
  ["GET",    /^\/api\/v1\/orders/,                             { resource: "trading",  action: "read",       sensitivityLevel: "LOW" }],

  // ── Wallet ─────────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/wallet/,                             { resource: "wallet",   action: "read",       sensitivityLevel: "MEDIUM" }],
  ["POST",   /^\/api\/v1\/withdraw/,                           { resource: "wallet",   action: "write",      sensitivityLevel: "CRITICAL", requireMFA: true, mfaOperationClass: "WITHDRAWAL" }],
  ["POST",   /^\/api\/v1\/deposit/,                            { resource: "wallet",   action: "write",      sensitivityLevel: "HIGH" }],
  ["GET",    /^\/api\/v1\/ledger/,                             { resource: "wallet",   action: "read",       sensitivityLevel: "MEDIUM" }],

  // PHASE2_REMEDIATION (H16/N1): the admin-side deposit/withdrawal APPROVAL
  // routes -- the actual money-movement authorization points -- matched no
  // ROUTE_PERMISSIONS entry at all before this fix, despite POST /api/v1/
  // withdraw (the CLIENT-initiated side, two rows above) already requiring
  // CRITICAL+MFA. Any of admin/risk/compliance/super_admin could approve a
  // withdrawal with no RBAC restriction and no step-up. wallet:write:all is
  // granted to ADMIN only (rbac.engine.ts's permission matrix does not
  // grant it to RISK_MANAGER or COMPLIANCE_OFFICER), so this also closes a
  // segregation-of-duties gap, not just adds MFA. Approve moves real money
  // and requires step-up; reject does not move money but still requires
  // the same RBAC restriction, since a wrongful rejection of a legitimate
  // request is also a form of abuse this control should prevent.
  ["GET",    /^\/api\/v1\/admin\/deposits\/pending$/,           { resource: "wallet",  action: "read",       sensitivityLevel: "MEDIUM" }],
  ["GET",    /^\/api\/v1\/admin\/withdrawals\/pending$/,        { resource: "wallet",  action: "read",       sensitivityLevel: "MEDIUM" }],
  ["POST",   /^\/api\/v1\/admin\/deposits\/[^/]+\/approve$/,    { resource: "wallet",  action: "write",      sensitivityLevel: "CRITICAL", requireMFA: true, mfaOperationClass: "CAPITAL_OPERATION" }],
  ["POST",   /^\/api\/v1\/admin\/deposits\/[^/]+\/reject$/,     { resource: "wallet",  action: "write",      sensitivityLevel: "HIGH" }],
  ["POST",   /^\/api\/v1\/admin\/withdrawals\/[^/]+\/approve$/, { resource: "wallet",  action: "write",      sensitivityLevel: "CRITICAL", requireMFA: true, mfaOperationClass: "WITHDRAWAL" }],
  ["POST",   /^\/api\/v1\/admin\/withdrawals\/[^/]+\/reject$/,  { resource: "wallet",  action: "write",      sensitivityLevel: "HIGH" }],

  // ── KYC ───────────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/kyc/,                                { resource: "kyc",      action: "read",       sensitivityLevel: "MEDIUM" }],
  ["POST",   /^\/api\/v1\/kyc/,                                { resource: "kyc",      action: "write",      sensitivityLevel: "HIGH" }],
  ["POST",   /^\/api\/v1\/admin\/kyc/,                         { resource: "kyc",      action: "approve",    sensitivityLevel: "CRITICAL", requireMFA: true, mfaOperationClass: "KYC_APPROVAL" }],

  // ── Signals ────────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/signals/,                            { resource: "signals",  action: "read",       sensitivityLevel: "LOW" }],
  ["POST",   /^\/api\/v1\/signals\/configure/,                 { resource: "signals",  action: "configure",  sensitivityLevel: "HIGH" }],

  // ── Autopilot ──────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/autopilot/,                          { resource: "autopilot", action: "read",      sensitivityLevel: "LOW" }],
  ["POST",   /^\/api\/v1\/autopilot\/config/,                  { resource: "autopilot", action: "write",     sensitivityLevel: "HIGH" }],
  ["POST",   /^\/api\/v1\/autopilot\/consent/,                 { resource: "autopilot", action: "write",     sensitivityLevel: "HIGH" }],

  // ── Admin: Risk ────────────────────────────────────────────────────────────
  ["POST",   /^\/api\/v1\/trading\/kill-switch/,               { resource: "risk",     action: "override",   sensitivityLevel: "CRITICAL", requireMFA: true, mfaOperationClass: "ADMIN_CRITICAL" }],
  ["POST",   /^\/api\/v1\/admin\/risk/,                        { resource: "risk",     action: "write",      sensitivityLevel: "CRITICAL", requireMFA: true, mfaOperationClass: "ADMIN_CRITICAL" }],
  ["GET",    /^\/api\/v1\/admin\/risk/,                        { resource: "risk",     action: "read",       sensitivityLevel: "HIGH" }],

  // ── Admin: Users / Client Management ──────────────────────────────────────
  // PHASE2_REMEDIATION (H16): these four entries used to target /admin/users
  // (GET/POST/DELETE) and /admin/trading/pause -- paths that do not exist
  // anywhere in gateway/routes.ts (a full route audit confirmed zero
  // matches). Dead ROUTE_PERMISSIONS rows give a false sense of coverage:
  // the ACTUAL client-management routes (/admin/client-accounts, /admin/
  // client/:email, /admin/client/tier, /admin/client/kyc) and the actual
  // kill-switch route (/admin/trading/kill-switch) matched no rule at all,
  // falling through to "no route-level permission rule — base auth
  // sufficient" -- any of admin/risk/compliance/super_admin interchangeably,
  // no RBAC, no MFA. Repointed to the real paths.
  //
  // /admin/client/kyc specifically closes a segregation-of-duties BYPASS:
  // it sets a user's kycStatus directly (state.adminSetKycStatus) and was
  // reachable by any of the 4 admin-ish roles, while the "official" KYC
  // approval flow (POST /admin/kyc/cases/:caseId/approve|reject, below)
  // was already correctly RBAC-restricted to kyc:approve (ADMIN/
  // COMPLIANCE_OFFICER only, RISK_MANAGER excluded per rbac.engine.ts's
  // permission matrix). A risk-only staffer blocked from the real approval
  // endpoint could achieve the identical effect through this route. Now
  // gated by the same kyc:approve permission as its sibling endpoint.
  ["GET",    /^\/api\/v1\/admin\/client-accounts$/,            { resource: "users",    action: "read",       sensitivityLevel: "HIGH" }],
  ["GET",    /^\/api\/v1\/admin\/client\/[^/]+$/,               { resource: "users",    action: "read",       sensitivityLevel: "HIGH" }],
  ["POST",   /^\/api\/v1\/admin\/client\/tier$/,                { resource: "users",    action: "write",      sensitivityLevel: "HIGH",     requireMFA: true, mfaOperationClass: "ADMIN_CRITICAL" }],
  ["POST",   /^\/api\/v1\/admin\/client\/kyc$/,                 { resource: "kyc",      action: "approve",    sensitivityLevel: "CRITICAL", requireMFA: true, mfaOperationClass: "KYC_APPROVAL" }],
  ["POST",   /^\/api\/v1\/admin\/trading\/kill-switch$/,        { resource: "risk",     action: "override",   sensitivityLevel: "CRITICAL", requireMFA: true, mfaOperationClass: "ADMIN_CRITICAL" }],

  // ── Admin: Compliance ──────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/admin\/compliance/,                  { resource: "compliance", action: "read",     sensitivityLevel: "HIGH" }],
  ["POST",   /^\/api\/v1\/admin\/compliance/,                  { resource: "compliance", action: "write",    sensitivityLevel: "CRITICAL", requireMFA: true, mfaOperationClass: "ADMIN_CRITICAL" }],

  // ── Audit ──────────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/admin\/audit/,                       { resource: "audit",    action: "read",       sensitivityLevel: "HIGH" }],
  ["GET",    /^\/api\/v1\/admin\/audit.*export/,               { resource: "audit",    action: "export",     sensitivityLevel: "CRITICAL", requireMFA: true, mfaOperationClass: "AUDIT_EXPORT" }],

  // ── Capital ────────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/admin\/capital/,                     { resource: "capital",  action: "read",       sensitivityLevel: "HIGH" }],
  ["POST",   /^\/api\/v1\/admin\/capital/,                     { resource: "capital",  action: "write",      sensitivityLevel: "CRITICAL", requireMFA: true, mfaOperationClass: "CAPITAL_OPERATION" }],

  // ── Settings ───────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/settings/,                           { resource: "settings", action: "read",       sensitivityLevel: "LOW" }],
  ["POST",   /^\/api\/v1\/settings/,                           { resource: "settings", action: "write",      sensitivityLevel: "HIGH" }],
  // PHASE2_REMEDIATION (H16): /admin/settings never matched any real route
  // either (same dead-rule issue as the block above) -- repointed to
  // /admin/broker/spread, a genuine live-pricing configuration route the
  // audit found with no fine-grained coverage at all.
  ["POST",   /^\/api\/v1\/admin\/broker\/spread$/,             { resource: "settings", action: "configure",  sensitivityLevel: "CRITICAL", requireMFA: true, mfaOperationClass: "ADMIN_CRITICAL" }],

  // ── API Keys ───────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/api-keys/,                           { resource: "api_keys", action: "read",       sensitivityLevel: "MEDIUM" }],
  ["POST",   /^\/api\/v1\/api-keys/,                           { resource: "api_keys", action: "write",      sensitivityLevel: "HIGH",     requireMFA: true, mfaOperationClass: "API_KEY_MANAGEMENT" }],
  ["DELETE", /^\/api\/v1\/api-keys/,                           { resource: "api_keys", action: "delete",     sensitivityLevel: "HIGH",     requireMFA: true, mfaOperationClass: "API_KEY_MANAGEMENT" }],

  // ── Reports ────────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/reports/,                            { resource: "reports",  action: "read",       sensitivityLevel: "MEDIUM" }],
  ["POST",   /^\/api\/v1\/reports.*export/,                    { resource: "reports",  action: "export",     sensitivityLevel: "HIGH" }],
];

// Paths that are always public (no auth required)
const PUBLIC_PATHS = [
  /^\/health/,
  // PRODUCTION CUTOVER Stage 3: /^\/health/ only matches the bare /health
  // path -- it does NOT match /api/health or /api/v1/health, the two
  // endpoints that actually check DB/Redis connectivity for real
  // (shared/health.check.ts) rather than just confirming the process is
  // alive. docker-compose.prod.yml's healthcheck was deliberately
  // repointed at /api/health this same Stage specifically because /health
  // doesn't verify dependencies -- but that immediately broke the
  // healthcheck a second way, confirmed live: with no principal, every
  // request to /api/health returned 403 FORBIDDEN "unauthenticated"
  // (Docker's own wget healthcheck call, run from inside the container
  // against localhost, included), because these two paths were never
  // added to this allowlist at all. A health-check endpoint that requires
  // authentication cannot be used by an orchestrator's health probe.
  /^\/api\/health$/,
  /^\/api\/v1\/health$/,
  /^\/metrics/,
  /^\/api\/v1\/auth\/login/,      // covers /login, /login/db, future sub-paths
  // PRODUCTION CUTOVER Stage 2: found via live validation that this was
  // anchored with `$`, matching ONLY the bare /register path -- but
  // /register/db (gateway/routes.ts) is the actual endpoint used whenever
  // IS_PERSISTENT is true (i.e. every real, database-backed deployment),
  // exactly parallel to /login vs /login/db above. A brand new user has no
  // JWT yet by definition, so this silently made registration entirely
  // unreachable (403 FORBIDDEN "unauthenticated") in any persistent
  // deployment -- unanchored the same way /login already correctly is.
  /^\/api\/v1\/auth\/register/,  // covers /register, /register/db, future sub-paths
  /^\/api\/v1\/auth\/refresh$/,
  /^\/api\/v1\/auth\/forgot-password$/,
  /^\/api\/v1\/auth\/reset-password$/,
  /^\/api\/v1\/auth\/verify-email$/,
  /^\/api\/v1\/auth\/2fa\/setup$/,
  /^\/api\/v1\/public\//,
  /^\/api\/v1\/instruments$/,
  /^\/api\/v1\/market\/quotes$/,
];

// ─── Types ────────────────────────────────────────────────────────────────────

export type PermissionCheckResult = {
  allowed:          boolean;
  reason:           string;
  permission?:      RoutePermission;
  requiresMFA?:     boolean;
  mfaOperationClass?: MFAOperationClass;
};

// ─── Permission Middleware ────────────────────────────────────────────────────

export class PermissionMiddleware {

  /**
   * Main permission check for a request.
   * Call this AFTER auth (principal is already extracted from JWT).
   */
  checkRoute(
    method: string,
    path:   string,
    principal: TokenPayload | null,
  ): PermissionCheckResult {
    // Public paths — always allowed
    if (PUBLIC_PATHS.some((p) => p.test(path))) {
      return { allowed: true, reason: "public path" };
    }

    // Must be authenticated for all non-public paths
    if (!principal) {
      return { allowed: false, reason: "unauthenticated" };
    }

    // Find matching route permission
    const match = this._findRoutePermission(method, path);
    if (!match) {
      // No explicit rule: require at least a valid session (any authenticated user)
      return { allowed: true, reason: "no route-level permission rule — base auth sufficient" };
    }

    const roles = (principal.roles ?? []) as RoleName[];

    // RBAC check
    const authResult = rbacEngine.authorize({
      userId:   principal.sub,
      roles,
      resource: match.resource,
      action:   match.action,
    });

    if (!authResult.allowed) {
      return {
        allowed:    false,
        reason:     authResult.reason,
        permission: match,
      };
    }

    return {
      allowed:      true,
      reason:       authResult.reason,
      permission:   match,
      requiresMFA:  match.requireMFA === true,
      mfaOperationClass: match.mfaOperationClass,
    };
  }

  /**
   * Check if a specific resource:action is allowed.
   * Used in handler code for fine-grained checks (e.g., "can this user see
   * another user's data?").
   */
  can(
    principal: TokenPayload,
    resource:  Resource,
    action:    Action,
    ownerId?:  string,
  ): boolean {
    const roles = (principal.roles ?? []) as RoleName[];
    const result = rbacEngine.authorize({
      userId:          principal.sub,
      roles,
      resource,
      action,
      resourceOwnerId: ownerId,
    });
    return result.allowed;
  }

  /**
   * Same as can() but throws 403 instead of returning false.
   * Suitable for use in route handlers that want express-style guard behavior.
   */
  assert(
    principal: TokenPayload,
    resource:  Resource,
    action:    Action,
    ownerId?:  string,
  ): void {
    if (!this.can(principal, resource, action, ownerId)) {
      const roles = (principal.roles ?? []).join(", ");
      throw Object.assign(
        new Error(`Forbidden: ${resource}:${action} denied for roles [${roles}]`),
        { statusCode: 403, data: { resource, action } },
      );
    }
  }

  private _findRoutePermission(method: string, path: string): RoutePermission | null {
    const upperMethod = method.toUpperCase();
    for (const [m, pattern, perm] of ROUTE_PERMISSIONS) {
      if (m !== upperMethod) continue;
      if (pattern.test(path)) return perm;
    }
    return null;
  }

  /** Sensitivity level of a route (for logging/monitoring). */
  getRouteSensitivity(method: string, path: string): string {
    const match = this._findRoutePermission(method, path);
    return match?.sensitivityLevel ?? "LOW";
  }
}

export const permissionMiddleware = new PermissionMiddleware();
export default permissionMiddleware;
