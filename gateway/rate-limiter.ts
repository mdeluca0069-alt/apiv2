import type { Redis } from "ioredis";

export type ClientTier = "STANDARD" | "GOLD" | "PLATINUM" | "VIP" | "ENTERPRISE";

const TIER_LIMITS: Record<ClientTier | "UNAUTH", number> = {
  UNAUTH:     10,
  STANDARD:   30,
  GOLD:       300,
  PLATINUM:   1_000,
  VIP:        3_000,
  ENTERPRISE: 10_000,
};

const ENDPOINT_OVERRIDES: Record<string, number> = {
  "/auth/session":          5,
  "/api/v1/auth/login":     5,
  "/auth/refresh":          20,
  "/api/v1/auth/register":  10,
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfter: number;
};

/**
 * Atomic INCR + EXPIRE via Lua script.
 * Prevents the race where INCR succeeds but EXPIRE is never called
 * because the process crashes between the two separate commands.
 */
const ATOMIC_INCR_EXPIRE = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return {count, redis.call('TTL', KEYS[1])}
`;

export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  async check(
    identifier: string,
    tier: ClientTier | "UNAUTH",
    endpoint: string
  ): Promise<RateLimitResult> {
    const tierLimit     = TIER_LIMITS[tier];
    const endpointLimit = ENDPOINT_OVERRIDES[endpoint];
    const limit         = endpointLimit !== undefined
      ? Math.min(endpointLimit, tierLimit)
      : tierLimit;

    const key = `rl:${tier}:${identifier}:${endpoint}`;

    try {
      const result = await this.redis.eval(
        ATOMIC_INCR_EXPIRE,
        1,          // numkeys
        key,        // KEYS[1]
        "60"        // ARGV[1] — window in seconds
      ) as [number, number];

      const count = result[0];
      const ttl   = result[1];

      const allowed = count <= limit;
      return {
        allowed,
        remaining:  Math.max(0, limit - count),
        limit,
        retryAfter: allowed ? 0 : (ttl > 0 ? ttl : 60),
      };
    } catch (err) {
      // Redis unavailable — FAIL-CLOSED: deny request so rate limits cannot be bypassed
      // by intentionally disrupting the Redis connection.
      const message = (err as Error).message;
      console.error("[rate-limiter] Redis unavailable — request denied (fail-closed):", message);
      throw Object.assign(
        new Error(`SERVICE_UNAVAILABLE: rate limiting service offline — ${message}`),
        { statusCode: 503, isRateLimiterError: true },
      );
    }
  }
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit":     String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset":     String(Math.floor(Date.now() / 1000) + result.retryAfter),
    ...(result.retryAfter > 0 ? { "Retry-After": String(result.retryAfter) } : {}),
  };
}
