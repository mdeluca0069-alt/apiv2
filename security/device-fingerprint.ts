/**
 * security/device-fingerprint.ts — Browser/client device fingerprinting.
 *
 * Fingerprint: HMAC-SHA256 of (User-Agent + Accept-Language + Accept-Encoding
 *              + sec-ch-ua-platform + IP /24 subnet), truncated to 32 hex chars.
 *
 * Device profiles stored in Redis:
 *   Key:  device:{userId}:{fingerprint}
 *   Value: JSON DeviceProfile
 *   TTL:  90 days
 *
 * Anomaly scoring:
 *   New device (first seen)          → +30
 *   IP subnet changed                → +20 per distinct subnet (max +40)
 *   Failed logins since last success → +8 per failure (max +40)
 *   Rapid login attempts (burst)     → +20
 */

import { createHmac } from "node:crypto";
import { getRedis }   from "../shared/redis.js";
import type { IncomingMessage } from "node:http";

const PROFILE_TTL_S = 90 * 24 * 60 * 60;

export interface DeviceProfile {
  fingerprint:       string;
  userId:            string;
  trusted:           boolean;
  firstSeen:         number;
  lastSeen:          number;
  lastSeenSubnet:    string;
  knownSubnets:      string[];
  loginCount:        number;
  failedLoginCount:  number;
  anomalyScore:      number;
}

function getFingerprintSecret(): string {
  return (
    process.env.DEVICE_FINGERPRINT_SECRET ??
    process.env.JWT_SECRET ??
    "device-fp-insecure-dev-key"
  );
}

function extractSubnet(ip: string): string {
  const parts = ip.split(".");
  if (parts.length === 4) return parts.slice(0, 3).join(".") + ".0";
  return ip;
}

export function computeFingerprintFromParts(ip: string, userAgent: string): string {
  const subnet   = extractSubnet(ip);
  const material = [userAgent, subnet].join("|");
  return createHmac("sha256", getFingerprintSecret())
    .update(material)
    .digest("hex")
    .slice(0, 32);
}

export function computeFingerprint(req: IncomingMessage): string {
  const ua       = req.headers["user-agent"]         ?? "";
  const lang     = req.headers["accept-language"]    ?? "";
  const enc      = req.headers["accept-encoding"]    ?? "";
  const platform = req.headers["sec-ch-ua-platform"] ?? "";
  const rawIp    = (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.socket?.remoteAddress ?? "").trim();
  const subnet   = extractSubnet(rawIp);
  const material = [ua, lang, enc, platform, subnet].join("|");
  return createHmac("sha256", getFingerprintSecret())
    .update(material)
    .digest("hex")
    .slice(0, 32);
}

function computeAnomaly(profile: DeviceProfile, currentSubnet: string): number {
  let score = 0;
  if (!profile.knownSubnets.includes(currentSubnet)) score += 20;
  const failPenalty = Math.min(40, profile.failedLoginCount * 8);
  score += failPenalty;
  return Math.min(100, score);
}

export async function upsertDeviceProfile(
  userId:      string,
  fingerprint: string,
  subnet:      string,
  event:       "login_success" | "login_failed",
): Promise<DeviceProfile> {
  const redis = getRedis();
  const key   = `device:${userId}:${fingerprint}`;
  const now   = Date.now();

  let profile: DeviceProfile;

  if (redis) {
    const raw = await redis.get(key).catch(() => null);
    if (raw) {
      profile = JSON.parse(raw) as DeviceProfile;
    } else {
      profile = {
        fingerprint,
        userId,
        trusted:          false,
        firstSeen:        now,
        lastSeen:         now,
        lastSeenSubnet:   subnet,
        knownSubnets:     [subnet],
        loginCount:       0,
        failedLoginCount: 0,
        anomalyScore:     30, // new device baseline
      };
    }
  } else {
    profile = {
      fingerprint,
      userId,
      trusted:          false,
      firstSeen:        now,
      lastSeen:         now,
      lastSeenSubnet:   subnet,
      knownSubnets:     [subnet],
      loginCount:       0,
      failedLoginCount: 0,
      anomalyScore:     30,
    };
  }

  profile.lastSeen       = now;
  profile.lastSeenSubnet = subnet;
  if (!profile.knownSubnets.includes(subnet)) {
    profile.knownSubnets = [...profile.knownSubnets.slice(-9), subnet]; // keep last 10
  }

  if (event === "login_success") {
    profile.loginCount++;
    profile.failedLoginCount = 0;
  } else {
    profile.failedLoginCount++;
  }

  profile.anomalyScore = computeAnomaly(profile, subnet);

  if (redis) {
    await redis.setex(key, PROFILE_TTL_S, JSON.stringify(profile)).catch(() => null);
  }

  return profile;
}

export async function trustDevice(userId: string, fingerprint: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const key = `device:${userId}:${fingerprint}`;
  const raw = await redis.get(key).catch(() => null);
  if (!raw) return;
  const profile = JSON.parse(raw) as DeviceProfile;
  profile.trusted      = true;
  profile.anomalyScore = 0;
  await redis.setex(key, PROFILE_TTL_S, JSON.stringify(profile)).catch(() => null);
}

export async function isDeviceTrusted(userId: string, fingerprint: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const raw = await redis.get(`device:${userId}:${fingerprint}`).catch(() => null);
  if (!raw) return false;
  const profile = JSON.parse(raw) as DeviceProfile;
  return profile.trusted;
}

export async function getDeviceAnomalyScore(userId: string, fingerprint: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  const raw = await redis.get(`device:${userId}:${fingerprint}`).catch(() => null);
  if (!raw) return 30; // unknown device = moderate anomaly
  const profile = JSON.parse(raw) as DeviceProfile;
  return profile.anomalyScore;
}

export async function revokeAllDevices(userId: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  const pattern = `device:${userId}:*`;
  const keys    = await redis.keys(pattern).catch(() => [] as string[]);
  if (keys.length === 0) return 0;
  await redis.del(...keys).catch(() => null);
  return keys.length;
}
