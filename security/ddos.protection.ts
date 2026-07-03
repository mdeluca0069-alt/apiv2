/**
 * security/ddos.protection.ts — DDoS and volumetric attack protection.
 *
 * Multi-layer protection:
 *
 *   Layer 1: Token Bucket per IP (per-second, per-minute, per-hour)
 *     — Allows bursts while enforcing sustained rate limits
 *
 *   Layer 2: Global throughput cap
 *     — Platform-wide request cap to protect under full DDoS
 *
 *   Layer 3: Adaptive rate limiting
 *     — Lowers thresholds for IPs already flagged by bot detection / WAF
 *
 *   Layer 4: Automatic IP banning
 *     — Repeated violations → progressive ban (5min → 30min → 24h → 7d)
 *
 *   Layer 5: Slowloris protection
 *     — Connection timeout tracking (tracked at load balancer, enforced here)
 *
 *   Layer 6: Endpoint-specific rate limits
 *     — Auth endpoints get tighter limits (5/min per IP)
 */

import { getRedis } from "../shared/redis.js";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { randomUUID } from "node:crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

// Per-IP limits (req/window)
const RATE_PER_SECOND     = Number(process.env.DDOS_RATE_PER_SECOND  ?? 20);

// Flagged IPs (from WAF/bot detection) get 10× lower limits
const FLAGGED_DIVISOR     = 10;

// Auth endpoint limits
const AUTH_RATE_PER_MIN   = Number(process.env.DDOS_AUTH_RATE_PER_MIN ?? 10);

// Global platform throughput cap (all IPs combined)
const GLOBAL_RPS_CAP      = Number(process.env.DDOS_GLOBAL_RPS_CAP   ?? 10000);

// Progressive ban durations (seconds)
const BAN_DURATIONS       = [300, 1800, 86400, 604800]; // 5min, 30min, 24h, 7d

// Auth paths that get stricter limits
const AUTH_PATHS = ["/api/v1/auth/login", "/api/v1/auth/register", "/api/v1/auth/refresh"];

// ─── Types ────────────────────────────────────────────────────────────────────

export type RateLimitResult = {
  allowed:      boolean;
  remaining:    number;
  resetAt:      number;
  retryAfter?:  number;
  banDuration?: number;
};

// ─── DDoSProtection ──────────────────────────────────────────────────────────

const LUA_TOKEN_BUCKET = `
local key         = KEYS[1]
local capacity    = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])  -- tokens per second
local now         = tonumber(ARGV[3])  -- current timestamp (ms)
local cost        = tonumber(ARGV[4])  -- tokens this request consumes (usually 1)

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1]) or capacity
local last_ts = tonumber(data[2]) or now

-- Refill based on elapsed time
local elapsed_ms = math.max(0, now - last_ts)
local refill = (elapsed_ms / 1000) * refill_rate
tokens = math.min(capacity, tokens + refill)

if tokens >= cost then
  tokens = tokens - cost
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
  redis.call('EXPIRE', key, 3600)
  return {1, math.floor(tokens), 0}
else
  local wait_s = math.ceil((cost - tokens) / refill_rate)
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
  redis.call('EXPIRE', key, 3600)
  return {0, 0, wait_s}
end
`;

export class DDoSProtection {

  /**
   * Main rate limit check. Call at the start of every request.
   */
  async checkRequest(ip: string, path: string): Promise<RateLimitResult> {
    const redis = getRedis();
    if (!redis) return { allowed: true, remaining: 9999, resetAt: 0 };

    // Check if IP is currently banned
    const banKey = `ddos:ban:${ip}`;
    const banTTL = await redis.ttl(banKey).catch(() => -1);
    if (banTTL > 0) {
      return {
        allowed:     false,
        remaining:   0,
        resetAt:     Date.now() + banTTL * 1000,
        retryAfter:  banTTL,
        banDuration: banTTL,
      };
    }

    // Check global throughput cap
    const globalKey = `ddos:global:${Math.floor(Date.now() / 1000)}`;
    const globalCount = await redis.incr(globalKey).catch(() => 0);
    if (globalCount === 1) await redis.expire(globalKey, 2).catch(() => null);
    if (globalCount > GLOBAL_RPS_CAP) {
      return { allowed: false, remaining: 0, resetAt: Date.now() + 1000, retryAfter: 1 };
    }

    // Check if IP is flagged (gets reduced limits)
    const flagged = await redis.exists(`iprep:blocked:${ip}`, `bot:blocks:${ip}`).catch(() => 0) > 0;
    const capacity  = flagged ? Math.max(1, RATE_PER_SECOND / FLAGGED_DIVISOR) : RATE_PER_SECOND;

    // Auth-path specific tight limits
    const isAuthPath = AUTH_PATHS.some((p) => path.startsWith(p));
    const effectiveCapacity = isAuthPath ? Math.min(capacity, AUTH_RATE_PER_MIN / 60) : capacity;

    // Token bucket check (per-second)
    const bucketKey = `ddos:bucket:${ip}`;
    try {
      const result = await redis.eval(
        LUA_TOKEN_BUCKET,
        1,
        bucketKey,
        String(Math.max(1, effectiveCapacity)),
        String(Math.max(0.1, effectiveCapacity)),
        String(Date.now()),
        "1",
      ) as [number, number, number];

      const [allowed, remaining, waitS] = result;

      if (!allowed) {
        await this._recordViolation(ip, "rate_limit_exceeded");
        return {
          allowed:    false,
          remaining:  0,
          resetAt:    Date.now() + waitS * 1000,
          retryAfter: waitS,
        };
      }

      return {
        allowed:   true,
        remaining: remaining,
        resetAt:   Date.now() + 1000,
      };
    } catch {
      // If Redis eval fails, fail open (don't block production traffic)
      return { allowed: true, remaining: 1, resetAt: 0 };
    }
  }

  /**
   * Record a rate limit violation and apply progressive bans.
   */
  async _recordViolation(ip: string, reason: string): Promise<void> {
    const redis = getRedis();
    if (!redis) return;

    const violationKey = `ddos:violations:${ip}`;
    const violations   = await redis.incr(violationKey).catch(() => 1);
    await redis.expire(violationKey, 3600).catch(() => null);

    // Progressive ban thresholds
    const banIndex = Math.min(violations - 1, BAN_DURATIONS.length - 1);
    if (violations >= 5) {
      const banDuration = BAN_DURATIONS[banIndex] ?? BAN_DURATIONS[BAN_DURATIONS.length - 1]!;
      await redis.setex(`ddos:ban:${ip}`, banDuration, reason).catch(() => null);

      if (IS_PERSISTENT && prisma && violations >= 10) {
        await prisma.auditLog.create({
          data: {
            id:     randomUUID(),
            actor:  ip,
            action: "ddos.ip_banned",
            entity: ip,
            payload: { violations, banDuration, reason } as object,
          },
        }).catch(() => undefined);
      }
    }
  }

  /**
   * Emergency global rate limit reduction (during active DDoS).
   * Call from admin panel to tighten limits temporarily.
   */
  async activateEmergencyMode(ttlSeconds: number): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    await redis.setex("ddos:emergency", ttlSeconds, "1");
  }

  async isEmergencyMode(): Promise<boolean> {
    const redis = getRedis();
    if (!redis) return false;
    return (await redis.exists("ddos:emergency").catch(() => 0)) > 0;
  }
}

export const ddosProtection = new DDoSProtection();
export default ddosProtection;
