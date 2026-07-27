/**
 * http.health.rate.limiter.bypass.spec.ts
 *
 * PRODUCTION CUTOVER Stage 3 — live-reproduced in a Redis-failure
 * simulation against the Stage 3 shadow deployment: stopping the Redis
 * container made GET /health and GET /api/health return 503
 * "SERVICE_UNAVAILABLE: rate limiting service offline", the exact same
 * fail-closed error gateway/rate-limiter.ts deliberately throws for real
 * application routes when Redis is unreachable (to stop rate limits being
 * bypassed by knocking Redis offline -- a legitimate, intentional
 * design). The rate-limiter check ran unconditionally for every route
 * including health/readiness probes, so a Redis outage made every replica
 * report unhealthy simultaneously (they share one Redis) -- exactly the
 * moment operators most need an accurate signal, and precisely the kind
 * of coupling the earlier /api/health PUBLIC_PATHS fix this Stage was
 * meant to eliminate.
 *
 * Fix: shared/http.ts's request handler now skips the rate-limiter check
 * entirely for HEALTH_CHECK_PATHS (/health, /api/health, /api/v1/health).
 * These tests prove the exemption is scoped correctly: health paths
 * succeed even when the rate limiter throws, but a real application route
 * still fails closed exactly as before.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../shared/http.js";
import type { Route } from "../shared/http.js";
import type { BrokerState } from "../shared/state.js";
import type { RateLimiter } from "../gateway/rate-limiter.js";

const fakeState = {
  resolvePrincipal: vi.fn().mockReturnValue(null),
} as unknown as BrokerState;

// Mirrors gateway/rate-limiter.ts's real fail-closed throw shape exactly.
const throwingRateLimiter = {
  check: vi.fn().mockRejectedValue(
    Object.assign(new Error("SERVICE_UNAVAILABLE: rate limiting service offline — Stream isn't writeable"), {
      statusCode: 503,
      isRateLimiterError: true,
    }),
  ),
} as unknown as RateLimiter;

const routes: Route[] = [
  { method: "GET", path: "/health", handler: () => ({ ok: true, liveness: true }) },
  { method: "GET", path: "/api/health", handler: () => ({ ok: true }) },
  // Public (unauthenticated) route so the request reaches the rate-limiter
  // check instead of being turned away earlier by the auth guard -- proves
  // the health-path exemption doesn't accidentally widen to every route.
  { method: "GET", path: "/api/v1/instruments", handler: () => ({ ok: true, instruments: [] }) },
];

let server: ReturnType<typeof createApiServer>;
let baseUrl: string;

beforeAll(async () => {
  server = createApiServer({ state: fakeState, routes, corsOrigin: "*", rateLimiter: throwingRateLimiter });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept-Language": "en-US",
};

describe("Rate limiter Redis-outage exemption for health-check paths", () => {
  it("GET /health succeeds even when the rate limiter fails closed on Redis unavailability", async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: BROWSER_HEADERS });
    expect(res.status).toBe(200);
    expect(throwingRateLimiter.check).not.toHaveBeenCalled();
  });

  it("GET /api/health succeeds even when the rate limiter fails closed on Redis unavailability", async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: BROWSER_HEADERS });
    expect(res.status).toBe(200);
  });

  it("a real application route still fails closed (503) exactly as before -- the exemption is scoped to health paths only", async () => {
    const res = await fetch(`${baseUrl}/api/v1/instruments`, { headers: BROWSER_HEADERS });
    expect(res.status).toBe(503);
    const body = await res.json() as { message: string };
    expect(body.message).toMatch(/rate limiting service offline/);
  });
});
