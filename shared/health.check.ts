/**
 * Real system health checks — replaces fabricated/hardcoded service status.
 * Every check here actually probes the dependency (DB query, Redis PING,
 * live feed staleness) instead of returning a canned "operational" string.
 */
import { prisma, IS_PERSISTENT } from "./db.js";
import { getRedis } from "./redis.js";
import { feedHealthMonitor } from "../market-data/feed.health.monitor.js";

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
  const services = [database, redis, checkMarketDataHealth(), ...checkEngineHealth(gov)];
  const ok = services.every((s) => s.status !== "offline");
  return { ok, services };
}
