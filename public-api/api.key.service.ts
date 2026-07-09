/**
 * ApiKeyService — API key issuance/revocation for the IGFX OLOS Public API.
 *
 * Generates scoped, hashed (SHA-256) keys and lets a user list/revoke their
 * own keys. Key format: `igfx_live_<32-hex>` or `igfx_paper_<32-hex>`;
 * plaintext is shown only once on creation.
 *
 * NOTE: no request path currently validates an incoming API key against this
 * store — issuing a key does not yet grant programmatic API access. Wiring
 * request-time validation (rate limiting, scope checks, HMAC signature
 * verification) is tracked as follow-up work, not part of this milestone.
 */

import { randomBytes, createHash } from "node:crypto";
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

  private async _findById(id: string): Promise<ApiKey | null> {
    if (IS_PERSISTENT) {
      const db  = prisma as NonNullable<typeof prisma>;
      const row = await db.brokerSetting.findUnique({ where: { key: `api_key:${id}` } });
      return row ? (row.value as ApiKey) : null;
    }
    return memKeys.get(id) ?? null;
  }
}

export const apiKeyService = new ApiKeyService();
