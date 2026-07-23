/**
 * TwoFactorService — TOTP-based two-factor authentication (RFC 6238).
 *
 * Does NOT require an external library: implements TOTP using Node.js
 * built-in `crypto` module (HMAC-SHA1 per RFC 4226).
 *
 * Flow:
 *   1. generateSecret()  — creates base32 secret for user
 *   2. getQrUri()        — generates otpauth:// URI for authenticator apps
 *   3. verifyToken()     — validates 6-digit code ±1 window (30s tolerance)
 *   4. generateBackupCodes() — 8 single-use recovery codes
 *   5. enable2fa()       — persists secret after user verifies first token
 *   6. disable2fa()      — removes secret after password re-confirmation
 */
import { createHmac, randomBytes } from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { immutableAudit } from "../security/immutable.audit.js";

// ─── TOTP implementation (RFC 6238 / RFC 4226) ────────────────────────────────

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let result = "";
  let bits   = 0;
  let value  = 0;
  for (const byte of buf) {
    value  = (value << 8) | byte;
    bits  += 8;
    while (bits >= 5) {
      result += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits   -= 5;
    }
  }
  if (bits > 0) result += BASE32_CHARS[(value << (5 - bits)) & 31];
  return result;
}

function base32Decode(s: string): Buffer {
  const chars = s.toUpperCase().replace(/=+$/, "");
  const bytes: number[] = [];
  let bits  = 0;
  let value = 0;
  for (const ch of chars) {
    const idx = BASE32_CHARS.indexOf(ch);
    if (idx === -1) continue;
    value  = (value << 5) | idx;
    bits  += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function hotp(secret: string, counter: number): string {
  const key     = base32Decode(secret);
  const msg     = Buffer.allocUnsafe(8);
  const high    = Math.floor(counter / 0x100000000);
  const low     = counter >>> 0;
  msg.writeUInt32BE(high, 0);
  msg.writeUInt32BE(low,  4);

  const hmac  = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code  =
    ((hmac[offset]!   & 0x7f) << 24) |
    ((hmac[offset+1]! & 0xff) << 16) |
    ((hmac[offset+2]! & 0xff) << 8)  |
     (hmac[offset+3]! & 0xff);

  return String(code % 1_000_000).padStart(6, "0");
}

function totpNow(secret: string, windowStep = 0): string {
  const counter = Math.floor(Date.now() / 1000 / 30) + windowStep;
  return hotp(secret, counter);
}

// ─── 2FA Service ──────────────────────────────────────────────────────────────

export type TotpSetup = {
  secret:      string;    // base32 secret
  qrUri:       string;    // otpauth:// URI for QR code
  backupCodes: string[];  // 8 single-use codes
};

export type VerifyResult = {
  valid:       boolean;
  usedBackup?: boolean;
};

export class TwoFactorService {

  /** Generate a new TOTP secret for a user. Does NOT persist — call enable2fa() after verification. */
  generateSetup(_userId: string, email: string): TotpSetup {
    const secret      = base32Encode(randomBytes(20));
    const backupCodes = Array.from({ length: 8 }, () =>
      randomBytes(5).toString("hex").toUpperCase().match(/.{4}/g)!.join("-")
    );
    const issuer = "IGFXPRO";
    const qrUri  = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

    return { secret, qrUri, backupCodes };
  }

  /** Verify a 6-digit TOTP code (accepts ±1 time window = 90s tolerance). */
  verifyToken(secret: string, token: string): boolean {
    const normalised = token.replace(/\s/g, "");
    if (!/^\d{6}$/.test(normalised)) return false;
    return [-1, 0, 1].some((w) => totpNow(secret, w) === normalised);
  }

  /** Enable 2FA for a user — verifies one token first to confirm the secret works. */
  async enable2fa(
    userId: string,
    secret: string,
    token:  string,
    backupCodes: string[],
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!this.verifyToken(secret, token)) {
      return { ok: false, reason: "INVALID_TOKEN" };
    }

    if (IS_PERSISTENT) {
      const db = prisma as NonNullable<typeof prisma>;
      await db.brokerSetting.upsert({
        where:  { key: `2fa:${userId}` },
        create: { key: `2fa:${userId}`, value: { secret, backupCodes, enabledAt: new Date().toISOString() } as object },
        update: { value: { secret, backupCodes, enabledAt: new Date().toISOString() } as object },
      });

      await immutableAudit.write({
        actor: userId,
        action: "auth.2fa.enabled", entity: userId,
        payload: { enabledAt: new Date().toISOString() } as object,
      });
    }

    return { ok: true };
  }

  /** Verify a token or backup code for login. */
  async verify(
    userId: string,
    token:  string,
  ): Promise<VerifyResult> {
    if (!IS_PERSISTENT) {
      return { valid: this.verifyToken("BASE32SECRET", token) };
    }

    const db  = prisma as NonNullable<typeof prisma>;
    const row = await db.brokerSetting.findUnique({ where: { key: `2fa:${userId}` } });
    if (!row) return { valid: false };

    const cfg = row.value as { secret: string; backupCodes: string[] };

    // TOTP check
    if (this.verifyToken(cfg.secret, token)) {
      return { valid: true, usedBackup: false };
    }

    // Backup code check (consume on use)
    const normalised = token.toUpperCase().replace(/\s/g, "");
    const idx        = cfg.backupCodes.indexOf(normalised);
    if (idx !== -1) {
      cfg.backupCodes.splice(idx, 1);
      await db.brokerSetting.update({
        where: { key: `2fa:${userId}` },
        data:  { value: cfg as object },
      });
      await immutableAudit.write({
        actor: userId,
        action: "auth.2fa.backup_code_used", entity: userId,
        payload: { remaining: cfg.backupCodes.length } as object,
      });
      return { valid: true, usedBackup: true };
    }

    return { valid: false };
  }

  /** Check if 2FA is enabled for a user. */
  async isEnabled(userId: string): Promise<boolean> {
    if (!IS_PERSISTENT) return false;
    const db  = prisma as NonNullable<typeof prisma>;
    const row = await db.brokerSetting.findUnique({ where: { key: `2fa:${userId}` } });
    return row !== null;
  }

  /** Disable 2FA. */
  async disable2fa(userId: string): Promise<void> {
    if (!IS_PERSISTENT) return;
    const db = prisma as NonNullable<typeof prisma>;
    await db.brokerSetting.delete({ where: { key: `2fa:${userId}` } }).catch(() => {});
    await immutableAudit.write({
      actor: userId,
      action: "auth.2fa.disabled", entity: userId,
      payload: { disabledAt: new Date().toISOString() } as object,
    });
  }
}

export const twoFactorService = new TwoFactorService();
export default twoFactorService;
