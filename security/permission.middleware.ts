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

// ─── Route Permission Registry ────────────────────────────────────────────────

export type RoutePermission = {
  resource:         Resource;
  action:           Action;
  extractOwnerId?:  (path: string, body: unknown) => string | undefined;
  requireMFA?:      boolean;
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
  ["POST",   /^\/api\/v1\/withdraw/,                           { resource: "wallet",   action: "write",      sensitivityLevel: "CRITICAL", requireMFA: true }],
  ["POST",   /^\/api\/v1\/deposit/,                            { resource: "wallet",   action: "write",      sensitivityLevel: "HIGH" }],
  ["GET",    /^\/api\/v1\/ledger/,                             { resource: "wallet",   action: "read",       sensitivityLevel: "MEDIUM" }],

  // ── KYC ───────────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/kyc/,                                { resource: "kyc",      action: "read",       sensitivityLevel: "MEDIUM" }],
  ["POST",   /^\/api\/v1\/kyc/,                                { resource: "kyc",      action: "write",      sensitivityLevel: "HIGH" }],
  ["POST",   /^\/api\/v1\/admin\/kyc/,                         { resource: "kyc",      action: "approve",    sensitivityLevel: "CRITICAL", requireMFA: true }],

  // ── Signals ────────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/signals/,                            { resource: "signals",  action: "read",       sensitivityLevel: "LOW" }],
  ["POST",   /^\/api\/v1\/signals\/configure/,                 { resource: "signals",  action: "configure",  sensitivityLevel: "HIGH" }],

  // ── Autopilot ──────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/autopilot/,                          { resource: "autopilot", action: "read",      sensitivityLevel: "LOW" }],
  ["POST",   /^\/api\/v1\/autopilot\/config/,                  { resource: "autopilot", action: "write",     sensitivityLevel: "HIGH" }],
  ["POST",   /^\/api\/v1\/autopilot\/consent/,                 { resource: "autopilot", action: "write",     sensitivityLevel: "HIGH" }],

  // ── Admin: Risk ────────────────────────────────────────────────────────────
  ["POST",   /^\/api\/v1\/trading\/kill-switch/,               { resource: "risk",     action: "override",   sensitivityLevel: "CRITICAL", requireMFA: true }],
  ["POST",   /^\/api\/v1\/admin\/risk/,                        { resource: "risk",     action: "write",      sensitivityLevel: "CRITICAL", requireMFA: true }],
  ["GET",    /^\/api\/v1\/admin\/risk/,                        { resource: "risk",     action: "read",       sensitivityLevel: "HIGH" }],

  // ── Admin: Users ───────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/admin\/users/,                       { resource: "users",    action: "read",       sensitivityLevel: "HIGH" }],
  ["POST",   /^\/api\/v1\/admin\/users/,                       { resource: "users",    action: "write",      sensitivityLevel: "CRITICAL", requireMFA: true }],
  ["DELETE", /^\/api\/v1\/admin\/users/,                       { resource: "users",    action: "delete",     sensitivityLevel: "CRITICAL", requireMFA: true }],
  ["POST",   /^\/api\/v1\/admin\/trading\/pause/,              { resource: "trading",  action: "override",   sensitivityLevel: "CRITICAL", requireMFA: true }],

  // ── Admin: Compliance ──────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/admin\/compliance/,                  { resource: "compliance", action: "read",     sensitivityLevel: "HIGH" }],
  ["POST",   /^\/api\/v1\/admin\/compliance/,                  { resource: "compliance", action: "write",    sensitivityLevel: "CRITICAL", requireMFA: true }],

  // ── Audit ──────────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/admin\/audit/,                       { resource: "audit",    action: "read",       sensitivityLevel: "HIGH" }],
  ["GET",    /^\/api\/v1\/admin\/audit.*export/,               { resource: "audit",    action: "export",     sensitivityLevel: "CRITICAL", requireMFA: true }],

  // ── Capital ────────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/admin\/capital/,                     { resource: "capital",  action: "read",       sensitivityLevel: "HIGH" }],
  ["POST",   /^\/api\/v1\/admin\/capital/,                     { resource: "capital",  action: "write",      sensitivityLevel: "CRITICAL", requireMFA: true }],

  // ── Settings ───────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/settings/,                           { resource: "settings", action: "read",       sensitivityLevel: "LOW" }],
  ["POST",   /^\/api\/v1\/settings/,                           { resource: "settings", action: "write",      sensitivityLevel: "HIGH" }],
  ["POST",   /^\/api\/v1\/admin\/settings/,                    { resource: "settings", action: "configure",  sensitivityLevel: "CRITICAL", requireMFA: true }],

  // ── API Keys ───────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/api-keys/,                           { resource: "api_keys", action: "read",       sensitivityLevel: "MEDIUM" }],
  ["POST",   /^\/api\/v1\/api-keys/,                           { resource: "api_keys", action: "write",      sensitivityLevel: "HIGH",     requireMFA: true }],
  ["DELETE", /^\/api\/v1\/api-keys/,                           { resource: "api_keys", action: "delete",     sensitivityLevel: "HIGH",     requireMFA: true }],

  // ── Reports ────────────────────────────────────────────────────────────────
  ["GET",    /^\/api\/v1\/reports/,                            { resource: "reports",  action: "read",       sensitivityLevel: "MEDIUM" }],
  ["POST",   /^\/api\/v1\/reports.*export/,                    { resource: "reports",  action: "export",     sensitivityLevel: "HIGH" }],
];

// Paths that are always public (no auth required)
const PUBLIC_PATHS = [
  /^\/health/,
  /^\/metrics/,
  /^\/api\/v1\/auth\/login/,   // covers /login, /login/db, future sub-paths
  /^\/api\/v1\/auth\/register$/,
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
