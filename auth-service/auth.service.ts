import { randomUUID }                                    from "node:crypto";
import { prisma, IS_PERSISTENT }                         from "../shared/db.js";
import { createOpaqueToken }                             from "../shared/security.js";
import { jwtKeyManager }                                 from "../security/jwt-key-manager.js";
import { trackLoginAttempt, isAccountLocked }            from "../security/event-correlator.js";
import { upsertDeviceProfile, computeFingerprintFromParts } from "../security/device-fingerprint.js";
import { sessionManager }                                from "./session.manager.js";
import { suspiciousLogin }                               from "./suspicious.login.js";
import { geoipSecurity }                                 from "./geoip.security.js";
import { accessPolicy }                                  from "./access.policy.js";
import { hashPassword, verifyPassword, needsUpgrade }    from "./password.hasher.js";
import type { Principal }                                from "../shared/contracts.js";
import { formatAccountNumber }                           from "../shared/account-number.js";
import { eventBus }                                      from "../events-bus/event.bus.js";
import { twoFactorService }                              from "./2fa.service.js";
import {
  issueLoginMfaChallenge,
  consumeLoginMfaChallenge,
  loginMfaChallengeTtlSeconds,
}                                                         from "./login.mfa.challenge.js";

const TOKEN_TTL = 3_600; // 1 hour

export type LoginContext = {
  ip?:        string;
  userAgent?: string;
};

export type AuthResult = {
  ok:           boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?:   number;
  tokenType?:   "Bearer";
  principal?:   Principal;
  tenantId?:    string;
  reason?:      string;
  requiresMfa?: boolean;
  /** Present only when requiresMfa is true — pass to completeMfaLogin() with the TOTP code. */
  mfaToken?:    string;
};

/**
 * AuthService — DB-backed authentication orchestrator.
 *
 * Handles:
 *   - Password hashing (Argon2id, OWASP recommended parameters)
 *   - Login with geo + suspicious-login checks
 *   - Register (creates User + WalletAccount)
 *   - Token refresh (delegates to sessionManager)
 *   - Session revocation
 *
 * Falls back gracefully when DATABASE_URL is absent (SANDBOX mode).
 */
class AuthService {
  // ── Login ─────────────────────────────────────────────────────────────────────

  async login(email: string, password: string, ctx: LoginContext = {}): Promise<AuthResult> {
    if (!IS_PERSISTENT) return { ok: false, reason: "DB_UNAVAILABLE" };

    const db   = prisma as NonNullable<typeof prisma>;
    const user = await db.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    // Event correlator: check if account is locked by SIEM pattern
    const lockReason = await isAccountLocked(email).catch(() => null);
    if (lockReason) return { ok: false, reason: "ACCOUNT_LOCKED" };

    if (!user) {
      await suspiciousLogin.recordFailedAttempt(ctx.ip ?? "unknown", email);
      void trackLoginAttempt(ctx.ip ?? "unknown", email, true).catch(() => null);
      return { ok: false, reason: "INVALID_CREDENTIALS" };
    }

    const valid = await verifyPassword(user.password, password);
    if (!valid) {
      await suspiciousLogin.recordFailedAttempt(ctx.ip ?? "unknown", email);
      void trackLoginAttempt(ctx.ip ?? "unknown", email, true).catch(() => null);
      const fingerprint = computeFingerprintFromParts(ctx.ip ?? "", ctx.userAgent ?? "");
      void upsertDeviceProfile(user.id, fingerprint, ctx.ip ?? "", "login_failed").catch(() => null);
      return { ok: false, reason: "INVALID_CREDENTIALS" };
    }

    // Lazy upgrade: silently re-hash any legacy scrypt hash to Argon2id on next login.
    if (needsUpgrade(user.password)) {
      void hashPassword(password).then((h) =>
        db.user.update({ where: { id: user.id }, data: { password: h } }).catch(() => {})
      );
    }

    // Geo check — fail open on provider errors
    if (ctx.ip) {
      try {
        const geo = await geoipSecurity.check(ctx.ip);
        if (geo.isBlocked) return { ok: false, reason: "GEO_BLOCKED" };
      } catch { /* non-fatal */ }
    }

    // ── Fix #3: gate the session on 2FA when the user has it enrolled ──────
    // Password alone must never be enough to obtain a full session for an
    // account with TOTP enabled — issue a short-lived challenge instead and
    // require completeMfaLogin() to actually mint the access/refresh tokens.
    const mfaEnabled = await twoFactorService.isEnabled(user.id).catch(() => false);
    if (mfaEnabled) {
      const mfaToken = await issueLoginMfaChallenge(user.id);
      return {
        ok: true,
        requiresMfa: true,
        mfaToken,
        expiresIn: loginMfaChallengeTtlSeconds(),
      };
    }

    void suspiciousLogin.recordSuccess(user.id, ctx.ip ?? "unknown", ctx.userAgent ?? "");
    const fingerprint = computeFingerprintFromParts(ctx.ip ?? "", ctx.userAgent ?? "");
    void upsertDeviceProfile(user.id, fingerprint, ctx.ip ?? "", "login_success").catch(() => null);

    return this._issueSession(user);
  }

  /**
   * Completes a login that was gated on 2FA by login(): consumes the
   * single-use challenge token and, if the TOTP/backup code is valid, mints
   * the real access/refresh tokens. This is the ONLY way to obtain a full
   * session for an account with 2FA enrolled — there is no path that skips it.
   */
  async completeMfaLogin(mfaToken: string, code: string, ctx: LoginContext = {}): Promise<AuthResult> {
    if (!IS_PERSISTENT) return { ok: false, reason: "DB_UNAVAILABLE" };

    const userId = await consumeLoginMfaChallenge(mfaToken);
    if (!userId) return { ok: false, reason: "MFA_CHALLENGE_INVALID_OR_EXPIRED" };

    const db   = prisma as NonNullable<typeof prisma>;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return { ok: false, reason: "INVALID_CREDENTIALS" };

    const verifyResult = await twoFactorService.verify(userId, code);
    if (!verifyResult.valid) return { ok: false, reason: "INVALID_MFA_CODE" };

    void suspiciousLogin.recordSuccess(user.id, ctx.ip ?? "unknown", ctx.userAgent ?? "");
    const fingerprint = computeFingerprintFromParts(ctx.ip ?? "", ctx.userAgent ?? "");
    void upsertDeviceProfile(user.id, fingerprint, ctx.ip ?? "", "login_success").catch(() => null);

    return this._issueSession(user);
  }

  private async _issueSession(
    user: { id: string; email: string; fullName: string; tenantId: string; tier: string; kycStatus: string; roles: unknown; permissions: unknown },
  ): Promise<AuthResult> {
    const roles       = this._parseJson<string[]>(user.roles, []);
    const permissions = this._parseJson<string[]>(user.permissions,
      accessPolicy.getPermissionsForRoles(roles));

    const principal = this._buildPrincipal(user, roles, permissions);

    const accessToken  = jwtKeyManager.createToken(
      { sub: user.id, email: user.email, tenantId: user.tenantId, roles, permissions },
      TOKEN_TTL,
    );
    const refreshToken = await sessionManager.create(user.id);

    return {
      ok: true, accessToken, refreshToken,
      expiresIn: TOKEN_TTL, tokenType: "Bearer",
      principal, tenantId: user.tenantId,
    };
  }

  // ── Register ──────────────────────────────────────────────────────────────────

  async register(data: {
    email:     string;
    password:  string;
    fullName:  string;
    country?:  string;
    tier?:     string;
    authKey?:  string;
  }): Promise<AuthResult> {
    if (!IS_PERSISTENT) return { ok: false, reason: "DB_UNAVAILABLE" };

    const db      = prisma as NonNullable<typeof prisma>;
    const emailLc = data.email.toLowerCase().trim();

    const existing = await db.user.findUnique({ where: { email: emailLc } });
    if (existing) return { ok: false, reason: "EMAIL_TAKEN" };

    // Ensure default tenant exists
    let tenant = await db.tenant.findFirst();
    if (!tenant) {
      tenant = await db.tenant.create({
        data: { id: randomUUID(), name: "IGFXPRO Default", region: "EU" },
      });
    }

    const userId   = randomUUID();
    const hashedPw = await hashPassword(data.password);
    const roles    = ["trader"];
    const perms    = accessPolicy.getPermissionsForRoles(roles);

    const user = await db.user.create({
      data: {
        id:          userId,
        email:       emailLc,
        password:    hashedPw,
        fullName:    data.fullName,
        role:        "trader",
        roles:       JSON.stringify(roles),
        permissions: JSON.stringify(perms),
        tier:        data.tier ?? "STANDARD",
        kycStatus:   "not_started",
        tenantId:    tenant.id,
      },
    });

    // Create wallet account
    await db.walletAccount.create({
      data: { userId, currency: "USD", balance: 0, equity: 0, locked: 0 },
    }).catch(() => {});

    const principal  = this._buildPrincipal(user, roles, perms);
    const accessToken  = jwtKeyManager.createToken(
      { sub: user.id, email: user.email, tenantId: user.tenantId, roles, permissions: perms },
      TOKEN_TTL,
    );
    const refreshToken = await sessionManager.create(user.id);

    eventBus.emit("user.registered", {
      userId:        user.id,
      email:         user.email,
      fullName:      user.fullName,
      tier:          user.tier,
      accountNumber: principal.accountNumber!,
      timestamp:     new Date().toISOString(),
    });

    return {
      ok: true, accessToken, refreshToken,
      expiresIn: TOKEN_TTL, tokenType: "Bearer",
      principal, tenantId: user.tenantId,
    };
  }

  // ── Token refresh ─────────────────────────────────────────────────────────────

  async refresh(oldToken: string): Promise<AuthResult | null> {
    if (!IS_PERSISTENT) return null;

    const session = await sessionManager.validate(oldToken);
    if (!session) return null;

    const db   = prisma as NonNullable<typeof prisma>;
    const user = await db.user.findUnique({ where: { id: session.userId } });
    if (!user) return null;

    const roles       = this._parseJson<string[]>(user.roles, []);
    const permissions = this._parseJson<string[]>(user.permissions, []);

    const newRefreshToken = createOpaqueToken("rt");
    await sessionManager.rotate(oldToken, newRefreshToken, user.id);

    const accessToken = jwtKeyManager.createToken(
      { sub: user.id, email: user.email, tenantId: user.tenantId, roles, permissions },
      TOKEN_TTL,
    );
    const principal = this._buildPrincipal(user, roles, permissions);

    return {
      ok: true, accessToken, refreshToken: newRefreshToken,
      expiresIn: TOKEN_TTL, tokenType: "Bearer",
      principal, tenantId: user.tenantId,
    };
  }

  // ── Session management ────────────────────────────────────────────────────────

  async listSessions(userId: string) {
    return sessionManager.listActive(userId);
  }

  async revokeSession(token: string, requestingUserId: string): Promise<boolean> {
    const session = await sessionManager.validate(token);
    if (!session) return false;
    if (session.userId !== requestingUserId) return false;
    await sessionManager.revoke(token);
    return true;
  }

  async revokeAllSessions(userId: string): Promise<number> {
    return sessionManager.revokeAll(userId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private _parseJson<T>(val: unknown, fallback: T): T {
    if (Array.isArray(val)) return val as T;
    if (typeof val === "string") {
      try { return JSON.parse(val) as T; } catch { return fallback; }
    }
    return fallback;
  }

  private _buildPrincipal(
    user:        { id: string; email: string; fullName: string; tenantId: string; tier: string; kycStatus: string },
    roles:       string[],
    permissions: string[],
  ): Principal {
    return {
      sub:         user.id,
      email:       user.email,
      fullName:    user.fullName,
      tenantId:    user.tenantId,
      tier:        user.tier as Principal["tier"],
      roles:       roles as Principal["roles"],
      permissions,
      kycStatus:   user.kycStatus as Principal["kycStatus"],
      mfaRequired: false,
      accountNumber: formatAccountNumber(user.id),
    };
  }
}

export const authService = new AuthService();
export default authService;
