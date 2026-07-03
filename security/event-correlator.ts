/**
 * security/event-correlator.ts — SIEM-style security event correlation engine.
 *
 * Uses Redis sorted sets as sliding-window counters.
 * Detected patterns trigger automated actions and publish to `security:alerts`.
 *
 * Patterns:
 *   CREDENTIAL_STUFFING  — >15 distinct emails from same IP in 5 min  → BLOCK_IP
 *   BRUTE_FORCE          — >10 failed logins for same email in 5 min  → LOCK_ACCOUNT
 *   API_SCANNER          — >50 distinct endpoints from same IP in 1 min → BLOCK_IP
 *   PRIVILEGE_ESCALATION — >5 admin 403s for same userId in 10 min    → LOCK_ACCOUNT
 *   MASS_DATA_EXFIL      — >1000 DB reads for same userId in 1 min    → LOCK_ACCOUNT
 */

import { randomBytes } from "node:crypto";
import { getRedis }    from "../shared/redis.js";
import { blockIp }     from "./ip-reputation.js";

export type SecurityPattern =
  | "CREDENTIAL_STUFFING"
  | "BRUTE_FORCE"
  | "API_SCANNER"
  | "PRIVILEGE_ESCALATION"
  | "MASS_DATA_EXFIL";

export type SecurityAction = "BLOCK_IP" | "LOCK_ACCOUNT";

export interface CorrelationEvent {
  type:     SecurityPattern;
  action:   SecurityAction;
  entity:   string;
  count:    number;
  windowMs: number;
  ts:       number;
}

const ACCOUNT_LOCK_TTL_S = 30 * 60; // 30 minutes

interface PatternConfig {
  windowMs:  number;
  threshold: number;
  action:    SecurityAction;
}

const PATTERNS: Record<SecurityPattern, PatternConfig> = {
  CREDENTIAL_STUFFING:  { windowMs: 5 * 60_000,  threshold: 15,   action: "BLOCK_IP"     },
  BRUTE_FORCE:          { windowMs: 5 * 60_000,  threshold: 10,   action: "LOCK_ACCOUNT" },
  API_SCANNER:          { windowMs: 60_000,       threshold: 50,   action: "BLOCK_IP"     },
  PRIVILEGE_ESCALATION: { windowMs: 10 * 60_000, threshold: 5,    action: "LOCK_ACCOUNT" },
  MASS_DATA_EXFIL:      { windowMs: 60_000,       threshold: 1000, action: "LOCK_ACCOUNT" },
};

async function slidingCount(
  windowKey: string,
  windowMs:  number,
): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;

  const now = Date.now();
  const min = now - windowMs;
  const member = `${now}:${randomBytes(4).toString("hex")}`;

  const pipe = redis.pipeline();
  pipe.zadd(windowKey, now, member);
  pipe.zremrangebyscore(windowKey, "-inf", min);
  pipe.zcard(windowKey);
  pipe.expire(windowKey, Math.ceil(windowMs / 1_000) + 60);
  const results = await pipe.exec().catch(() => null);
  if (!results) return 0;
  const cardResult = results[2];
  if (!cardResult) return 0;
  const [err, count] = cardResult;
  if (err) return 0;
  return typeof count === "number" ? count : 0;
}

async function lockAccount(entity: string, reason: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.setex(`account:locked:${entity}`, ACCOUNT_LOCK_TTL_S, reason).catch(() => null);
  console.warn(`[event-correlator] account locked entity="${entity}" reason="${reason}" ttl=${ACCOUNT_LOCK_TTL_S}s`);
}

async function publishAlert(event: CorrelationEvent): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.publish("security:alerts", JSON.stringify(event)).catch(() => null);
}

async function executeAction(event: CorrelationEvent): Promise<void> {
  if (event.action === "BLOCK_IP") {
    await blockIp(event.entity, `auto:${event.type}`, 24 * 60 * 60);
  } else {
    await lockAccount(event.entity, `auto:${event.type}`);
  }
  await publishAlert(event);
  console.warn(
    `[event-correlator] ${event.type} → ${event.action} entity="${event.entity}" ` +
    `count=${event.count} window=${event.windowMs / 1_000}s`,
  );
}

// ── Public correlation functions ───────────────────────────────────────────────

export async function trackLoginAttempt(ip: string, email: string, failed: boolean): Promise<CorrelationEvent | null> {
  if (!failed) return null;
  const redis = getRedis();
  if (!redis) return null;

  // BRUTE_FORCE: many failures for same email
  const bfKey   = `secwin:brute:${email}`;
  const bfCount = await slidingCount(bfKey, PATTERNS.BRUTE_FORCE.windowMs);
  if (bfCount >= PATTERNS.BRUTE_FORCE.threshold) {
    const evt: CorrelationEvent = { type: "BRUTE_FORCE", action: "LOCK_ACCOUNT", entity: email, count: bfCount, windowMs: PATTERNS.BRUTE_FORCE.windowMs, ts: Date.now() };
    await executeAction(evt);
    return evt;
  }

  // CREDENTIAL_STUFFING: many distinct emails from same IP
  const csEmailKey = `secwin:cs:emails:${ip}`;
  await redis.zadd(csEmailKey, Date.now(), email).catch(() => null);
  await redis.zremrangebyscore(csEmailKey, "-inf", Date.now() - PATTERNS.CREDENTIAL_STUFFING.windowMs).catch(() => null);
  await redis.expire(csEmailKey, 600).catch(() => null);
  const distinctEmails = await redis.zcard(csEmailKey).catch(() => 0);
  if (distinctEmails >= PATTERNS.CREDENTIAL_STUFFING.threshold) {
    const evt: CorrelationEvent = { type: "CREDENTIAL_STUFFING", action: "BLOCK_IP", entity: ip, count: distinctEmails, windowMs: PATTERNS.CREDENTIAL_STUFFING.windowMs, ts: Date.now() };
    await executeAction(evt);
    return evt;
  }

  return null;
}

export async function trackEndpoint(ip: string, endpoint: string): Promise<CorrelationEvent | null> {
  const redis = getRedis();
  if (!redis) return null;

  const key = `secwin:scan:eps:${ip}`;
  await redis.zadd(key, Date.now(), endpoint).catch(() => null);
  await redis.zremrangebyscore(key, "-inf", Date.now() - PATTERNS.API_SCANNER.windowMs).catch(() => null);
  await redis.expire(key, 120).catch(() => null);
  const distinct = await redis.zcard(key).catch(() => 0);

  if (distinct >= PATTERNS.API_SCANNER.threshold) {
    const evt: CorrelationEvent = { type: "API_SCANNER", action: "BLOCK_IP", entity: ip, count: distinct, windowMs: PATTERNS.API_SCANNER.windowMs, ts: Date.now() };
    await executeAction(evt);
    return evt;
  }
  return null;
}

export async function trackAdminForbidden(userId: string): Promise<CorrelationEvent | null> {
  const key   = `secwin:privesc:${userId}`;
  const count = await slidingCount(key, PATTERNS.PRIVILEGE_ESCALATION.windowMs);
  if (count >= PATTERNS.PRIVILEGE_ESCALATION.threshold) {
    const evt: CorrelationEvent = { type: "PRIVILEGE_ESCALATION", action: "LOCK_ACCOUNT", entity: userId, count, windowMs: PATTERNS.PRIVILEGE_ESCALATION.windowMs, ts: Date.now() };
    await executeAction(evt);
    return evt;
  }
  return null;
}

export async function trackDataRead(userId: string): Promise<CorrelationEvent | null> {
  const key   = `secwin:exfil:${userId}`;
  const count = await slidingCount(key, PATTERNS.MASS_DATA_EXFIL.windowMs);
  if (count >= PATTERNS.MASS_DATA_EXFIL.threshold) {
    const evt: CorrelationEvent = { type: "MASS_DATA_EXFIL", action: "LOCK_ACCOUNT", entity: userId, count, windowMs: PATTERNS.MASS_DATA_EXFIL.windowMs, ts: Date.now() };
    await executeAction(evt);
    return evt;
  }
  return null;
}

export async function isAccountLocked(entity: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  return redis.get(`account:locked:${entity}`).catch(() => null);
}

export async function unlockAccount(entity: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(`account:locked:${entity}`).catch(() => null);
}
