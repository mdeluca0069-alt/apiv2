/**
 * AccessPolicyService — resolves a user's role set into the flat permission
 * strings the rest of the app checks against. (Path/method-pattern-based
 * authorization is handled declaratively per-route via `auth`/`admin` flags
 * in gateway/routes.ts, enforced by shared/http.ts — this file no longer
 * duplicates that as a second, never-invoked rule table.)
 */

type Role = "trader" | "risk" | "compliance" | "admin" | "super_admin";

const ROLE_PERMISSIONS: Record<Role, string[]> = {
  trader:      ["trading:read", "trading:write", "wallet:read", "profile:read", "profile:write"],
  risk:        ["trading:read", "wallet:read", "risk:read", "risk:write", "kill_switch:write", "audit:read"],
  compliance:  ["trading:read", "wallet:read", "kyc:read", "kyc:write", "aml:read", "aml:write", "audit:read", "report:write"],
  admin:       ["trading:read", "trading:write", "wallet:read", "wallet:write", "users:write", "capital:write", "kyc:write", "settings:write", "audit:read"],
  super_admin: ["*"],
};

class AccessPolicyService {
  getPermissionsForRoles(roles: string[]): string[] {
    const perms = new Set<string>();
    for (const role of roles) {
      const rolePerms = ROLE_PERMISSIONS[role as Role] ?? [];
      for (const p of rolePerms) perms.add(p);
    }
    return [...perms];
  }
}

export const accessPolicy = new AccessPolicyService();
export default accessPolicy;
