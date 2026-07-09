import { authService }      from "./auth.service.js";
import { sessionManager }   from "./session.manager.js";
import { IS_PERSISTENT }    from "../shared/db.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * AuthController — HTTP handlers for DB-backed auth endpoints.
 *
 * Handlers follow the same signature as the shared Route system:
 * ({ body, req, res, state, authHeader, query, params }) => result | Promise<result>
 *
 * These are wired into routes.ts alongside the legacy in-memory handlers.
 * When IS_PERSISTENT is true, these take precedence.
 */

type RouteContext = {
  body?:       unknown;
  req:         IncomingMessage;
  res:         ServerResponse;
  authHeader?: string;
  state:       import("../shared/state.js").BrokerState;
  query:       URLSearchParams;
  params:      Record<string, string>;
};

function extractIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function setCookieHeader(res: ServerResponse, token: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `igfxpro_rt=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}${secure}`
  );
}

function clearCookieHeader(res: ServerResponse): void {
  res.setHeader("Set-Cookie",
    "igfxpro_rt=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
  );
}

function extractRefreshFromCookie(req: IncomingMessage): string {
  const cookies = req.headers.cookie ?? "";
  return cookies
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("igfxpro_rt="))
    ?.slice("igfxpro_rt=".length) ?? "";
}

export const authController = {
  async login(ctx: RouteContext) {
    const body = ctx.body as Record<string, unknown>;
    const email    = String(body?.email    ?? "");
    const password = String(body?.password ?? "");
    const ip       = extractIp(ctx.req);
    const ua       = String(ctx.req.headers["user-agent"] ?? "");

    const result = await authService.login(email, password, { ip, userAgent: ua });

    if (!result.ok) {
      return { ok: false, reason: result.reason ?? "INVALID_CREDENTIALS" };
    }

    // Fix #3: password was correct but this account has 2FA enrolled — no
    // token is issued yet, only a short-lived challenge the client must
    // complete via POST /auth/login/db/mfa with the TOTP/backup code.
    if (result.requiresMfa) {
      return { ok: true, requiresMfa: true, mfaToken: result.mfaToken, expiresIn: result.expiresIn };
    }

    if (result.refreshToken) {
      setCookieHeader(ctx.res, result.refreshToken);
    }

    return {
      ok:           true,
      accessToken:  result.accessToken,
      expiresIn:    result.expiresIn,
      tokenType:    result.tokenType,
      principal:    result.principal,
      tenantId:     result.tenantId,
      refreshToken: undefined, // never expose in body
    };
  },

  async completeMfaLogin(ctx: RouteContext) {
    const body     = ctx.body as Record<string, unknown>;
    const mfaToken = String(body?.mfaToken ?? "");
    const code     = String(body?.code     ?? "");
    const ip       = extractIp(ctx.req);
    const ua       = String(ctx.req.headers["user-agent"] ?? "");

    if (!mfaToken || !code) {
      return { ok: false, reason: "MFA_TOKEN_AND_CODE_REQUIRED" };
    }

    const result = await authService.completeMfaLogin(mfaToken, code, { ip, userAgent: ua });

    if (!result.ok) {
      return { ok: false, reason: result.reason ?? "INVALID_MFA_CODE" };
    }

    if (result.refreshToken) {
      setCookieHeader(ctx.res, result.refreshToken);
    }

    return {
      ok:           true,
      accessToken:  result.accessToken,
      expiresIn:    result.expiresIn,
      tokenType:    result.tokenType,
      principal:    result.principal,
      tenantId:     result.tenantId,
      refreshToken: undefined, // never expose in body
    };
  },

  async register(ctx: RouteContext) {
    const body = ctx.body as Record<string, unknown>;
    const result = await authService.register({
      email:    String(body?.email    ?? ""),
      password: String(body?.password ?? ""),
      fullName: String(body?.fullName ?? ""),
      country:  body?.country ? String(body.country) : undefined,
      tier:     body?.tier    ? String(body.tier)    : undefined,
    });

    if (!result.ok) {
      return { ok: false, reason: result.reason ?? "REGISTRATION_FAILED" };
    }

    if (result.refreshToken) {
      setCookieHeader(ctx.res, result.refreshToken);
    }

    return {
      ok:          true,
      accessToken: result.accessToken,
      expiresIn:   result.expiresIn,
      tokenType:   result.tokenType,
      principal:   result.principal,
      tenantId:    result.tenantId,
      refreshToken: undefined,
    };
  },

  async refresh(ctx: RouteContext) {
    const cookieToken = extractRefreshFromCookie(ctx.req);
    const bodyToken   = String((ctx.body as Record<string, unknown>)?.refreshToken ?? "");
    const token       = cookieToken || bodyToken;

    if (!token) {
      return { ok: false, reason: "no_refresh_token" };
    }

    const result = await authService.refresh(token);
    if (!result || !result.ok) {
      clearCookieHeader(ctx.res);
      return { ok: false, reason: "invalid_refresh_token" };
    }

    if (result.refreshToken) {
      setCookieHeader(ctx.res, result.refreshToken);
    }

    return {
      ok:          true,
      accessToken: result.accessToken,
      expiresIn:   result.expiresIn,
      tokenType:   result.tokenType,
      principal:   result.principal,
      tenantId:    result.tenantId,
      refreshToken: undefined,
    };
  },

  async logout(ctx: RouteContext) {
    // Revoke the specific session token
    const token = extractRefreshFromCookie(ctx.req);
    if (token && IS_PERSISTENT) {
      await sessionManager.revoke(token).catch(() => {});
    }
    clearCookieHeader(ctx.res);
    return { ok: true };
  },

  async listSessions(ctx: RouteContext) {
    const principal = ctx.state.resolvePrincipal(ctx.authHeader);
    if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

    const sessions = await authService.listSessions(principal.sub);
    return {
      ok: true,
      sessions: sessions.map((s) => ({
        expiresAt: s.expiresAt.toISOString(),
        createdAt: s.createdAt.toISOString(),
        tokenHint: s.refreshToken.slice(0, 8) + "...",
      })),
    };
  },

  async revokeSession(ctx: RouteContext) {
    const principal = ctx.state.resolvePrincipal(ctx.authHeader);
    if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
    const token = String(ctx.params.token ?? "");
    if (!token) return { ok: false, reason: "token_required" };
    const ok = await authService.revokeSession(token, principal.sub);
    return { ok, reason: ok ? undefined : "NOT_FOUND_OR_UNAUTHORIZED" };
  },

  async revokeAllSessions(ctx: RouteContext) {
    const principal = ctx.state.resolvePrincipal(ctx.authHeader);
    if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
    clearCookieHeader(ctx.res);
    const count = await authService.revokeAllSessions(principal.sub);
    return { ok: true, revokedCount: count };
  },
};

export default authController;
