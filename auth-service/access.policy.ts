/**
 * AccessPolicyService — role-based access control (RBAC).
 *
 * Defines which roles can access which path patterns and HTTP methods.
 * Rules are evaluated in order; first match wins.
 * If no rule matches, the request passes (basic auth middleware handles generic auth).
 */

type Role = "trader" | "risk" | "compliance" | "admin" | "super_admin";

type PolicyRule = {
  pathPattern: RegExp;
  methods:     Set<string>; // "*" = all
  roles:       Role[];
};

const WILDCARD = new Set(["*"]);

const POLICY_RULES: PolicyRule[] = [
  // Admin-only paths
  {
    pathPattern: /^\/api\/v1\/admin\//,
    methods:     WILDCARD,
    roles:       ["admin", "super_admin", "risk", "compliance"],
  },
  // Kill-switch — risk + admin only
  {
    pathPattern: /^\/api\/v1\/trading\/kill-switch$/,
    methods:     new Set(["POST"]),
    roles:       ["admin", "super_admin", "risk"],
  },
  // KYC admin review
  {
    pathPattern: /^\/api\/v1\/admin\/kyc\//,
    methods:     WILDCARD,
    roles:       ["admin", "super_admin", "compliance"],
  },
  // Compliance audit
  {
    pathPattern: /^\/api\/v1\/admin\/compliance\//,
    methods:     WILDCARD,
    roles:       ["admin", "super_admin", "compliance"],
  },
  // Capital operations — super_admin only
  {
    pathPattern: /^\/api\/v1\/admin\/capital\//,
    methods:     WILDCARD,
    roles:       ["admin", "super_admin"],
  },
  // Session revocation — own sessions always allowed (enforced in handler), all sessions = admin
  {
    pathPattern: /^\/api\/v1\/auth\/sessions\/all$/,
    methods:     new Set(["DELETE"]),
    roles:       ["admin", "super_admin"],
  },
];

const ROLE_PERMISSIONS: Record<Role, string[]> = {
  trader:      ["trading:read", "trading:write", "wallet:read", "profile:read", "profile:write"],
  risk:        ["trading:read", "wallet:read", "risk:read", "risk:write", "kill_switch:write", "audit:read"],
  compliance:  ["trading:read", "wallet:read", "kyc:read", "kyc:write", "aml:read", "aml:write", "audit:read", "report:write"],
  admin:       ["trading:read", "trading:write", "wallet:read", "wallet:write", "users:write", "capital:write", "kyc:write", "settings:write", "audit:read"],
  super_admin: ["*"],
};

class AccessPolicyService {
  /**
   * Returns true if the user with the given roles is allowed to access path+method.
   * Used as an extra layer; basic auth gates are in the middleware.
   */
  isAuthorized(userRoles: string[], path: string, method: string): boolean {
    for (const rule of POLICY_RULES) {
      if (!rule.pathPattern.test(path)) continue;
      if (!rule.methods.has("*") && !rule.methods.has(method.toUpperCase())) continue;

      return userRoles.some((r) => (rule.roles as string[]).includes(r));
    }
    return true;
  }

  getPermissionsForRoles(roles: string[]): string[] {
    const perms = new Set<string>();
    for (const role of roles) {
      const rolePerms = ROLE_PERMISSIONS[role as Role] ?? [];
      for (const p of rolePerms) perms.add(p);
    }
    return [...perms];
  }

  getPermissionsForRole(role: Role): string[] {
    if (ROLE_PERMISSIONS[role]?.includes("*")) {
      return Object.values(ROLE_PERMISSIONS).flat().filter((p) => p !== "*");
    }
    return ROLE_PERMISSIONS[role] ?? [];
  }

  isAdmin(roles: string[]): boolean {
    return roles.some((r) => ["admin", "super_admin"].includes(r));
  }

  isSuperAdmin(roles: string[]): boolean {
    return roles.includes("super_admin");
  }
}

export const accessPolicy = new AccessPolicyService();
export default accessPolicy;
