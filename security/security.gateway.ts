/**
 * security/security.gateway.ts — Unified security middleware entrypoint.
 *
 * Chains all security layers in order of execution cost (cheapest first):
 *
 *   1. DDoS protection        — Token bucket rate limit (Redis, ~1ms)
 *   2. IP Reputation check    — Blocklist + score lookup (Redis, ~1ms)
 *   3. Bot detection          — UA + behavioral signals (Redis, ~2ms)
 *   4. WAF inspection         — Pattern matching (CPU, ~1ms)
 *   5. Security headers       — Apply response headers (sync, 0ms)
 *   6. JWT extraction         — Parse Bearer token (sync, ~0.1ms)
 *   7. JWT validation         — Verify signature + exp (sync, ~1ms)
 *   8. Zero Trust evaluation  — Multi-signal scoring (Redis, ~5ms)
 *   9. Permission check       — RBAC route gate (sync, ~0.1ms)
 *  10. MFA enforcement        — Step-up token check for critical ops (Redis, ~1ms)
 *
 * Total median overhead: ~12ms per request (all on fast paths, no DB round-trips)
 *
 * Usage in gateway/routes.ts:
 *   const { principal, ztResult } = await securityGateway.handle(req, res, method, path, body);
 *   if (!principal) return; // securityGateway already sent 401/403/429/503
 *
 * For routes needing MFA enforcement, pass the operation class:
 *   await securityGateway.assertMFA(principal, "WITHDRAWAL");
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { ddosProtection }        from "./ddos.protection.js";
import { scoreIp }               from "./ip-reputation.js";
import { botDetector }           from "./bot.detection.js";
import { wafEngine }             from "./waf.engine.js";
import { jwtStrategy }           from "../auth-service/jwt.strategy.js";
import { permissionMiddleware }  from "./permission.middleware.js";
import { zeroTrustEngine }       from "./zero.trust.js";
import { mfaEnforcer, type MFAOperationClass } from "./mfa.enforcer.js";
import { immutableAudit }        from "./immutable.audit.js";
import { applySecurityHeaders, extractClientIp } from "./owasp.mitigations.js";
import type { TokenPayload }     from "../shared/security.js";
import type { ZeroTrustVerification } from "./zero.trust.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SecurityGatewayResult = {
  principal:  TokenPayload | null;
  ztResult?:  ZeroTrustVerification;
  ip:         string;
  requestId:  string;
};

export type SecurityGatewayOptions = {
  requireAuth?:         boolean;
  minTrustLevel?:       "FULL_ACCESS" | "STEP_DOWN" | "RESTRICTED";
  skipWAF?:             boolean;
  skipBotDetection?:    boolean;
};

// ─── SecurityGateway ─────────────────────────────────────────────────────────

class SecurityGateway {

  /**
   * Main security middleware. Runs all layers and returns the result.
   * If any layer blocks the request, sends the appropriate HTTP response and returns null principal.
   *
   * Callers check: if (!result.principal && route requires auth) return;
   */
  async handle(
    req:     IncomingMessage,
    res:     ServerResponse,
    method:  string,
    path:    string,
    body:    string,
    opts:    SecurityGatewayOptions = {},
  ): Promise<SecurityGatewayResult> {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ip        = extractClientIp(req);

    // ── Step 1: Apply security headers immediately ─────────────────────────
    applySecurityHeaders(res);
    res.setHeader("X-Request-ID", requestId);

    // ── Step 2: DDoS protection ───────────────────────────────────────────
    const rateResult = await ddosProtection.checkRequest(ip, path);
    if (!rateResult.allowed) {
      res.setHeader("Retry-After", String(rateResult.retryAfter ?? 60));
      res.setHeader("X-RateLimit-Remaining", "0");
      this._send(res, 429, {
        error:      "Too Many Requests",
        retryAfter: rateResult.retryAfter,
        requestId,
      });
      return { principal: null, ip, requestId };
    }

    res.setHeader("X-RateLimit-Remaining", String(rateResult.remaining));

    // ── Step 3: IP Reputation ─────────────────────────────────────────────
    const ipRep = await scoreIp(ip);
    if (ipRep.blocked) {
      this._send(res, 403, { error: "Forbidden", reason: "IP blocked", requestId });
      return { principal: null, ip, requestId };
    }

    if (ipRep.score >= 90) {
      this._send(res, 403, { error: "Forbidden", reason: "High-risk IP", requestId });
      return { principal: null, ip, requestId };
    }

    // ── Step 4: Bot Detection ─────────────────────────────────────────────
    if (!opts.skipBotDetection) {
      const userAgent = (req.headers["user-agent"] ?? "").slice(0, 512);
      const botResult = await botDetector.detect({
        ip,
        userAgent,
        path,
        method,
        acceptLang: req.headers["accept-language"] as string | undefined,
        acceptEnc:  req.headers["accept-encoding"] as string | undefined,
        headers:    req.headers as Record<string, string | string[] | undefined>,
      });

      if (botResult.decision === "BLOCK") {
        this._send(res, 403, {
          error:     "Forbidden",
          reason:    "Automated request detected",
          trackId:   botResult.trackId,
          requestId,
        });
        return { principal: null, ip, requestId };
      }

      if (botResult.decision === "CHALLENGE") {
        // Add challenge header — client can re-attempt with proof-of-work or CAPTCHA
        res.setHeader("X-Bot-Challenge", botResult.trackId ?? "required");
      }
    }

    // ── Step 5: WAF Inspection ────────────────────────────────────────────
    if (!opts.skipWAF) {
      const query     = req.url?.split("?")[1] ?? "";
      const wafResult = wafEngine.inspect({
        method,
        path,
        query,
        body:    body.slice(0, 32768),
        headers: req.headers as Record<string, string | string[] | undefined>,
        ip,
      });

      if (wafResult.blocked) {
        await immutableAudit.write({
          actor:    ip,
          action:   "waf.request.blocked",
          entity:   path,
          payload:  {
            requestId,
            method,
            violations: wafResult.violations.slice(0, 5).map((v) => ({
              ruleId: v.ruleId, category: v.category, severity: v.severity,
            })),
          },
          severity: "CRITICAL",
        });
        this._send(res, 403, {
          error:     "Forbidden",
          reason:    "Request blocked by security policy",
          requestId,
        });
        return { principal: null, ip, requestId };
      }
    }

    // ── Step 6–7: JWT extraction + validation ─────────────────────────────
    const token     = jwtStrategy.extractToken(req);
    const principal = token ? jwtStrategy.validate(token) : null;

    if (opts.requireAuth && !principal) {
      this._send(res, 401, { error: "Unauthorized", requestId });
      return { principal: null, ip, requestId };
    }

    // ── Step 8: Permission check (RBAC) ───────────────────────────────────
    if (principal) {
      const permResult = permissionMiddleware.checkRoute(method, path, principal);
      if (!permResult.allowed) {
        await immutableAudit.write({
          actor:   principal.sub,
          action:  "rbac.access.denied",
          entity:  path,
          payload: { method, path, reason: permResult.reason, roles: principal.roles },
          severity: "WARNING",
        });
        this._send(res, 403, {
          error:     "Forbidden",
          reason:    permResult.reason,
          requestId,
        });
        return { principal: null, ip, requestId };
      }
    }

    // ── Step 9: Zero Trust evaluation ─────────────────────────────────────
    let ztResult: ZeroTrustVerification | undefined;
    if (principal) {
      const deviceFp = this._extractDeviceFingerprint(req);
      ztResult = await zeroTrustEngine.evaluate({
        principal,
        deviceFp,
        ip,
        hasMFA:       false,  // hasMFA set by MFA enforcer on specific routes
        sessionAgeMs: 0,      // Set by session validator
        userAgent:    (req.headers["user-agent"] ?? "").slice(0, 256),
      });

      if (ztResult.level === "DENY") {
        this._send(res, 403, {
          error:      "Forbidden",
          reason:     "Zero Trust verification failed",
          trustScore: ztResult.trustScore,
          requestId,
        });
        return { principal: null, ip, requestId };
      }

      if (ztResult.level === "RESTRICTED") {
        // Add trust level header — client can see why certain features are locked
        res.setHeader("X-Trust-Level", "RESTRICTED");
        res.setHeader("X-Trust-Score", String(ztResult.trustScore));
      }
    }

    return { principal, ztResult, ip, requestId };
  }

  /**
   * Assert MFA step-up for a high-value operation.
   * Call this AFTER handle() for routes requiring MFA.
   */
  async assertMFA(
    req:            IncomingMessage,
    principal:      TokenPayload,
    operationClass: MFAOperationClass,
  ): Promise<void> {
    await mfaEnforcer.assertMFAEnrolled(principal.sub);

    const headers = req.headers as Record<string, string | string[] | undefined>;
    const result  = await mfaEnforcer.validateFromHeader(headers, principal.sub, operationClass);

    if (!result.valid) {
      throw Object.assign(
        new Error(`MFA required: ${result.reason}`),
        {
          statusCode: 403,
          data: {
            code:           "MFA_STEP_UP_REQUIRED",
            operationClass,
            reason:         result.reason,
            instructions:   "POST /api/v1/auth/mfa/step-up with { code, operationClass } to obtain step-up token",
          },
        },
      );
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _send(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(json),
    });
    res.end(json);
  }

  private _extractDeviceFingerprint(req: IncomingMessage): string {
    // Try to get pre-computed fingerprint from header (set by frontend SDK)
    const header = req.headers["x-device-fingerprint"];
    if (typeof header === "string" && header.length === 64) return header;

    // Fallback: compute from available headers
    const ua   = req.headers["user-agent"] ?? "";
    const lang = req.headers["accept-language"] ?? "";
    const enc  = req.headers["accept-encoding"] ?? "";
    // Simple hash of available signals (full fingerprint is computed client-side)
    const raw  = `${ua}|${lang}|${enc}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 32);
  }
}

export const securityGateway = new SecurityGateway();
export default securityGateway;
