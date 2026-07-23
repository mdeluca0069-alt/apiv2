import { IS_PERSISTENT } from "../shared/db.js";
import { immutableAudit } from "../security/immutable.audit.js";

/**
 * SuspiciousLoginService — records login attempt audit events for SIEM
 * ingestion. (The risk-scoring assess() method that used to read this
 * history back was never called anywhere and was removed — see
 * AUDIT_REALE_2026.md / Milestone 1 stabilization.)
 */
class SuspiciousLoginService {
  async recordFailedAttempt(ip: string, email: string): Promise<void> {
    if (!IS_PERSISTENT) return;
    await immutableAudit.write({
      actor:   ip,
      action:  "auth.login.failed",
      entity:  email.toLowerCase(),
      payload: { ip, email, at: new Date().toISOString() } as object,
    }).catch(() => {});
  }

  async recordSuccess(userId: string, ip: string, userAgent: string): Promise<void> {
    if (!IS_PERSISTENT) return;
    await immutableAudit.write({
      actor:   ip,
      action:  "auth.login.success",
      entity:  userId,
      payload: { ip, ua: userAgent.slice(0, 200), at: new Date().toISOString() } as object,
    }).catch(() => {});
  }
}

export const suspiciousLogin = new SuspiciousLoginService();
export default suspiciousLogin;
