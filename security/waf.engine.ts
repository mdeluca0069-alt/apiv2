/**
 * security/waf.engine.ts — Web Application Firewall.
 *
 * Defends against OWASP Top 10 2021:
 *   A03 Injection       — SQL, NoSQL, LDAP, OS command, XPath injection
 *   A03 XSS             — Reflected, stored, DOM-based
 *   A01 Path traversal  — Directory traversal, null byte injection
 *   A10 SSRF            — URL allowlisting, private IP range blocking
 *   A02 Header injection — CRLF injection in headers
 *   A08 Prototype pollution — JSON key poisoning
 *
 * The WAF runs before authentication and blocks requests that match
 * known attack patterns. Blocked events are logged to AuditLog and
 * published for the event correlator to track attacker IP patterns.
 *
 * All rules are evaluated against: URL path, query string, request body,
 * and selected HTTP headers.
 */

import { randomUUID } from "node:crypto";
import { getRedis }   from "../shared/redis.js";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── WAF Rule Definitions ─────────────────────────────────────────────────────

type WAFRuleCategory =
  | "SQL_INJECTION"
  | "XSS"
  | "PATH_TRAVERSAL"
  | "COMMAND_INJECTION"
  | "SSRF"
  | "HEADER_INJECTION"
  | "PROTOTYPE_POLLUTION"
  | "NOSQL_INJECTION"
  | "XXE"
  | "TEMPLATE_INJECTION";

interface WAFRule {
  id:       string;
  category: WAFRuleCategory;
  pattern:  RegExp;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  message:  string;
}

const WAF_RULES: WAFRule[] = [
  // ── SQL Injection ──────────────────────────────────────────────────────────
  { id: "SQL-001", category: "SQL_INJECTION", severity: "CRITICAL",
    pattern: /(['";]|\s)(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|TRUNCATE)\s/i,
    message: "SQL keyword injection detected" },
  { id: "SQL-002", category: "SQL_INJECTION", severity: "CRITICAL",
    pattern: /--\s*$|;\s*DROP|;\s*DELETE|WAITFOR\s+DELAY|SLEEP\s*\(/i,
    message: "SQL comment/blind injection detected" },
  { id: "SQL-003", category: "SQL_INJECTION", severity: "HIGH",
    pattern: /'\s*OR\s+'1'\s*=\s*'1|'\s*OR\s+1=1|"\s*OR\s+"1"="1/i,
    message: "Classic SQL OR injection detected" },
  { id: "SQL-004", category: "SQL_INJECTION", severity: "HIGH",
    pattern: /INFORMATION_SCHEMA|sys\.tables|sysobjects|pg_tables|sqlite_master/i,
    message: "Database schema enumeration detected" },
  { id: "SQL-005", category: "SQL_INJECTION", severity: "CRITICAL",
    pattern: /EXEC\s*\(|EXECUTE\s*\(|sp_executesql|xp_cmdshell/i,
    message: "SQL stored procedure execution detected" },

  // ── XSS ───────────────────────────────────────────────────────────────────
  { id: "XSS-001", category: "XSS", severity: "HIGH",
    pattern: /<script[\s>]|<\/script>/i,
    message: "Script tag XSS injection detected" },
  { id: "XSS-002", category: "XSS", severity: "HIGH",
    pattern: /javascript\s*:/i,
    message: "javascript: URI XSS detected" },
  { id: "XSS-003", category: "XSS", severity: "HIGH",
    pattern: /on(load|error|click|mouse|key|focus|blur|change|submit|input|drag|drop|scroll)\s*=/i,
    message: "Event handler XSS injection detected" },
  { id: "XSS-004", category: "XSS", severity: "MEDIUM",
    pattern: /<(img|iframe|object|embed|form|input|button|svg|math)\s[^>]*=/i,
    message: "HTML attribute XSS injection detected" },
  { id: "XSS-005", category: "XSS", severity: "HIGH",
    pattern: /expression\s*\(|vbscript\s*:|data\s*:text\/html/i,
    message: "Alternative XSS vector detected" },

  // ── Path Traversal ────────────────────────────────────────────────────────
  { id: "PT-001", category: "PATH_TRAVERSAL", severity: "CRITICAL",
    pattern: /\.\.\//,
    message: "Directory traversal ../ detected" },
  { id: "PT-002", category: "PATH_TRAVERSAL", severity: "CRITICAL",
    pattern: /%2e%2e%2f|%2e%2e\/|\.\.%2f/i,
    message: "URL-encoded directory traversal detected" },
  { id: "PT-003", category: "PATH_TRAVERSAL", severity: "HIGH",
    pattern: /\/etc\/passwd|\/etc\/shadow|\/etc\/hosts|\/proc\/self|\/windows\/system32/i,
    message: "System file path access detected" },
  { id: "PT-004", category: "PATH_TRAVERSAL", severity: "MEDIUM",
    pattern: /\x00|%00|\\0/,
    message: "Null byte injection detected" },

  // ── Command Injection ─────────────────────────────────────────────────────
  { id: "CMD-001", category: "COMMAND_INJECTION", severity: "CRITICAL",
    pattern: /[;&|`$]\s*(bash|sh|cmd|powershell|python|perl|ruby|nc|netcat|wget|curl)\s/i,
    message: "Shell command injection detected" },
  { id: "CMD-002", category: "COMMAND_INJECTION", severity: "CRITICAL",
    pattern: /\$\(|`[^`]*`|\|\s*[a-z]/i,
    message: "Command substitution injection detected" },
  { id: "CMD-003", category: "COMMAND_INJECTION", severity: "HIGH",
    pattern: /[;&|]\s*(cat|ls|dir|type|more|head|tail|id|whoami|uname)\s/i,
    message: "Command chaining injection detected" },

  // ── SSRF ──────────────────────────────────────────────────────────────────
  { id: "SSRF-001", category: "SSRF", severity: "CRITICAL",
    pattern: /https?:\/\/(127\.0\.0\.1|0\.0\.0\.0|localhost|::1)/i,
    message: "SSRF loopback address detected" },
  { id: "SSRF-002", category: "SSRF", severity: "CRITICAL",
    pattern: /https?:\/\/(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/i,
    message: "SSRF private network address detected" },
  { id: "SSRF-003", category: "SSRF", severity: "HIGH",
    pattern: /https?:\/\/169\.254\.169\.254/i,
    message: "SSRF AWS metadata endpoint detected" },
  { id: "SSRF-004", category: "SSRF", severity: "HIGH",
    pattern: /file:\/\/|gopher:\/\/|dict:\/\/|ldap:\/\/|tftp:\/\//i,
    message: "SSRF alternative protocol scheme detected" },

  // ── Header Injection ──────────────────────────────────────────────────────
  { id: "HDR-001", category: "HEADER_INJECTION", severity: "HIGH",
    pattern: /\r\n|\r|\n/,
    message: "CRLF header injection detected" },
  { id: "HDR-002", category: "HEADER_INJECTION", severity: "HIGH",
    pattern: /%0d%0a|%0d|%0a/i,
    message: "URL-encoded CRLF header injection detected" },

  // ── Prototype Pollution ───────────────────────────────────────────────────
  { id: "PROTO-001", category: "PROTOTYPE_POLLUTION", severity: "CRITICAL",
    pattern: /__proto__|constructor\.prototype|Object\.setPrototypeOf/,
    message: "Prototype pollution attempt detected" },
  { id: "PROTO-002", category: "PROTOTYPE_POLLUTION", severity: "HIGH",
    pattern: /\["__proto__"\]|\['__proto__'\]/,
    message: "Bracket notation prototype pollution detected" },

  // ── NoSQL Injection ───────────────────────────────────────────────────────
  { id: "NOSQL-001", category: "NOSQL_INJECTION", severity: "CRITICAL",
    pattern: /\$where|\$lookup|\$function|\$accumulator/i,
    message: "MongoDB operator injection detected" },
  { id: "NOSQL-002", category: "NOSQL_INJECTION", severity: "HIGH",
    pattern: /\$gt|\$lt|\$ne|\$in|\$nin|\$regex|\$exists/i,
    message: "MongoDB comparison operator injection detected" },

  // ── XXE ───────────────────────────────────────────────────────────────────
  { id: "XXE-001", category: "XXE", severity: "CRITICAL",
    pattern: /<!ENTITY\s+\w+\s+(SYSTEM|PUBLIC)/i,
    message: "XXE entity injection detected" },
  { id: "XXE-002", category: "XXE", severity: "HIGH",
    pattern: /<!DOCTYPE\s+\w+\s+\[/i,
    message: "XXE DOCTYPE injection detected" },

  // ── Template Injection ────────────────────────────────────────────────────
  { id: "TMPL-001", category: "TEMPLATE_INJECTION", severity: "HIGH",
    pattern: /\{\{.*\}\}|\$\{.*\}|<%.*%>/,
    message: "Template injection pattern detected" },
  { id: "TMPL-002", category: "TEMPLATE_INJECTION", severity: "HIGH",
    pattern: /#\{.*\}|\$\{7\*7\}|\{\{7\*7\}\}/,
    message: "Server-side template injection probe detected" },
];

export type WAFViolation = {
  ruleId:   string;
  category: WAFRuleCategory;
  severity: string;
  message:  string;
  location: string;   // where in the request the match was found
  matched:  string;   // first 100 chars of matched content
};

export type WAFResult = {
  blocked:    boolean;
  violations: WAFViolation[];
  requestId:  string;
};

// ─── WAFEngine ────────────────────────────────────────────────────────────────

export class WAFEngine {
  private readonly enabled: boolean;

  constructor() {
    this.enabled = process.env.WAF_ENABLED !== "false";
  }

  /**
   * Inspect a complete request for attack patterns.
   * Call this early in the middleware chain.
   */
  inspect(input: {
    method:   string;
    path:     string;
    query:    string;
    body:     string;
    headers:  Record<string, string | string[] | undefined>;
    ip:       string;
  }): WAFResult {
    const requestId = randomUUID();

    if (!this.enabled) {
      return { blocked: false, violations: [], requestId };
    }

    const violations: WAFViolation[] = [];

    // Build inspectable string segments
    const segments: Array<{ location: string; content: string }> = [
      { location: "path",         content: decodeURIComponent(input.path).slice(0, 2000) },
      { location: "query",        content: decodeURIComponent(input.query).slice(0, 4000) },
      { location: "body",         content: input.body.slice(0, 16384) },
    ];

    // Add high-risk headers — exclude origin/referer because they contain URLs the CLIENT
    // navigated from, not URLs the SERVER will fetch. Applying SSRF rules to them produces
    // false positives for any request from a localhost dev server or internal reverse proxy.
    const riskyHeaders = ["user-agent", "x-forwarded-for", "x-real-ip", "cookie"];
    for (const name of riskyHeaders) {
      const val = input.headers[name];
      if (val) {
        const str = Array.isArray(val) ? val.join(", ") : val;
        segments.push({ location: `header:${name}`, content: str.slice(0, 1000) });
      }
    }

    for (const { location, content } of segments) {
      for (const rule of WAF_RULES) {
        if (rule.pattern.test(content)) {
          const matchArr = rule.pattern.exec(content);
          violations.push({
            ruleId:   rule.id,
            category: rule.category,
            severity: rule.severity,
            message:  rule.message,
            location,
            matched:  (matchArr?.[0] ?? "").slice(0, 100),
          });
        }
      }
    }

    // Block if any CRITICAL or HIGH violation found
    const blocked = violations.some((v) => v.severity === "CRITICAL" || v.severity === "HIGH");

    // Fire-and-forget audit for violations
    if (violations.length > 0) {
      void this._auditViolations(input.ip, input.method, input.path, violations, blocked);
    }

    return { blocked, violations, requestId };
  }

  /**
   * Sanitize a string by stripping dangerous HTML/script content.
   * Use for output encoding in error messages, not for bypassing WAF checks.
   */
  sanitize(input: string): string {
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;")
      .replace(/\//g, "&#x2F;");
  }

  /**
   * Validate a URL is safe for server-side fetch (SSRF prevention).
   * Returns null if safe, or an error message if blocked.
   */
  validateUrl(url: string): string | null {
    try {
      const parsed = new URL(url);

      // Block non-HTTP(S) schemes
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return `Scheme ${parsed.protocol} is not allowed`;
      }

      const hostname = parsed.hostname.toLowerCase();

      // Block loopback
      if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
        return "Loopback addresses are not allowed";
      }

      // Block private ranges
      if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname)) {
        return "Private network addresses are not allowed";
      }

      // Block AWS metadata
      if (hostname === "169.254.169.254") {
        return "Cloud metadata endpoints are not allowed";
      }

      return null;
    } catch {
      return "Invalid URL format";
    }
  }

  /**
   * Validate and sanitize an object for prototype pollution.
   * Returns a clean deep copy with dangerous keys removed.
   */
  sanitizeObject(obj: unknown, depth = 0): unknown {
    if (depth > 10) return {};
    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitizeObject(item, depth + 1));
    }
    if (obj !== null && typeof obj === "object") {
      const clean: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        clean[key] = this.sanitizeObject(value, depth + 1);
      }
      return clean;
    }
    return obj;
  }

  private async _auditViolations(
    ip:         string,
    method:     string,
    path:       string,
    violations: WAFViolation[],
    blocked:    boolean,
  ): Promise<void> {
    // Redis counter for event correlator
    const redis = getRedis();
    if (redis) {
      await redis.incr(`waf:violations:${ip}`).catch(() => null);
      await redis.expire(`waf:violations:${ip}`, 3600).catch(() => null);
    }

    // DB audit for CRITICAL/HIGH violations only (avoid log flooding on LOW/MEDIUM)
    const critical = violations.filter((v) => v.severity === "CRITICAL" || v.severity === "HIGH");
    if (critical.length === 0 || !IS_PERSISTENT || !prisma) return;

    await prisma.auditLog.create({
      data: {
        id:     randomUUID(),
        actor:  ip,
        action: blocked ? "waf.blocked" : "waf.detected",
        entity: path,
        payload: { method, path, violations: critical.slice(0, 5), blocked } as object,
      },
    }).catch(() => undefined);
  }
}

export const wafEngine = new WAFEngine();
export default wafEngine;
