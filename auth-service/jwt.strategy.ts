import { verifyToken, type TokenPayload } from "../shared/security.js";
import type { IncomingMessage }           from "node:http";

/**
 * JwtStrategy — HTTP request JWT extraction + validation.
 *
 * Supports:
 *   Authorization: Bearer <token>
 *   X-Access-Token: <token>   (legacy / WebSocket handshakes)
 *
 * Works with both HS256 (JWT_SECRET) and RS256 (JWT_PUBLIC_KEY).
 */
class JwtStrategyService {
  private readonly verifyKey: string;

  constructor() {
    const pubKey    = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, "\n") ?? "";
    const secret    = process.env.JWT_SECRET ?? "";
    this.verifyKey  = pubKey.includes("BEGIN") ? pubKey : secret;
  }

  extractToken(req: IncomingMessage): string | null {
    const auth  = req.headers["authorization"] ?? "";
    if (auth.startsWith("Bearer ")) return auth.slice(7).trim();

    const legacy = req.headers["x-access-token"];
    if (typeof legacy === "string" && legacy) return legacy.trim();

    return null;
  }

  extractFromHeader(authHeader: string | undefined): string | null {
    if (!authHeader) return null;
    if (authHeader.startsWith("Bearer ")) return authHeader.slice(7).trim();
    return authHeader.trim() || null;
  }

  validate(token: string): TokenPayload | null {
    if (!this.verifyKey) return null;
    return verifyToken(token, this.verifyKey);
  }

  validateRequest(req: IncomingMessage): TokenPayload | null {
    const token = this.extractToken(req);
    if (!token) return null;
    return this.validate(token);
  }
}

export const jwtStrategy = new JwtStrategyService();
export default jwtStrategy;
