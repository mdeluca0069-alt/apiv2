/**
 * ApiKeyService — programmatic API key management for IGFX OLOS Public API.
 *
 * Enables algo traders and third-party integrations to:
 *   - Generate API keys with scoped permissions (read / trade / admin)
 *   - Rate-limit requests per key (configurable, default 600 req/min)
 *   - Track usage, last-seen timestamps, and revoke at any time
 *   - HMAC-SHA256 signature verification for order placement (optional, for enhanced security)
 *
 * Key format: `igfx_live_<32-hex>` or `igfx_paper_<32-hex>`
 * Keys are stored hashed (SHA-256) in DB — the plaintext is shown only once on creation.
 */

import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApiKeyScope = "read" | "trade" | "admin";

export type ApiKey = {
  id:          string;
  userId:      string;
  name:        string;
  keyPrefix:   string;        // first 8 chars — shown in UI for identification
  keyHash:     string;        // SHA-256 of full key — stored in DB
  scopes:      ApiKeyScope[];
  rateLimit:   number;        // requests per minute
  environment: "live" | "paper";
  enabled:     boolean;
  lastUsedAt:  string | null;
  requestCount:number;
  createdAt:   string;
  expiresAt:   string | null;
};

export type CreateApiKeyResult = {
  key:       ApiKey;
  plaintext: string;          // shown only once — must be stored by client
};

// Rate limit buckets: keyId → { count, windowStart }
const rateLimitBuckets = new Map<string, { count: number; windowStart: number }>();
const WINDOW_MS        = 60_000;

// In-memory key store for non-persistent mode
const memKeys = new Map<string, ApiKey>();

// ─── ApiKeyService ────────────────────────────────────────────────────────────

export class ApiKeyService {

  async create(params: {
    userId:      string;
    name:        string;
    scopes:      ApiKeyScope[];
    environment: "live" | "paper";
    rateLimit?:  number;
    expiresAt?:  string;
  }): Promise<CreateApiKeyResult> {
    const raw       = randomBytes(32).toString("hex");
    const prefix    = `igfx_${params.environment}_`;
    const plaintext = `${prefix}${raw}`;
    const keyHash   = createHash("sha256").update(plaintext).digest("hex");
    const keyPrefix = plaintext.slice(0, 16);
    const id        = `ak_${randomBytes(8).toString("hex")}`;
    const now       = new Date().toISOString();

    const key: ApiKey = {
      id,
      userId:      params.userId,
      name:        params.name,
      keyPrefix,
      keyHash,
      scopes:      params.scopes,
      rateLimit:   params.rateLimit ?? 600,
      environment: params.environment,
      enabled:     true,
      lastUsedAt:  null,
      requestCount:0,
      createdAt:   now,
      expiresAt:   params.expiresAt ?? null,
    };

    await this._saveKey(key);
    console.log(`[api-key] created ${keyPrefix}*** for userId=${params.userId} scopes=${params.scopes.join(",")}`);

    return { key, plaintext };
  }

  async validate(plaintext: string): Promise<{ valid: boolean; key: ApiKey | null; rateLimited: boolean }> {
    const hash = createHash("sha256").update(plaintext).digest("hex");
    const key  = await this._findByHash(hash);

    if (!key || !key.enabled) return { valid: false, key: null, rateLimited: false };

    if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
      return { valid: false, key, rateLimited: false };
    }

    // Rate limit check
    const now    = Date.now();
    const bucket = rateLimitBuckets.get(key.id) ?? { count: 0, windowStart: now };
    if (now - bucket.windowStart > WINDOW_MS) {
      bucket.count       = 0;
      bucket.windowStart = now;
    }
    bucket.count++;
    rateLimitBuckets.set(key.id, bucket);

    if (bucket.count > key.rateLimit) {
      return { valid: true, key, rateLimited: true };
    }

    // Update usage stats (fire-and-forget)
    void this._touchKey(key.id);

    return { valid: true, key, rateLimited: false };
  }

  hasScope(key: ApiKey, scope: ApiKeyScope): boolean {
    return key.scopes.includes(scope) || key.scopes.includes("admin");
  }

  async listKeys(userId: string): Promise<ApiKey[]> {
    if (IS_PERSISTENT) {
      const db   = prisma as NonNullable<typeof prisma>;
      const rows = await db.brokerSetting.findMany({
        where: { key: { startsWith: "api_key:" } },
      });
      return rows
        .map(r => r.value as ApiKey)
        .filter(k => k.userId === userId)
        .map(k => ({ ...k, keyHash: "***" })); // never expose hash
    }
    return Array.from(memKeys.values())
      .filter(k => k.userId === userId)
      .map(k => ({ ...k, keyHash: "***" }));
  }

  async revoke(userId: string, keyId: string): Promise<void> {
    const key = await this._findById(keyId);
    if (!key || key.userId !== userId) throw new Error("API key not found");

    const revoked = { ...key, enabled: false };
    await this._saveKey(revoked);
    console.log(`[api-key] revoked ${key.keyPrefix}*** for userId=${userId}`);
  }

  async revokeAll(userId: string): Promise<number> {
    const keys = await this.listKeys(userId);
    await Promise.all(keys.map(k => this.revoke(userId, k.id)));
    return keys.length;
  }

  verifyHmacSignature(payload: string, secret: string, signature: string): boolean {
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
  }

  private async _saveKey(key: ApiKey): Promise<void> {
    if (IS_PERSISTENT) {
      const db = prisma as NonNullable<typeof prisma>;
      await db.brokerSetting.upsert({
        where:  { key: `api_key:${key.id}` },
        create: { key: `api_key:${key.id}`, value: key as object },
        update: { value: key as object },
      });
    } else {
      memKeys.set(key.id, key);
    }
  }

  private async _findByHash(hash: string): Promise<ApiKey | null> {
    if (IS_PERSISTENT) {
      const db   = prisma as NonNullable<typeof prisma>;
      const rows = await db.brokerSetting.findMany({ where: { key: { startsWith: "api_key:" } } });
      return (rows.map(r => r.value as ApiKey).find(k => k.keyHash === hash)) ?? null;
    }
    for (const k of memKeys.values()) {
      if (k.keyHash === hash) return k;
    }
    return null;
  }

  private async _findById(id: string): Promise<ApiKey | null> {
    if (IS_PERSISTENT) {
      const db  = prisma as NonNullable<typeof prisma>;
      const row = await db.brokerSetting.findUnique({ where: { key: `api_key:${id}` } });
      return row ? (row.value as ApiKey) : null;
    }
    return memKeys.get(id) ?? null;
  }

  private async _touchKey(id: string): Promise<void> {
    const key = await this._findById(id);
    if (!key) return;
    await this._saveKey({ ...key, lastUsedAt: new Date().toISOString(), requestCount: key.requestCount + 1 });
  }
}

export const apiKeyService = new ApiKeyService();
