import { randomUUID } from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

export type SuspiciousLoginAssessment = {
  suspicious: boolean;
  reasons:    string[];
  riskScore:  number;
};

/**
 * SuspiciousLoginService — login anomaly detection.
 *
 * Checks:
 * 1. Brute-force: ≥3 failed attempts from same IP in last 15 min
 * 2. Credential stuffing: ≥10 failed attempts from same IP across any account
 * 3. New IP: login from an IP not seen in the user's last 5 successful logins
 * 4. Missing/short user-agent (likely bot)
 *
 * All events are persisted to AuditLog for SIEM ingestion.
 */
class SuspiciousLoginService {
  async assess(
    userId:    string,
    ip:        string,
    userAgent: string,
  ): Promise<SuspiciousLoginAssessment> {
    const reasons:   string[] = [];
    let   riskScore            = 0;
    const since15m   = new Date(Date.now() - 15 * 60_000);

    if (IS_PERSISTENT) {
      const db = prisma as NonNullable<typeof prisma>;

      // Brute-force: same IP, any account
      const ipFailures = await db.auditLog.count({
        where: {
          actor:     ip,
          action:    "auth.login.failed",
          createdAt: { gte: since15m },
        },
      });
      if (ipFailures >= 10) {
        reasons.push(`IP brute-force: ${ipFailures} failures in 15 min`);
        riskScore += 60;
      } else if (ipFailures >= 3) {
        reasons.push(`${ipFailures} failed login attempts from this IP in 15 min`);
        riskScore += 25;
      }

      // New-IP detection: compare against last 5 successful logins
      const recentSuccess = await db.auditLog.findMany({
        where:   { entity: userId, action: "auth.login.success" },
        orderBy: { createdAt: "desc" },
        take:    5,
        select:  { payload: true },
      });
      if (recentSuccess.length >= 2) {
        const knownIps = recentSuccess
          .map((s) => (s.payload as Record<string, unknown>)?.ip as string)
          .filter(Boolean);
        if (knownIps.length > 0 && !knownIps.includes(ip)) {
          reasons.push("Login from a previously unseen IP address");
          riskScore += 20;
        }
      }
    }

    // Bot detection
    if (!userAgent || userAgent.length < 10) {
      reasons.push("Missing or suspiciously short user-agent header");
      riskScore += 30;
    }

    return {
      suspicious: riskScore >= 40,
      reasons,
      riskScore,
    };
  }

  async recordFailedAttempt(ip: string, email: string): Promise<void> {
    if (!IS_PERSISTENT) return;
    await (prisma as NonNullable<typeof prisma>).auditLog.create({
      data: {
        id:      randomUUID(),
        actor:   ip,
        action:  "auth.login.failed",
        entity:  email.toLowerCase(),
        payload: { ip, email, at: new Date().toISOString() } as object,
      },
    }).catch(() => {});
  }

  async recordSuccess(userId: string, ip: string, userAgent: string): Promise<void> {
    if (!IS_PERSISTENT) return;
    await (prisma as NonNullable<typeof prisma>).auditLog.create({
      data: {
        id:      randomUUID(),
        actor:   ip,
        action:  "auth.login.success",
        entity:  userId,
        payload: { ip, ua: userAgent.slice(0, 200), at: new Date().toISOString() } as object,
      },
    }).catch(() => {});
  }
}

export const suspiciousLogin = new SuspiciousLoginService();
export default suspiciousLogin;
