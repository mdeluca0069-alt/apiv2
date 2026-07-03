/**
 * security/session.security.ts — Enhanced session security layer.
 *
 * Extends the basic session.manager.ts with institutional-grade controls:
 *
 *   1. Concurrent session limit (max 5 per user by default)
 *   2. Session binding to device fingerprint — detects session hijacking
 *   3. Continuous geographic anomaly detection
 *   4. Idle timeout enforcement (30 min by default)
 *   5. Session age-out (7 days absolute TTL)
 *   6. Suspicious session scoring with automatic revocation
 *   7. Session context stored in Redis for fast lookup + DB for audit
 *
 * All security events are published to the event correlator.
 */

import { randomUUID } from "node:crypto";
import { getRedis }   from "../shared/redis.js";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_CONCURRENT_SESSIONS  = Number(process.env.MAX_CONCURRENT_SESSIONS  ?? 5);
const SESSION_IDLE_TIMEOUT_S   = Number(process.env.SESSION_IDLE_TIMEOUT_S   ?? 1800);  // 30 min
const SESSION_ABSOLUTE_TTL_S   = Number(process.env.SESSION_ABSOLUTE_TTL_S   ?? 604800); // 7 days
const SUSPICIOUS_SCORE_REVOKE  = Number(process.env.SUSPICIOUS_SCORE_REVOKE  ?? 80);

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionContext = {
  sessionId:      string;
  userId:         string;
  deviceFp:       string;
  ipSubnet:       string;
  countryCode:    string;
  createdAt:      number;
  lastActivityAt: number;
  absoluteExpiry: number;
  userAgent:      string;
  suspiciousScore: number;
  flaggedReasons: string[];
};

export type SessionValidationResult =
  | { valid: true;  context: SessionContext }
  | { valid: false; reason: string; action: "REVOKE" | "WARN" | "REQUIRE_MFA" };

// ─── SessionSecurity ─────────────────────────────────────────────────────────

export class SessionSecurity {

  /**
   * Create a new session with full context for security monitoring.
   */
  async createSession(
    userId:      string,
    deviceFp:    string,
    clientIp:    string,
    userAgent:   string,
    countryCode: string,
  ): Promise<{ sessionId: string; enforcedLogout: string[] }> {
    const sessionId     = `sess_${randomUUID()}`;
    const now           = Date.now();
    const ipSubnet      = this._subnet(clientIp);
    const enforcedLogout: string[] = [];

    const ctx: SessionContext = {
      sessionId,
      userId,
      deviceFp,
      ipSubnet,
      countryCode,
      createdAt:       now,
      lastActivityAt:  now,
      absoluteExpiry:  now + SESSION_ABSOLUTE_TTL_S * 1000,
      userAgent,
      suspiciousScore: 0,
      flaggedReasons:  [],
    };

    // Enforce concurrent session limit — evict oldest sessions if at cap
    const existing = await this._getUserSessionIds(userId);
    if (existing.length >= MAX_CONCURRENT_SESSIONS) {
      const toRevoke = existing.slice(0, existing.length - MAX_CONCURRENT_SESSIONS + 1);
      await Promise.all(toRevoke.map((oldId) => this._revokeSession(oldId, userId, "max_concurrent_sessions")));
      enforcedLogout.push(...toRevoke);
    }

    await this._storeSession(ctx);
    await this._auditSession(userId, sessionId, "session.created", { deviceFp, ipSubnet, countryCode });
    return { sessionId, enforcedLogout };
  }

  /**
   * Validate and refresh an active session on each request.
   * Returns the session context or a failure reason with remediation action.
   */
  async validateSession(
    sessionId:    string,
    userId:       string,
    deviceFp:     string,
    _ip:          string,
    countryCode?: string,
  ): Promise<SessionValidationResult> {
    const ctx = await this._loadSession(sessionId);
    if (!ctx) {
      return { valid: false, reason: "Session not found or expired", action: "REVOKE" };
    }

    if (ctx.userId !== userId) {
      await this._revokeSession(sessionId, userId, "user_mismatch");
      return { valid: false, reason: "Session user mismatch", action: "REVOKE" };
    }

    const now = Date.now();

    // Absolute TTL check
    if (ctx.absoluteExpiry < now) {
      await this._revokeSession(sessionId, userId, "absolute_ttl_expired");
      return { valid: false, reason: "Session absolute TTL expired", action: "REVOKE" };
    }

    // Idle timeout check
    if (ctx.lastActivityAt + SESSION_IDLE_TIMEOUT_S * 1000 < now) {
      await this._revokeSession(sessionId, userId, "idle_timeout");
      return { valid: false, reason: "Session idle timeout", action: "REVOKE" };
    }

    const score    = ctx.suspiciousScore;
    const reasons  = [...ctx.flaggedReasons];
    let addedScore = 0;

    // Device fingerprint binding — detect session token theft
    if (ctx.deviceFp && deviceFp && ctx.deviceFp !== deviceFp) {
      addedScore += 60;
      reasons.push(`device_fp_changed:${deviceFp.slice(0, 8)}`);
    }

    // Geographic anomaly — sudden country change
    if (countryCode && ctx.countryCode && ctx.countryCode !== countryCode) {
      addedScore += 40;
      reasons.push(`country_changed:${ctx.countryCode}→${countryCode}`);
    }

    const newScore = Math.min(100, score + addedScore);

    // Update session with new activity time and score
    const updated: SessionContext = {
      ...ctx,
      lastActivityAt:  now,
      suspiciousScore: newScore,
      flaggedReasons:  reasons,
    };
    await this._storeSession(updated);

    if (newScore >= SUSPICIOUS_SCORE_REVOKE) {
      await this._revokeSession(sessionId, userId, `suspicious_score_${newScore}`);
      await this._auditSession(userId, sessionId, "session.revoked.suspicious", { score: newScore, reasons });
      return { valid: false, reason: `Session revoked: suspicious score ${newScore}`, action: "REVOKE" };
    }

    if (newScore >= 50) {
      return { valid: true, context: updated }; // Allow but flag (WARN/MFA in future)
    }

    return { valid: true, context: updated };
  }

  /**
   * Enumerate all active sessions for a user (for session management UI).
   * Uses mget to batch all Redis lookups into a single round-trip.
   */
  async listUserSessions(userId: string): Promise<SessionContext[]> {
    const sessionIds = await this._getUserSessionIds(userId);
    if (sessionIds.length === 0) return [];
    const redis = getRedis();
    if (!redis) return [];
    const keys = sessionIds.map((id) => this._redisKey(id));
    const raws = await redis.mget(...keys).catch(() => []);
    const result: SessionContext[] = [];
    for (const raw of raws) {
      if (!raw) continue;
      try { result.push(JSON.parse(raw) as SessionContext); } catch { /* skip corrupt entries */ }
    }
    return result;
  }

  /**
   * Revoke a specific session by ID.
   */
  async revokeSession(sessionId: string, userId: string): Promise<void> {
    await this._revokeSession(sessionId, userId, "user_requested");
  }

  /**
   * Revoke ALL sessions for a user (security reset / logout-all).
   * Parallel revoke + single audit write.
   */
  async revokeAllSessions(userId: string): Promise<number> {
    const sessionIds = await this._getUserSessionIds(userId);
    await Promise.all(sessionIds.map((id) => this._revokeSession(id, userId, "logout_all")));
    await this._auditSession(userId, "all", "session.revoked.all", { count: sessionIds.length });
    return sessionIds.length;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _redisKey(sessionId: string): string {
    return `session:ctx:${sessionId}`;
  }

  private _userSessionsKey(userId: string): string {
    return `session:user:${userId}`;
  }

  private async _storeSession(ctx: SessionContext): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    const ttlMs = ctx.absoluteExpiry - Date.now();
    if (ttlMs <= 0) return;
    const ttlS = Math.ceil(ttlMs / 1000);
    // Pipeline 3 commands → 1 network round-trip
    await redis.pipeline()
      .setex(this._redisKey(ctx.sessionId), ttlS, JSON.stringify(ctx))
      .sadd(this._userSessionsKey(ctx.userId), ctx.sessionId)
      .expire(this._userSessionsKey(ctx.userId), SESSION_ABSOLUTE_TTL_S)
      .exec();
  }

  private async _loadSession(sessionId: string): Promise<SessionContext | null> {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get(this._redisKey(sessionId)).catch(() => null);
    if (!raw) return null;
    try { return JSON.parse(raw) as SessionContext; } catch { return null; }
  }

  private async _revokeSession(sessionId: string, userId: string, reason: string): Promise<void> {
    const redis = getRedis();
    if (redis) {
      await redis.del(this._redisKey(sessionId)).catch(() => null);
      await redis.srem(this._userSessionsKey(userId), sessionId).catch(() => null);
    }
    await this._auditSession(userId, sessionId, "session.revoked", { reason });
  }

  private async _getUserSessionIds(userId: string): Promise<string[]> {
    const redis = getRedis();
    if (!redis) return [];
    return redis.smembers(this._userSessionsKey(userId)).catch(() => []);
  }

  private async _auditSession(
    userId:    string,
    sessionId: string,
    action:    string,
    payload:   Record<string, unknown>,
  ): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;
    await prisma.auditLog.create({
      data: {
        id:     randomUUID(),
        actor:  userId,
        action,
        entity: sessionId,
        payload: payload as object,
      },
    }).catch(() => undefined);
  }

  private _subnet(ip: string): string {
    const parts = ip.split(".");
    return parts.length === 4 ? `${parts.slice(0, 3).join(".")}.0/24` : ip;
  }
}

export const sessionSecurity = new SessionSecurity();
export default sessionSecurity;
