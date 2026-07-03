/**
 * security/mfa.enforcer.ts — Step-up MFA enforcement for high-value operations.
 *
 * High-value operations require a fresh MFA verification within a short window,
 * even if the user is already authenticated with a valid session. This prevents
 * session hijacking from enabling unauthorized high-impact actions.
 *
 * Operations requiring step-up MFA:
 *   - Withdrawals
 *   - API key creation/deletion
 *   - Admin actions (kill-switch, capital operations, user management)
 *   - KYC approval
 *   - 2FA disable
 *   - Password/email change
 *   - Export of audit logs / sensitive data
 *
 * Step-up token:
 *   - Issued after successful MFA verification for a specific operation class
 *   - Valid for MFA_STEPUP_TTL_SECONDS (default 5 minutes)
 *   - Stored in Redis: mfa:stepup:{userId}:{operationClass} → token
 *   - Consumed on first use (single-use for CRITICAL ops, time-window for HIGH ops)
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { randomUUID }  from "node:crypto";
import { getRedis }    from "../shared/redis.js";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { twoFactorService } from "../auth-service/2fa.service.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const MFA_STEPUP_TTL_SECONDS  = Number(process.env.MFA_STEPUP_TTL_SECONDS ?? 300);   // 5 min

// ─── Types ────────────────────────────────────────────────────────────────────

export type MFAOperationClass =
  | "WITHDRAWAL"
  | "API_KEY_MANAGEMENT"
  | "ADMIN_CRITICAL"
  | "KYC_APPROVAL"
  | "SECURITY_CHANGE"    // 2FA disable, password change, email change
  | "AUDIT_EXPORT"
  | "CAPITAL_OPERATION";

export type MFAVerificationMethod = "totp" | "backup_code" | "sms";

export type StepUpToken = {
  token:          string;
  userId:         string;
  operationClass: MFAOperationClass;
  issuedAt:       number;
  expiresAt:      number;
  method:         MFAVerificationMethod;
  consumed:       boolean;
};

export type StepUpResult =
  | { valid: true;  token: StepUpToken }
  | { valid: false; reason: string };

// Operations that consume the step-up token on use (cannot reuse within window)
const SINGLE_USE_OPERATIONS: Set<MFAOperationClass> = new Set([
  "WITHDRAWAL",
  "CAPITAL_OPERATION",
  "SECURITY_CHANGE",
]);

// ─── MFAEnforcer ─────────────────────────────────────────────────────────────

export class MFAEnforcer {

  /**
   * Check if a user has a valid step-up MFA token for the given operation.
   * Called before executing any high-value operation.
   */
  async checkStepUp(
    userId:         string,
    operationClass: MFAOperationClass,
  ): Promise<StepUpResult> {
    const redis = getRedis();
    if (!redis) {
      // In non-persistent mode (dev/test), allow all
      return { valid: true, token: this._mockToken(userId, operationClass) };
    }

    const key = this._redisKey(userId, operationClass);
    const raw = await redis.get(key).catch(() => null);

    if (!raw) {
      await this._auditMFACheck(userId, operationClass, false, "no_stepup_token");
      return { valid: false, reason: "Step-up MFA required for this operation" };
    }

    let token: StepUpToken;
    try {
      token = JSON.parse(raw) as StepUpToken;
    } catch {
      await redis.del(key).catch(() => null);
      return { valid: false, reason: "Invalid step-up token format" };
    }

    if (token.consumed && SINGLE_USE_OPERATIONS.has(operationClass)) {
      return { valid: false, reason: "Step-up token already consumed — re-verify MFA" };
    }

    const now = Date.now();
    if (token.expiresAt < now) {
      await redis.del(key).catch(() => null);
      await this._auditMFACheck(userId, operationClass, false, "stepup_expired");
      return { valid: false, reason: "Step-up MFA token expired — re-verify" };
    }

    // For single-use operations: consume the token immediately
    if (SINGLE_USE_OPERATIONS.has(operationClass)) {
      token.consumed = true;
      await redis.setex(key, MFA_STEPUP_TTL_SECONDS, JSON.stringify(token)).catch(() => null);
    }

    await this._auditMFACheck(userId, operationClass, true, "stepup_valid");
    return { valid: true, token };
  }

  /**
   * Issue a step-up token after the user successfully verifies their MFA code.
   * Call this from the auth controller's MFA verification endpoint.
   */
  async issueStepUp(
    userId:         string,
    operationClass: MFAOperationClass,
    method:         MFAVerificationMethod,
  ): Promise<string> {
    const redis = getRedis();
    const token = randomBytes(32).toString("hex");
    const now   = Date.now();

    const stepUp: StepUpToken = {
      token,
      userId,
      operationClass,
      issuedAt:  now,
      expiresAt: now + MFA_STEPUP_TTL_SECONDS * 1000,
      method,
      consumed:  false,
    };

    if (redis) {
      const key = this._redisKey(userId, operationClass);
      await redis.setex(key, MFA_STEPUP_TTL_SECONDS, JSON.stringify(stepUp));
    }

    await this._auditMFAIssue(userId, operationClass, method);
    return token;
  }

  /**
   * Revoke all step-up tokens for a user (on logout or security events).
   */
  async revokeAll(userId: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;

    const operations: MFAOperationClass[] = [
      "WITHDRAWAL", "API_KEY_MANAGEMENT", "ADMIN_CRITICAL",
      "KYC_APPROVAL", "SECURITY_CHANGE", "AUDIT_EXPORT", "CAPITAL_OPERATION",
    ];

    await Promise.all(
      operations.map((op) => redis.del(this._redisKey(userId, op)).catch(() => null)),
    );
  }

  /**
   * Verify that a user has MFA enabled before enforcing step-up.
   * Users without MFA enrolled MUST enroll before performing high-value ops.
   */
  async assertMFAEnrolled(userId: string): Promise<void> {
    if (!IS_PERSISTENT) return;

    const enabled = await twoFactorService.isEnabled(userId).catch(() => false);
    if (!enabled) {
      throw Object.assign(
        new Error("MFA enrollment required before performing this operation"),
        {
          statusCode: 403,
          data: {
            code:    "MFA_ENROLLMENT_REQUIRED",
            message: "You must enable two-factor authentication before performing high-value operations",
          },
        },
      );
    }
  }

  /**
   * Returns the header name that carries the step-up token in HTTP requests.
   * Clients include this in: X-MFA-Stepup-Token: <token>
   */
  readonly headerName = "X-MFA-Stepup-Token";

  /**
   * Extract step-up token from request headers and validate it.
   * Used in middleware to gate critical routes.
   */
  async validateFromHeader(
    headers:        Record<string, string | string[] | undefined>,
    userId:         string,
    operationClass: MFAOperationClass,
  ): Promise<StepUpResult> {
    const headerValue = headers[this.headerName.toLowerCase()];
    const tokenFromHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    // If token provided in header, do constant-time comparison as extra validation layer
    // (the Redis key lookup already validates token content, header is optional belt-and-suspenders)
    const result = await this.checkStepUp(userId, operationClass);

    if (result.valid && tokenFromHeader) {
      const storedToken = Buffer.from(result.token.token);
      const provided    = Buffer.from(tokenFromHeader.trim());
      if (storedToken.length !== provided.length || !timingSafeEqual(storedToken, provided)) {
        return { valid: false, reason: "Step-up token mismatch" };
      }
    }

    return result;
  }

  private _redisKey(userId: string, operationClass: MFAOperationClass): string {
    return `mfa:stepup:${userId}:${operationClass}`;
  }

  private _mockToken(userId: string, operationClass: MFAOperationClass): StepUpToken {
    const now = Date.now();
    return {
      token:          "sandbox-token",
      userId,
      operationClass,
      issuedAt:       now,
      expiresAt:      now + MFA_STEPUP_TTL_SECONDS * 1000,
      method:         "totp",
      consumed:       false,
    };
  }

  private async _auditMFACheck(
    userId:         string,
    operationClass: MFAOperationClass,
    success:        boolean,
    reason:         string,
  ): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;
    await prisma.auditLog.create({
      data: {
        id:     randomUUID(),
        actor:  userId,
        action: `mfa.stepup.${success ? "granted" : "denied"}`,
        entity: userId,
        payload: { operationClass, reason } as object,
      },
    }).catch(() => undefined);
  }

  private async _auditMFAIssue(
    userId:         string,
    operationClass: MFAOperationClass,
    method:         MFAVerificationMethod,
  ): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;
    await prisma.auditLog.create({
      data: {
        id:     randomUUID(),
        actor:  userId,
        action: "mfa.stepup.issued",
        entity: userId,
        payload: { operationClass, method } as object,
      },
    }).catch(() => undefined);
  }
}

export const mfaEnforcer = new MFAEnforcer();
export default mfaEnforcer;
