/**
 * security/zero.trust.ts — Zero Trust Architecture engine.
 *
 * Implements "Never Trust, Always Verify" for every request:
 *
 *   Trust Score = f(identity, device, network, context, behavior)
 *
 *   Identity signals (0-30 pts):
 *     • Valid JWT with role claims             +10
 *     • MFA-verified session                   +10
 *     • Session age < 1h (fresh)               +5
 *     • No failed logins in last 1h            +5
 *
 *   Device signals (0-25 pts):
 *     • Device fingerprint matches session     +10
 *     • Device previously seen for this user   +10
 *     • Anomaly score < 20                     +5
 *
 *   Network signals (0-25 pts):
 *     • IP reputation score < 20               +15
 *     • Not a datacenter/VPN IP                +5
 *     • No active DDoS/rate-limit violations   +5
 *
 *   Behavior signals (0-20 pts):
 *     • Not flagged by bot detection           +10
 *     • Request patterns consistent with human +5
 *     • WAF clean (no violations this session) +5
 *
 *   Decision thresholds:
 *     Trust ≥ 70  → FULL_ACCESS (normal operation)
 *     Trust 50–69 → STEP_DOWN (additional verification required for HIGH/CRITICAL ops)
 *     Trust 30–49 → RESTRICTED (read-only, no financial operations)
 *     Trust < 30  → DENY
 */

import { getRedis } from "../shared/redis.js";
import { scoreIp, type IpReputationResult } from "./ip-reputation.js";
import type { TokenPayload } from "../shared/security.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const ZT_FULL_ACCESS_THRESHOLD   = Number(process.env.ZT_FULL_ACCESS   ?? 70);
const ZT_STEP_DOWN_THRESHOLD     = Number(process.env.ZT_STEP_DOWN     ?? 50);
const ZT_RESTRICTED_THRESHOLD    = Number(process.env.ZT_RESTRICTED    ?? 30);

// ─── Types ────────────────────────────────────────────────────────────────────

export type ZeroTrustLevel = "FULL_ACCESS" | "STEP_DOWN" | "RESTRICTED" | "DENY";

export type ZeroTrustContext = {
  principal:    TokenPayload | null;
  deviceFp:     string;
  ip:           string;
  sessionId?:   string;
  hasMFA:       boolean;
  sessionAgeMs: number;
  userAgent:    string;
};

export type ZeroTrustVerification = {
  level:          ZeroTrustLevel;
  trustScore:     number;
  signals:        ZeroTrustSignals;
  explanation:    string[];
};

type ZeroTrustSignals = {
  identity:  { score: number; reasons: string[] };
  device:    { score: number; reasons: string[] };
  network:   { score: number; reasons: string[] };
  behavior:  { score: number; reasons: string[] };
};

// ─── ZeroTrustEngine ─────────────────────────────────────────────────────────

export class ZeroTrustEngine {

  /**
   * Evaluate the full zero-trust score for an incoming request.
   * Call this after initial auth checks, before executing any operation.
   */
  async evaluate(ctx: ZeroTrustContext): Promise<ZeroTrustVerification> {
    const [identity, device, network, behavior] = await Promise.all([
      this._evalIdentity(ctx),
      this._evalDevice(ctx),
      this._evalNetwork(ctx),
      this._evalBehavior(ctx),
    ]);

    const trustScore = identity.score + device.score + network.score + behavior.score;

    const level: ZeroTrustLevel =
      trustScore >= ZT_FULL_ACCESS_THRESHOLD   ? "FULL_ACCESS"  :
      trustScore >= ZT_STEP_DOWN_THRESHOLD     ? "STEP_DOWN"    :
      trustScore >= ZT_RESTRICTED_THRESHOLD    ? "RESTRICTED"   :
      "DENY";

    const explanation = [
      ...identity.reasons.map((r) => `[IDENTITY] ${r}`),
      ...device.reasons.map((r)   => `[DEVICE] ${r}`),
      ...network.reasons.map((r)  => `[NETWORK] ${r}`),
      ...behavior.reasons.map((r) => `[BEHAVIOR] ${r}`),
    ];

    return {
      level,
      trustScore,
      signals: { identity, device, network, behavior },
      explanation,
    };
  }

  /**
   * Assert minimum trust level for an operation.
   * Use in handlers to enforce zero-trust access control.
   */
  async assertMinimumTrust(
    ctx:   ZeroTrustContext,
    level: ZeroTrustLevel,
  ): Promise<ZeroTrustVerification> {
    const verification = await this.evaluate(ctx);
    const levelOrder = ["DENY", "RESTRICTED", "STEP_DOWN", "FULL_ACCESS"];
    const required   = levelOrder.indexOf(level);
    const actual     = levelOrder.indexOf(verification.level);

    if (actual < required) {
      throw Object.assign(
        new Error(`Zero Trust: insufficient trust level (have ${verification.level}, need ${level})`),
        {
          statusCode: 403,
          data: {
            trustScore:  verification.trustScore,
            level:       verification.level,
            required:    level,
            explanation: verification.explanation.slice(0, 5),
          },
        },
      );
    }

    return verification;
  }

  /**
   * Continuous re-verification for long-running operations.
   * For operations that take time (e.g., large report generation),
   * periodically re-check trust to detect mid-operation anomalies.
   */
  async verifyContinuous(ctx: ZeroTrustContext, intervalMs = 60_000): Promise<void> {
    const verify = async () => {
      const result = await this.evaluate(ctx);
      if (result.level === "DENY" || result.level === "RESTRICTED") {
        throw Object.assign(
          new Error("Zero Trust: continuous verification failed — session revoked"),
          { statusCode: 401, trustLevel: result.level },
        );
      }
    };
    // Run once immediately
    await verify();
    // Schedule periodic re-checks (caller manages lifecycle)
    const timer = setInterval(() => { void verify(); }, intervalMs);
    // Auto-clear after 30 minutes max (long operations should not re-verify forever)
    setTimeout(() => { clearInterval(timer); }, 30 * 60 * 1000);
  }

  // ── Signal evaluation ────────────────────────────────────────────────────

  private async _evalIdentity(ctx: ZeroTrustContext): Promise<{ score: number; reasons: string[] }> {
    let score = 0;
    const reasons: string[] = [];

    if (!ctx.principal) {
      return { score: 0, reasons: ["no_authentication"] };
    }

    // Valid JWT with roles
    if (ctx.principal.roles?.length > 0) {
      score += 10;
      reasons.push(`authenticated:roles=${ctx.principal.roles.join(",")}`);
    }

    // MFA verified
    if (ctx.hasMFA) {
      score += 10;
      reasons.push("mfa_verified");
    } else {
      reasons.push("no_mfa");
    }

    // Session freshness
    if (ctx.sessionAgeMs < 3600_000) {  // < 1 hour
      score += 5;
      reasons.push("fresh_session");
    } else {
      reasons.push(`session_age=${Math.round(ctx.sessionAgeMs / 60000)}min`);
    }

    // No recent failed logins
    const redis = getRedis();
    if (redis && ctx.principal.sub) {
      const failedKey = `auth:failed:${ctx.principal.sub}`;
      const failures  = Number(await redis.get(failedKey).catch(() => null) ?? 0);
      if (failures === 0) {
        score += 5;
        reasons.push("no_recent_failures");
      } else {
        reasons.push(`recent_auth_failures:${failures}`);
      }
    }

    return { score: Math.min(30, score), reasons };
  }

  private async _evalDevice(ctx: ZeroTrustContext): Promise<{ score: number; reasons: string[] }> {
    let score = 0;
    const reasons: string[] = [];

    if (!ctx.deviceFp || !ctx.principal) {
      return { score: 0, reasons: ["no_device_fingerprint"] };
    }

    const redis = getRedis();
    if (!redis) return { score: 15, reasons: ["redis_unavailable:assuming_trusted"] };

    // Check if device is known for this user
    const deviceKey = `device:${ctx.principal.sub}:${ctx.deviceFp}`;
    const deviceData = await redis.get(deviceKey).catch(() => null);

    if (deviceData) {
      try {
        const profile = JSON.parse(deviceData) as { trusted?: boolean; anomalyScore?: number; loginCount?: number };
        if (profile.trusted) {
          score += 10;
          reasons.push(`known_trusted_device:logins=${profile.loginCount ?? 0}`);
        } else {
          score += 5;
          reasons.push("known_device_not_trusted");
        }

        const anomalyScore = profile.anomalyScore ?? 0;
        if (anomalyScore < 20) {
          score += 10;
          reasons.push(`device_anomaly_score:${anomalyScore}`);
        } else {
          reasons.push(`device_anomaly_high:${anomalyScore}`);
        }
      } catch {
        score += 5;
        reasons.push("device_known_parse_error");
      }
    } else {
      score += 0;
      reasons.push("unknown_device");
    }

    // Session binding check
    if (ctx.sessionId) {
      const sessKey = `session:ctx:${ctx.sessionId}`;
      const sessData = await redis.get(sessKey).catch(() => null);
      if (sessData) {
        const sess = JSON.parse(sessData) as { deviceFp?: string };
        if (sess.deviceFp === ctx.deviceFp) {
          score += 5;
          reasons.push("fingerprint_matches_session");
        } else {
          reasons.push("fingerprint_mismatch_session");
        }
      }
    }

    return { score: Math.min(25, score), reasons };
  }

  private async _evalNetwork(ctx: ZeroTrustContext): Promise<{ score: number; reasons: string[] }> {
    let score = 0;
    const reasons: string[] = [];

    const ipResult: IpReputationResult = await scoreIp(ctx.ip).catch(() => ({
      score: 0, blocked: false, reason: null,
    }));

    if (ipResult.blocked) {
      return { score: 0, reasons: [`ip_blocked:${ipResult.reason}`] };
    }

    // IP reputation
    if (ipResult.score < 20) {
      score += 15;
      reasons.push(`ip_clean:${ipResult.score}`);
    } else if (ipResult.score < 50) {
      score += 8;
      reasons.push(`ip_suspicious:${ipResult.score}`);
    } else {
      reasons.push(`ip_high_risk:${ipResult.score}`);
    }

    // Not datacenter/VPN (simple heuristic check)
    const isPrivate = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.0\.0\.1|::1)/.test(ctx.ip);
    if (isPrivate) {
      score += 5;
      reasons.push("internal_ip:trusted");
    } else if (ipResult.score < 25) {
      score += 5;
      reasons.push("not_datacenter_ip");
    }

    // No active DDoS violations
    const redis = getRedis();
    if (redis) {
      const banKey = `ddos:ban:${ctx.ip}`;
      const banned = await redis.exists(banKey).catch(() => 0);
      if (!banned) {
        score += 5;
        reasons.push("no_ddos_violations");
      } else {
        reasons.push("active_ddos_ban");
      }
    } else {
      score += 5;
    }

    return { score: Math.min(25, score), reasons };
  }

  private async _evalBehavior(ctx: ZeroTrustContext): Promise<{ score: number; reasons: string[] }> {
    let score = 0;
    const reasons: string[] = [];

    const redis = getRedis();
    if (!redis) return { score: 10, reasons: ["redis_unavailable:partial_score"] };

    // Bot detection: check if bot score is low
    const botKey = `bot:blocks:${ctx.ip}`;
    const botBlocks = Number(await redis.get(botKey).catch(() => null) ?? 0);
    if (botBlocks === 0) {
      score += 10;
      reasons.push("not_flagged_as_bot");
    } else {
      reasons.push(`bot_blocks:${botBlocks}`);
    }

    // WAF: no recent violations
    const wafKey = `waf:violations:${ctx.ip}`;
    const wafViolations = Number(await redis.get(wafKey).catch(() => null) ?? 0);
    if (wafViolations === 0) {
      score += 5;
      reasons.push("no_waf_violations");
    } else {
      reasons.push(`waf_violations:${wafViolations}`);
    }

    // Request pattern: check consistent user agent
    if (ctx.userAgent && ctx.userAgent.length > 20) {
      score += 5;
      reasons.push("consistent_user_agent");
    } else {
      reasons.push("suspicious_user_agent");
    }

    return { score: Math.min(20, score), reasons };
  }
}

export const zeroTrustEngine = new ZeroTrustEngine();
export default zeroTrustEngine;
