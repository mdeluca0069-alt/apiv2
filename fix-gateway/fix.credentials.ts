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
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { verifyPassword } from "../auth-service/password.hasher.js";

/**
 * Returns the verified user's id on success, or null if the credentials are
 * invalid, the account doesn't exist, or the platform is running without a
 * database (FIX sessions cannot be authenticated in sandbox mode — reject).
 */
export async function verifyFixCredentials(username: string, password: string): Promise<string | null> {
  if (!IS_PERSISTENT || !prisma) return null;

  const user = await prisma.user.findUnique({
    where: { email: username.toLowerCase().trim() },
  });
  if (!user) return null;

  const valid = await verifyPassword(user.password, password);
  if (!valid) return null;

  return user.id;
}
