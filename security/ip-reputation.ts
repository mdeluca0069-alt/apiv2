/**
 * security/ip-reputation.ts — IP reputation scoring (0 = clean, 100 = malicious).
 *
 * Scoring factors (additive, capped at 100):
 *   • Manual blocklist (Redis SET `iprep:blocked:{ip}`)  → instant block
 *   • Abuse counter   (Redis `iprep:abuse:{ip}`)          → up to +50
 *   • Velocity abuse  (>200 req/10s from same IP)         → +40
 *   • Known datacenter / hosting ASN prefix               → +25
 *   • RFC1918 / loopback                                  → score=0 (trusted)
 *
 * Results cached in Redis `iprep:score:{ip}` for 1 hour.
 */

import { getRedis } from "../shared/redis.js";

export interface IpReputationResult {
  score:   number;
  blocked: boolean;
  reason:  string | null;
}

// Datacenter / hosting CIDR prefixes (known proxy/VPN/datacenter ranges)
const DATACENTER_PREFIXES = [
  "45.79.", "104.236.", "159.203.", "165.227.", "206.189.",   // DigitalOcean
  "35.185.", "35.190.", "34.102.", "34.104.",                  // Google Cloud
  "54.193.", "54.219.", "107.21.",                             // AWS us-west/us-east
  "185.220.", "185.56.", "194.165.",                           // Tor exit nodes
  "192.42.", "176.10.", "176.58.",                             // Various VPN/proxy
];

const SCORE_TTL_S    = 60 * 60;       // 1 hour
const ABUSE_TTL_S    = 24 * 60 * 60;  // 24 hours
const BLOCK_TTL_S    = 7 * 24 * 60 * 60; // 7 days default

function isPrivateIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("10."))      return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1] ?? "0", 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function datacenterScore(ip: string): number {
  for (const prefix of DATACENTER_PREFIXES) {
    if (ip.startsWith(prefix)) return 25;
  }
  return 0;
}

export async function scoreIp(ip: string): Promise<IpReputationResult> {
  if (!ip || isPrivateIp(ip)) return { score: 0, blocked: false, reason: null };

  const redis = getRedis();

  // Fast path: check manual blocklist
  if (redis) {
    const blockReason = await redis.get(`iprep:blocked:${ip}`).catch(() => null);
    if (blockReason) return { score: 100, blocked: true, reason: blockReason };

    // Check cached score
    const cached = await redis.get(`iprep:score:${ip}`).catch(() => null);
    if (cached !== null) {
      const s = parseInt(cached, 10);
      return { score: s, blocked: false, reason: s >= 75 ? "high-abuse-score" : null };
    }
  }

  // Compute score
  let score = 0;
  let reason: string | null = null;

  // Datacenter prefix
  const dcScore = datacenterScore(ip);
  score += dcScore;
  if (dcScore > 0) reason = "datacenter-ip";

  // Abuse counter
  if (redis) {
    const abuseRaw = await redis.get(`iprep:abuse:${ip}`).catch(() => null);
    if (abuseRaw) {
      const abuseCount = parseInt(abuseRaw, 10);
      const abuseScore = Math.min(50, abuseCount * 5);
      score += abuseScore;
      if (abuseScore >= 25) reason = "repeated-abuse";
    }
  }

  score = Math.min(100, score);

  // Cache result
  if (redis) {
    await redis.setex(`iprep:score:${ip}`, SCORE_TTL_S, String(score)).catch(() => null);
  }

  return { score, blocked: false, reason: score >= 75 ? reason ?? "high-score" : reason };
}

export async function recordIpAbuse(ip: string, _reason: string): Promise<void> {
  if (!ip || isPrivateIp(ip)) return;
  const redis = getRedis();
  if (!redis) return;
  const key = `iprep:abuse:${ip}`;
  await redis.incr(key).catch(() => null);
  await redis.expire(key, ABUSE_TTL_S).catch(() => null);
  // Invalidate cached score so next scoreIp() recomputes
  await redis.del(`iprep:score:${ip}`).catch(() => null);
}

export async function blockIp(ip: string, reason: string, ttlSeconds = BLOCK_TTL_S): Promise<void> {
  if (!ip) return;
  const redis = getRedis();
  if (!redis) {
    console.warn(`[ip-reputation] cannot block ${ip} — Redis unavailable`);
    return;
  }
  await redis.setex(`iprep:blocked:${ip}`, ttlSeconds, reason).catch(() => null);
  await redis.del(`iprep:score:${ip}`).catch(() => null);
  console.warn(`[ip-reputation] blocked ${ip} reason="${reason}" ttl=${ttlSeconds}s`);
}

export async function unblockIp(ip: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(`iprep:blocked:${ip}`, `iprep:score:${ip}`).catch(() => null);
}

export async function trackVelocity(ip: string): Promise<number> {
  if (!ip || isPrivateIp(ip)) return 0;
  const redis = getRedis();
  if (!redis) return 0;
  const key   = `iprep:vel:${ip}`;
  const count = await redis.incr(key).catch(() => 0);
  if (count === 1) await redis.expire(key, 10).catch(() => null); // 10-second window
  return count;
}
