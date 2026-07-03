import { createOpaqueToken } from "../shared/security.js";
import { sessionManager } from "./session.manager.js";

/**
 * RefreshTokenService — wraps session.manager with token-rotation semantics.
 *
 * Each valid refresh-token maps 1:1 to a Session row. On rotate:
 *   1. Old token is deleted atomically.
 *   2. New token is inserted in the same DB transaction.
 * This eliminates the window where both old+new tokens are valid.
 */
class RefreshTokenService {
  generate(): string {
    return createOpaqueToken("rt");
  }

  /**
   * Rotate: validate old token, issue new one.
   * Returns new token on success, null if the old token was invalid/expired.
   */
  async rotate(oldToken: string, userId: string): Promise<string | null> {
    const session = await sessionManager.validate(oldToken);
    if (!session || session.userId !== userId) return null;

    const newToken = this.generate();
    await sessionManager.rotate(oldToken, newToken, userId);
    return newToken;
  }

  /** Revoke a specific token. */
  async revoke(token: string): Promise<void> {
    await sessionManager.revoke(token);
  }

  /** Revoke all tokens for a user. */
  async revokeAll(userId: string): Promise<void> {
    await sessionManager.revokeAll(userId);
  }
}

export const refreshTokenService = new RefreshTokenService();
export default refreshTokenService;
