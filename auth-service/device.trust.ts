import { createHmac } from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

export type DeviceTrustInfo = {
  trusted: boolean;
  deviceId: string;
  knownDevice: boolean;
  requiresOtp: boolean;
};

/**
 * DeviceTrustService — deterministic device fingerprinting + trust store.
 *
 * Fingerprint = HMAC-SHA256(ip + userAgent), stored as BrokerSetting.
 * Once trusted (after successful MFA), subsequent logins from same device
 * skip the OTP challenge window.
 */
class DeviceTrustService {
  private readonly SECRET = process.env.DEVICE_TRUST_SECRET ?? "igfxpro-device-trust-dev";

  fingerprint(userAgent: string, ip: string): string {
    return createHmac("sha256", this.SECRET)
      .update(`${ip.split(",")[0].trim()}:${userAgent.slice(0, 250)}`)
      .digest("hex")
      .slice(0, 16);
  }

  async evaluate(userId: string, deviceId: string): Promise<DeviceTrustInfo> {
    let knownDevice = false;

    if (IS_PERSISTENT) {
      const rec = await (prisma as NonNullable<typeof prisma>).brokerSetting.findUnique({
        where: { key: `device:${userId}:${deviceId}` },
      });
      knownDevice = rec !== null && (rec.value as Record<string, unknown>)?.trusted === true;
    }

    return {
      trusted:      knownDevice,
      deviceId,
      knownDevice,
      requiresOtp:  !knownDevice,
    };
  }

  async trust(userId: string, deviceId: string): Promise<void> {
    if (!IS_PERSISTENT) return;
    const value = { trusted: true, trustedAt: new Date().toISOString() };
    await (prisma as NonNullable<typeof prisma>).brokerSetting.upsert({
      where:  { key: `device:${userId}:${deviceId}` },
      create: { key: `device:${userId}:${deviceId}`, value },
      update: { value },
    });
  }

  async revoke(userId: string, deviceId: string): Promise<void> {
    if (!IS_PERSISTENT) return;
    await (prisma as NonNullable<typeof prisma>).brokerSetting
      .delete({ where: { key: `device:${userId}:${deviceId}` } })
      .catch(() => {});
  }

  async revokeAll(userId: string): Promise<number> {
    if (!IS_PERSISTENT) return 0;
    const { count } = await (prisma as NonNullable<typeof prisma>).brokerSetting.deleteMany({
      where: { key: { startsWith: `device:${userId}:` } },
    });
    return count;
  }
}

export const deviceTrust = new DeviceTrustService();
export default deviceTrust;
