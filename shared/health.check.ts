/**
 * Real system health checks — replaces fabricated/hardcoded service status.
 * Every check here actually probes the dependency (DB query, Redis PING,
 * live feed staleness) instead of returning a canned "operational" string.
 */
import { prisma, IS_PERSISTENT } from "./db.js";
import { getRedis } from "./redis.js";
import { feedHealthMonitor } from "../market-data/feed.health.monitor.js";
import { redisPubSub } from "../realtime-infra/redis.pubsub.js";

export type ServiceStatus = "operational" | "degraded" | "offline";

export type ServiceHealth = {
  service: string;
  status: ServiceStatus;
  latencyMs: number | null;
  checkedAt: string;
  detail?: string;
};

export async function checkDatabaseHealth(): Promise<ServiceHealth> {
  const checkedAt = new Date().toISOString();
  if (!IS_PERSISTENT) {
    return { service: "database", status: "offline", latencyMs: null, checkedAt, detail: "sandbox mode — DATABASE_URL not configured" };
  }
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { service: "database", status: "operational", latencyMs: Date.now() - start, checkedAt };
  } catch (err) {
    return { service: "database", status: "offline", latencyMs: Date.now() - start, checkedAt, detail: err instanceof Error ? err.message : "query failed" };
  }
}

export async function checkRedisHealth(): Promise<ServiceHealth> {
  const checkedAt = new Date().toISOString();
  const redis = getRedis();
  if (!redis) {
    return { service: "redis", status: "offline", latencyMs: null, checkedAt, detail: "not configured" };
  }
  const start = Date.now();
  try {
    await redis.ping();
    return { service: "redis", status: "operational", latencyMs: Date.now() - start, checkedAt };
  } catch (err) {
    return { service: "redis", status: "offline", latencyMs: Date.now() - start, checkedAt, detail: err instanceof Error ? err.message : "ping failed" };
  }
}

/**
 * REALTIME_FREEZE.md M.3: `redisPubSub.isConnected()` existed but was never
 * read anywhere in the repo -- a cross-node WS relay failure at runtime
 * (the subscriber's "close"/"error" events, or the initial subscribe()
 * throwing, see main.ts's `redisPubSub.start().catch(...)`) degraded
 * silently: only a console.warn, no health endpoint or cluster dashboard
 * ever surfaced it. Distinguishes two cases: general Redis itself being
 * unavailable (already reported by checkRedisHealth() above -- not a
 * separate alarm, single-node/sandbox setups are an accepted, non-degraded
 * mode) from Redis being reachable but this app's own pub/sub subscriber
 * specifically failing (a genuine, actionable degradation: local delivery
 * still works, but multi-node users -- open tabs on different nodes --
 * stop syncing with each other).
 */
export function checkWsPubSubHealth(redisAvailable: boolean): ServiceHealth {
  const checkedAt = new Date().toISOString();
  const connected = redisPubSub.isConnected();
  if (connected) {
    return { service: "ws-pubsub", status: "operational", latencyMs: null, checkedAt };
  }
  if (!redisAvailable) {
    return { service: "ws-pubsub", status: "offline", latencyMs: null, checkedAt, detail: "Redis unavailable — single-node WS delivery only" };
  }
  return { service: "ws-pubsub", status: "degraded", latencyMs: null, checkedAt, detail: "Redis reachable but WS cross-node subscriber is not connected — local delivery unaffected, cross-node sync (multi-tab/multi-device) is down" };
}

export function checkMarketDataHealth(): ServiceHealth {
  const checkedAt = new Date().toISOString();
  const snap = feedHealthMonitor.getSnapshot();
  const status: ServiceStatus = snap.circuitOpen ? "offline" : snap.staleSymbols.length > 0 ? "degraded" : "operational";
  return {
    service: "market-data",
    status,
    latencyMs: null,
    checkedAt,
    detail: `${snap.freshSymbols.length}/${snap.totalSymbols} symbols fresh` + (snap.staleSymbols.length ? `, stale: ${snap.staleSymbols.join(",")}` : ""),
  };
}

export type GovernanceSnapshot = {
  killSwitchEnabled: boolean;
  eventRiskMode: "normal" | "reduced" | "blocked";
  olosModelStatus: ServiceStatus;
};

/** Engine statuses derived from real broker governance state (not fabricated). */
export function checkEngineHealth(gov: GovernanceSnapshot): ServiceHealth[] {
  const checkedAt = new Date().toISOString();
  return [
    { service: "execution-engine", status: gov.killSwitchEnabled ? "offline" : "operational", latencyMs: null, checkedAt },
    { service: "risk-engine",      status: gov.eventRiskMode === "blocked" ? "degraded" : "operational", latencyMs: null, checkedAt, detail: `eventRiskMode=${gov.eventRiskMode}` },
    { service: "olos-ai",          status: gov.olosModelStatus, latencyMs: null, checkedAt },
  ];
}

export async function getSystemHealth(gov: GovernanceSnapshot): Promise<{ ok: boolean; services: ServiceHealth[] }> {
  const [database, redis] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);
  const wsPubSub = checkWsPubSubHealth(redis.status === "operational");
  const services = [database, redis, wsPubSub, checkMarketDataHealth(), ...checkEngineHealth(gov)];
  const ok = services.every((s) => s.status !== "offline");
  return { ok, services };
}
