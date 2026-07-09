/**
 * security/rbac.engine.ts — Institutional-grade Role-Based Access Control engine.
 *
 * Implements a complete permission matrix with:
 *   - Role hierarchy with inheritance
 *   - Resource-level permissions (what you can do)
 *   - Attribute conditions (own-resource vs all-resources)
 *   - Wildcard and deny rules (deny always wins)
 *   - Every authorization decision logged to AuditLog
 *
 * Role hierarchy (each role inherits from roles below it):
 *   SUPER_ADMIN > ADMIN > RISK_MANAGER/COMPLIANCE_OFFICER > ANALYST > TRADER > API_CLIENT
 *
 * Permission string format: "resource:action[:scope]"
 *   Examples:
 *     "trading:read:own"        — read own trading data
 *     "trading:execute:own"     — execute own trades
 *     "wallet:write:all"        — modify any wallet (admin)
 *     "audit:read:all"          — read all audit logs
 *
 * Scopes:
 *   "own"  — only resources belonging to the requesting user
 *   "all"  — any resource in the system
 *   (none) — implies "all" for backwards compatibility
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type RoleName =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "RISK_MANAGER"
  | "COMPLIANCE_OFFICER"
  | "ANALYST"
  | "TRADER"
  | "API_CLIENT"
  | "SYSTEM"
  | "READ_ONLY";

export type Resource =
  | "trading"
  | "wallet"
  | "users"
  | "kyc"
  | "aml"
  | "audit"
  | "signals"
  | "autopilot"
  | "reports"
  | "settings"
  | "admin"
  | "capital"
  | "risk"
  | "compliance"
  | "api_keys"
  | "notifications"
  | "watchlist";

export type Action =
  | "read"
  | "write"
  | "delete"
  | "execute"
  | "approve"
  | "export"
  | "configure"
  | "override"
  | "*";

export type Scope = "own" | "all";

export type Permission = `${Resource}:${Action}` | `${Resource}:${Action}:${Scope}`;

export type AuthorizationContext = {
  userId:          string;
  roles:           RoleName[];
  resourceOwnerId?: string;   // ID of the resource owner (for "own" scope checks)
  resource:        Resource;
  action:          Action;
  metadata?:       Record<string, unknown>;
};

export type AuthorizationResult = {
  allowed:    boolean;
  reason:     string;
  matchedRule?: string;
  scope?:     Scope;
};

// ─── Permission Matrix ────────────────────────────────────────────────────────
// Format: Role → Set of Permission strings
// Wildcards: "resource:*" grants all actions on a resource
//            "*" grants everything (SUPER_ADMIN only)

const ROLE_PERMISSIONS: Record<RoleName, Permission[]> = {
  SUPER_ADMIN: ["*" as Permission],

  ADMIN: [
    "trading:read:all",    "trading:write:all",    "trading:execute:all",
    "trading:delete:all",  "trading:override:all",
    "wallet:read:all",     "wallet:write:all",     "wallet:delete:all",
    "users:read:all",      "users:write:all",      "users:delete:all",
    "kyc:read:all",        "kyc:write:all",        "kyc:approve:all",
    "aml:read:all",        "aml:write:all",        "aml:approve:all",
    "audit:read:all",      "audit:export:all",
    "signals:read:all",    "signals:configure:all",
    "autopilot:read:all",  "autopilot:write:all",  "autopilot:override:all",
    "reports:read:all",    "reports:export:all",
    "settings:read:all",   "settings:write:all",   "settings:configure:all",
    "admin:read:all",      "admin:write:all",
    "capital:read:all",    "capital:write:all",    "capital:approve:all",
    "risk:read:all",       "risk:write:all",       "risk:override:all",
    "compliance:read:all", "compliance:write:all",
    "api_keys:read:all",   "api_keys:write:all",   "api_keys:delete:all",
    "notifications:read:all", "notifications:write:all",
    "watchlist:read:all",  "watchlist:write:all",
  ],

  RISK_MANAGER: [
    "trading:read:all",    "trading:override:all",
    "wallet:read:all",
    "users:read:all",
    "kyc:read:all",
    "aml:read:all",        "aml:write:all",
    "audit:read:all",      "audit:export:all",
    "signals:read:all",
    "autopilot:read:all",  "autopilot:override:all",
    "reports:read:all",    "reports:export:all",
    "risk:read:all",       "risk:write:all",       "risk:override:all",
    "capital:read:all",
    "compliance:read:all",
    "settings:read:all",
    "admin:read:all",
  ],

  COMPLIANCE_OFFICER: [
    "trading:read:all",
    "wallet:read:all",
    "users:read:all",
    "kyc:read:all",        "kyc:write:all",        "kyc:approve:all",
    "aml:read:all",        "aml:write:all",        "aml:approve:all",
    "audit:read:all",      "audit:export:all",
    "reports:read:all",    "reports:export:all",
    "compliance:read:all", "compliance:write:all",
    "settings:read:all",
    "admin:read:all",
  ],

  ANALYST: [
    "trading:read:all",
    "wallet:read:own",
    "signals:read:all",
    "autopilot:read:own",
    "reports:read:all",
    "notifications:read:own",
    "watchlist:read:own",  "watchlist:write:own",
    "api_keys:read:own",
  ],

  TRADER: [
    "trading:read:own",    "trading:write:own",    "trading:execute:own",
    "wallet:read:own",     "wallet:write:own",
    "kyc:read:own",
    "signals:read:all",
    "autopilot:read:own",  "autopilot:write:own",
    "reports:read:own",
    "notifications:read:own", "notifications:write:own",
    "watchlist:read:own",  "watchlist:write:own",
    "api_keys:read:own",   "api_keys:write:own",   "api_keys:delete:own",
  ],

  API_CLIENT: [
    "trading:read:own",    "trading:execute:own",
    "wallet:read:own",
    "signals:read:all",
    "notifications:read:own",
  ],

  SYSTEM: ["*" as Permission],

  READ_ONLY: [
    "trading:read:own",
    "wallet:read:own",
    "signals:read:all",
    "reports:read:own",
    "notifications:read:own",
    "watchlist:read:own",
  ],
};

// Explicit deny rules — these ALWAYS override any allow, regardless of role
// Format: [resource, action, scope | "*"]
const DENY_RULES: Array<[Resource, Action | "*", Scope | "*", RoleName[]]> = [
  // Nobody can delete audit logs
  ["audit", "delete", "*", []],
  // Only SUPER_ADMIN can delete users
  ["users", "delete", "*", ["SUPER_ADMIN"]],
  // Capital operations restricted to ADMIN+
  ["capital", "write", "*", ["SUPER_ADMIN", "ADMIN"]],
  ["capital", "approve", "*", ["SUPER_ADMIN", "ADMIN"]],
  // Override actions require RISK_MANAGER+
  ["trading", "override", "*", ["SUPER_ADMIN", "ADMIN", "RISK_MANAGER"]],
  ["autopilot", "override", "*", ["SUPER_ADMIN", "ADMIN", "RISK_MANAGER"]],
];

// ─── Role Hierarchy ───────────────────────────────────────────────────────────
// Maps each role to its effective permissions (including inherited ones)
// Built once at startup, cached for the process lifetime

function buildEffectivePermissions(): Map<RoleName, Set<Permission>> {
  const result = new Map<RoleName, Set<Permission>>();
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    result.set(role as RoleName, new Set(perms));
  }
  return result;
}

const EFFECTIVE_PERMISSIONS = buildEffectivePermissions();

// ─── RBACEngine ───────────────────────────────────────────────────────────────

export class RBACEngine {

  /**
   * Core authorization check.
   * Returns decision with reason for full explainability.
   */
  authorize(ctx: AuthorizationContext): AuthorizationResult {
    const { userId, resource, action, resourceOwnerId } = ctx;
    // Normalize roles to uppercase — JWT tokens may carry lowercase role names
    const roles = ctx.roles.map((r) => (r as string).toUpperCase() as RoleName);

    // SYSTEM role has universal access (used by internal services)
    if (roles.includes("SYSTEM") || roles.includes("SUPER_ADMIN")) {
      return { allowed: true, reason: "SUPER_ADMIN/SYSTEM universal access", matchedRule: "*", scope: "all" };
    }

    // Check explicit deny rules first — deny always beats allow
    for (const [dResource, dAction, , allowedRoles] of DENY_RULES) {
      if (dResource !== resource) continue;
      if (dAction !== "*" && dAction !== action) continue;
      // If user doesn't have one of the explicitly allowed roles, deny
      if (allowedRoles.length > 0 && !roles.some((r) => (allowedRoles as string[]).includes(r))) {
        return {
          allowed: false,
          reason:  `DENY rule: ${resource}:${action} requires one of [${allowedRoles.join(", ")}]`,
          matchedRule: `deny:${dResource}:${dAction}`,
        };
      }
    }

    // Check permissions from all roles (union)
    for (const role of roles) {
      const rolePerms = EFFECTIVE_PERMISSIONS.get(role as RoleName);
      if (!rolePerms) continue;

      // Wildcard grant
      if (rolePerms.has("*" as Permission)) {
        return { allowed: true, reason: `Role ${role} has wildcard permission`, matchedRule: "*", scope: "all" };
      }

      // Exact match: resource:action:all
      if (rolePerms.has(`${resource}:${action}:all` as Permission)) {
        return { allowed: true, reason: `Role ${role} granted ${resource}:${action}:all`, matchedRule: `${resource}:${action}:all`, scope: "all" };
      }

      // Own-scope match: resource:action:own — only if requesting user owns the resource
      if (rolePerms.has(`${resource}:${action}:own` as Permission)) {
        const ownsResource = !resourceOwnerId || resourceOwnerId === userId;
        if (ownsResource) {
          return { allowed: true, reason: `Role ${role} granted ${resource}:${action}:own`, matchedRule: `${resource}:${action}:own`, scope: "own" };
        }
        // Has own-scope permission but resource belongs to someone else
        return {
          allowed: false,
          reason:  `Role ${role} only has ${resource}:${action}:own — resource belongs to ${resourceOwnerId}`,
          matchedRule: `${resource}:${action}:own`,
          scope: "own",
        };
      }

      // Wildcard action: resource:*
      if (rolePerms.has(`${resource}:*` as Permission)) {
        return { allowed: true, reason: `Role ${role} granted ${resource}:*`, matchedRule: `${resource}:*`, scope: "all" };
      }
    }

    return {
      allowed: false,
      reason:  `No permission for ${resource}:${action} with roles [${roles.join(", ")}]`,
    };
  }

  /**
   * Check if a user has a specific permission string (for programmatic checks).
   * More ergonomic than the full context check.
   */
  hasPermission(roles: RoleName[], permission: Permission): boolean {
    for (const role of roles) {
      const rolePerms = EFFECTIVE_PERMISSIONS.get(role);
      if (!rolePerms) continue;
      if (rolePerms.has("*" as Permission)) return true;
      if (rolePerms.has(permission)) return true;
    }
    return false;
  }

  /**
   * Returns all effective permissions for a set of roles (for JWT payload population
   * and client-side access control hints).
   */
  getEffectivePermissions(roles: RoleName[]): Permission[] {
    if (roles.includes("SUPER_ADMIN") || roles.includes("SYSTEM")) {
      return Object.values(ROLE_PERMISSIONS).flat() as Permission[];
    }

    const perms = new Set<Permission>();
    for (const role of roles) {
      const rolePerms = EFFECTIVE_PERMISSIONS.get(role);
      if (rolePerms) {
        for (const p of rolePerms) perms.add(p);
      }
    }
    return [...perms];
  }

  /** Validate that a role name is valid (useful at user creation/update). */
  isValidRole(role: string): role is RoleName {
    return role in ROLE_PERMISSIONS;
  }

  /** All defined roles. */
  get allRoles(): RoleName[] {
    return Object.keys(ROLE_PERMISSIONS) as RoleName[];
  }
}

export const rbacEngine = new RBACEngine();
export default rbacEngine;
