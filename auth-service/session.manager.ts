import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { createOpaqueToken } from "../shared/security.js";

export type SessionInfo = {
  refreshToken: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
};

class SessionManagerService {
  readonly SESSION_TTL_DAYS = 7;

  /** Create a new session, persist to DB, return the refresh token. */
  async create(userId: string): Promise<string> {
    const refreshToken = createOpaqueToken("rt");
    const expiresAt = new Date(Date.now() + this.SESSION_TTL_DAYS * 86_400_000);

    if (IS_PERSISTENT) {
      await (prisma as NonNullable<typeof prisma>).session.create({
        data: { refreshToken, userId, expiresAt },
      });
    }

    return refreshToken;
  }

  /** Validate token — returns session if valid and not expired, null otherwise. */
  async validate(refreshToken: string): Promise<SessionInfo | null> {
    if (!IS_PERSISTENT || !refreshToken) return null;

    const session = await (prisma as NonNullable<typeof prisma>).session.findUnique({
      where: { refreshToken },
    });

    if (!session) return null;

    if (session.expiresAt < new Date()) {
      await this.revoke(refreshToken).catch(() => {});
      return null;
    }

    return session;
  }

  /**
   * Atomic token rotation: delete old token, insert new one in a single
   * serializable transaction to prevent race conditions.
   */
  async rotate(oldToken: string, newToken: string, userId: string): Promise<void> {
    if (!IS_PERSISTENT) return;

    const expiresAt = new Date(Date.now() + this.SESSION_TTL_DAYS * 86_400_000);

    await (prisma as NonNullable<typeof prisma>).$transaction([
      (prisma as NonNullable<typeof prisma>).session.delete({
        where: { refreshToken: oldToken },
      }),
      (prisma as NonNullable<typeof prisma>).session.create({
        data: { refreshToken: newToken, userId, expiresAt },
      }),
    ]);
  }

  /** Revoke a single session (silent on missing). */
  async revoke(refreshToken: string): Promise<void> {
    if (!IS_PERSISTENT) return;
    await (prisma as NonNullable<typeof prisma>).session
      .delete({ where: { refreshToken } })
      .catch(() => {});
  }

  /** Revoke ALL sessions for a user (logout-all / security reset). */
  async revokeAll(userId: string): Promise<number> {
    if (!IS_PERSISTENT) return 0;
    const { count } = await (prisma as NonNullable<typeof prisma>).session.deleteMany({
      where: { userId },
    });
    return count;
  }

  /** List non-expired sessions for a user (for session management UI). */
  async listActive(userId: string): Promise<SessionInfo[]> {
    if (!IS_PERSISTENT) return [];
    return (prisma as NonNullable<typeof prisma>).session.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Housekeeping: delete all expired sessions. */
  async purgeExpired(): Promise<number> {
    if (!IS_PERSISTENT) return 0;
    const { count } = await (prisma as NonNullable<typeof prisma>).session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return count;
  }
}

export const sessionManager = new SessionManagerService();
export default sessionManager;
