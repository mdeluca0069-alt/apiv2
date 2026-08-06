/**
 * fix.credentials.ts — verifies FIX 4.4 Logon credentials against real user
 * accounts.
 *
 * Milestone 1 / Fix #4. Previously fix.acceptor.ts's handleLogon() accepted
 * any non-empty Account (tag 1) field as sufficient identification — no
 * password, no credential check of any kind. Anyone who could reach the FIX
 * port (opt-in via FIX_ENABLED=true) could log on claiming any existing
 * userId and place real orders on that account's behalf.
 *
 * This reuses the platform's real login credentials (Username=553 is the
 * account's email, Password=554 is their normal password, verified with the
 * same Argon2id hash used everywhere else) rather than inventing a separate
 * FIX-specific credential store — institutional users authenticate with the
 * same account they'd use on the web/mobile apps.
 *
 * FIX GATEWAY HARDENING: because this reuses each user's real platform
 * password, a FIX Logon that skipped the platform's existing brute-force
 * defenses would be a completely separate, unprotected attack surface
 * against the same credential that guards their wallet on the web/mobile
 * apps (see FIX_GATEWAY_EXPOSURE_REVIEW.md §5). This now calls the exact
 * same lockout/tracking functions auth-service/auth.service.ts's login()
 * already uses, in the same order: check isAccountLocked() before anything
 * else, record every failed attempt (unknown username OR wrong password)
 * via suspiciousLogin.recordFailedAttempt() + trackLoginAttempt() so the
 * same SIEM correlation engine (security/event-correlator.ts) that already
 * locks an account after repeated web-login failures also sees and locks
 * against repeated FIX-login failures, and record success the same way.
 */

import { prisma, IS_PERSISTENT }        from "../shared/db.js";
import { verifyPassword }               from "../auth-service/password.hasher.js";
import { isAccountLocked, trackLoginAttempt } from "../security/event-correlator.js";
import { suspiciousLogin }              from "../auth-service/suspicious.login.js";

/**
 * Returns the verified user's id on success, or null if the credentials are
 * invalid, the account is locked, the account doesn't exist, or the
 * platform is running without a database (FIX sessions cannot be
 * authenticated in sandbox mode — reject).
 *
 * @param ip Remote IP of the FIX TCP connection (session.socket.remoteAddress
 *           in fix.acceptor.ts) — required so failed attempts feed the same
 *           per-IP/per-email correlation windows the web login path uses.
 */
export async function verifyFixCredentials(username: string, password: string, ip: string): Promise<string | null> {
  if (!IS_PERSISTENT || !prisma) return null;

  const emailLc = username.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email: emailLc } });

  // Mirrors auth.service.ts's login(): check the SIEM lockout BEFORE
  // deciding whether the username/password themselves are correct, so a
  // locked account can't be used to distinguish "wrong password" from
  // "unknown username" via timing/response differences either.
  const lockReason = await isAccountLocked(username).catch(() => null);
  if (lockReason) return null;

  if (!user) {
    await suspiciousLogin.recordFailedAttempt(ip, emailLc);
    void trackLoginAttempt(ip, emailLc, true).catch(() => null);
    return null;
  }

  const valid = await verifyPassword(user.password, password);
  if (!valid) {
    await suspiciousLogin.recordFailedAttempt(ip, emailLc);
    void trackLoginAttempt(ip, emailLc, true).catch(() => null);
    return null;
  }

  void suspiciousLogin.recordSuccess(user.id, ip, "FIX/4.4");
  return user.id;
}
