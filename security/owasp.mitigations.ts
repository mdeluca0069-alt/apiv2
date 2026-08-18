/**
 * security/owasp.mitigations.ts — OWASP Top 10 2021 specific mitigations.
 *
 * A01:2021 — Broken Access Control
 *   → RBAC engine (rbac.engine.ts) + permission middleware
 *
 * A02:2021 — Cryptographic Failures
 *   → HSM provider + TLS enforcement + secret rotation + no sensitive data in logs
 *
 * A03:2021 — Injection
 *   → WAF engine + Prisma ORM (parameterized queries) + input validation
 *
 * A04:2021 — Insecure Design
 *   → Fail-closed gates + defense-in-depth + rate limiting
 *
 * A05:2021 — Security Misconfiguration
 *   → Security headers middleware + CORS strict policy + default deny
 *
 * A06:2021 — Vulnerable and Outdated Components
 *   → npm audit in CI + Dependabot + package lock integrity check
 *
 * A07:2021 — Identification and Authentication Failures
 *   → Session security + MFA enforcer + JWT short TTL + bcrypt cost=12
 *
 * A08:2021 — Software and Data Integrity Failures
 *   → Immutable audit log + deployment signing + CSRF protection
 *
 * A09:2021 — Security Logging and Monitoring Failures
 *   → Immutable audit log + Prometheus alerting + event correlator
 *
 * A10:2021 — Server-Side Request Forgery (SSRF)
 *   → WAF SSRF rules + URL validation in wafEngine.validateUrl()
 *
 * This module implements the request-level mitigations as composable
 * middleware functions and assertion helpers.
 */

import type { IncomingMessage } from "node:http";
import { normalizeRole } from "./rbac.engine.js";
import { getClientIp } from "../shared/client-ip.js";

// ─── A01: Broken Access Control ───────────────────────────────────────────────

/**
 * Validate that a user can only access their own resources unless they have
 * explicit "all" scope permission.
 * Generic helper used in handlers to enforce A01 at the resource level.
 */
export function assertOwnership(
  requestingUserId: string,
  resourceOwnerId:  string,
  roles:            string[],
): void {
  // FASE 7 CLOSURE, Phase D: currently unused anywhere (grep-confirmed, dead
  // code) but had the same role-vocabulary mismatch as rbac.engine.ts's
  // authorize() -- a hardcoded uppercase-only list checked with no
  // normalization at all, so it would have matched NONE of the real
  // lowercase JWT roles ("admin"/"risk"/"compliance"/etc.) the moment this
  // helper is wired up, failing closed (denying legitimate admin/risk/
  // compliance cross-user access) exactly like the rbacEngine bug. Fixed to
  // reuse rbac.engine.ts's normalizeRole as the single source of truth
  // instead of a second, independently-maintained role list.
  const normalized = roles.map(normalizeRole) as string[];
  // Admins and risk managers can access all resources
  if (normalized.some((r) => ["SUPER_ADMIN", "ADMIN", "RISK_MANAGER", "COMPLIANCE_OFFICER"].includes(r))) return;

  if (requestingUserId !== resourceOwnerId) {
    throw Object.assign(
      new Error("A01: Access denied — resource belongs to a different user"),
      { statusCode: 403, owasp: "A01:2021" },
    );
  }
}

/**
 * Validate pagination parameters to prevent mass data extraction attacks.
 */
export function validatePagination(limit: number, offset: number): { limit: number; offset: number } {
  const safeLimit  = Math.min(Math.max(1, limit || 50), 500);
  const safeOffset = Math.max(0, offset || 0);
  return { limit: safeLimit, offset: safeOffset };
}

// ─── A02: Cryptographic Failures ─────────────────────────────────────────────

/** Sensitive field names that must NEVER appear in logs or API responses. */
export const SENSITIVE_FIELDS = new Set([
  "password", "password_hash", "passwordHash",
  "twoFactorSecret", "two_factor_secret",
  "cvv", "cvc", "cvv2",
  "track_data", "trackData",
  "pin", "pin_hash",
  "secret", "api_secret",
  "private_key", "privateKey",
  "backup_codes", "backupCodes",
  "session_token", "sessionToken", "refreshToken", "refresh_token",
  "card_number", "cardNumber", "pan",
  "social_security", "ssn",
]);

/**
 * Deep-clone an object, removing all sensitive fields.
 * Use before logging any user-provided or server response data.
 */
export function redactSensitiveFields(obj: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveFields(item, depth + 1));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_FIELDS.has(k.toLowerCase())) {
        result[k] = "[REDACTED]";
      } else {
        result[k] = redactSensitiveFields(v, depth + 1);
      }
    }
    return result;
  }
  return obj;
}

// ─── A03: Injection Mitigations ───────────────────────────────────────────────

/**
 * Validate that a string is safe for use as a search/filter parameter.
 * Prevents injection through API query parameters.
 */
export function sanitizeSearchParam(value: string): string {
  // Remove null bytes (path traversal enabler)
  let safe = value.replace(/\0/g, "");
  // Remove CRLF
  safe = safe.replace(/[\r\n]/g, " ");
  // Remove SQL injection markers
  safe = safe.replace(/['";\\]/g, "");
  // Limit length
  return safe.slice(0, 256);
}

/**
 * Validate an identifier (userId, orderId, etc.) is a valid UUID or safe ID.
 * Prevents second-order injection via malicious IDs.
 */
export function validateId(id: string): boolean {
  // UUID v4 format
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return true;
  // Alphanumeric + underscore/hyphen only (for legacy IDs)
  if (/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return true;
  return false;
}

// ─── A05: Security Misconfiguration ──────────────────────────────────────────
// (The response security-header set used to live here — dead code, since the
// live request pipeline sets its headers in shared/http.ts's setSecurityHeaders().
// That live set is missing COOP/CORP/COEP and doesn't strip X-Powered-By/Server;
// closing that gap is worth a follow-up milestone, not folded in here.)

/**
 * Validate CORS origin.
 * Only allows explicitly configured origins — never wildcard in production.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const allowed = (process.env.CORS_ORIGIN ?? "https://www.igfxpro.com")
    .split(",")
    .map((o) => o.trim());
  return allowed.includes(origin);
}

// ─── A07: Authentication Failures ────────────────────────────────────────────

/**
 * Validate JWT claims for minimum security requirements.
 */
export function validateJWTClaims(payload: {
  sub?: string;
  exp?: number;
  roles?: string[];
  email?: string;
}): { valid: boolean; reason?: string } {
  if (!payload.sub) return { valid: false, reason: "Missing subject claim" };
  if (!payload.exp) return { valid: false, reason: "Missing expiry claim" };
  if (payload.exp < Date.now() / 1000) return { valid: false, reason: "Token expired" };
  if (!Array.isArray(payload.roles) || payload.roles.length === 0) {
    return { valid: false, reason: "Missing roles claim" };
  }
  return { valid: true };
}

/**
 * Extract real client IP from request headers.
 *
 * PHASE2_REMEDIATION (H18): this used to have its own inline XFF parsing
 * that trusted the leftmost header entry unconditionally, with no check
 * of whether the request actually came through a trusted proxy -- the
 * same spoofing gap found across every other IP-extraction site in the
 * codebase (shared/http.ts, auth.controller.ts, device-fingerprint.ts).
 * Delegates to the single canonical, trust-validated implementation.
 */
export function extractClientIp(req: IncomingMessage): string {
  return getClientIp(req);
}

// ─── A08: Data Integrity Failures ────────────────────────────────────────────

/**
 * Validate request Content-Type matches body format.
 * Prevents content-type confusion attacks.
 */
export function validateContentType(
  contentType: string | undefined,
  expectedType: "application/json" | "multipart/form-data",
): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().startsWith(expectedType);
}

// ─── A10: SSRF Prevention ─────────────────────────────────────────────────────

/**
 * Allowlist of external domains IGFXPRO is permitted to connect to.
 * Any external HTTP call (PSP webhooks, KYC providers, etc.) must be in this list.
 */
export const EXTERNAL_DOMAIN_ALLOWLIST = new Set([
  "api.stripe.com",
  "api.nuvei.com",
  "api.praxispay.com",
  "api.sumsub.com",
  "api.twelvedata.com",
  "finnhub.io",
  "ws.finnhub.io", // STAGING ONLY — market-data/feeds/finnhub.feed.ts's WebSocket host
  "www.investing.com",
  "api.exchangerate-api.com",
  "calendarific.com",
  "api.fiscaldata.treasury.gov",
]);

export function isAllowedExternalDomain(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return EXTERNAL_DOMAIN_ALLOWLIST.has(hostname);
  } catch {
    return false;
  }
}
