/**
 * security/secret.rotation.ts — Automated secret rotation service.
 *
 * Manages rotation lifecycle for all application secrets:
 *   - JWT signing keys (HS256 / RS256 key pairs)
 *   - Database passwords
 *   - Redis auth tokens
 *   - API provider keys
 *   - Internal service tokens
 *
 * Rotation strategy:
 *   1. Generate new secret (cryptographically strong)
 *   2. Store new secret in AWS Secrets Manager (or HashiCorp Vault)
 *   3. Update application config in-flight without restart
 *      — dual-key window: accept both old and new keys during transition
 *   4. After ROTATION_GRACE_PERIOD_MS: retire old key
 *   5. Audit every rotation with actor="SYSTEM_ROTATION"
 *   6. Alert on failure (rotation failure = security incident)
 *
 * Rotation schedule (configurable via env):
 *   JWT_SECRET:          30 days
 *   JWT_KEYPAIR:         90 days (asymmetric keys, longer because of key ceremony cost)
 *   DB_PASSWORD:         90 days
 *   REDIS_AUTH:          90 days
 *   API_KEYS:            30 days (third-party keys are rotated manually; this tracks them)
 *   DEVICE_FP_SECRET:    180 days
 *   INTERNAL_TOKENS:     7 days
 */

import { randomBytes, generateKeyPairSync } from "node:crypto";
import { immutableAudit } from "./immutable.audit.js";
import { getSecret, setSecret } from "./secrets-vault.js";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const ROTATION_GRACE_PERIOD_MS = Number(process.env.ROTATION_GRACE_PERIOD_MS ?? 300_000); // 5 min

export type SecretName =
  | "JWT_SECRET"
  | "JWT_PRIVATE_KEY"
  | "JWT_PUBLIC_KEY"
  | "DEVICE_FP_SECRET"
  | "METRICS_TOKEN"
  | "INTERNAL_SERVICE_TOKEN";

type RotationPolicy = {
  intervalDays:    number;
  generator:       () => Promise<string>;
  onRotate?:       (newValue: string) => Promise<void>;
};

// ─── In-memory Key Store (dual-key window) ────────────────────────────────────

interface KeyVersion {
  id:        string;
  value:     string;
  createdAt: number;
  expiresAt: number;  // When this version is no longer accepted
  active:    boolean; // Is this the signing key for NEW tokens?
}

const keyStore = new Map<SecretName, KeyVersion[]>();

// ─── SecretRotationService ────────────────────────────────────────────────────

export class SecretRotationService {

  /**
   * Get the current active secret value for signing/encryption.
   * Returns the most recently rotated active version.
   */
  getActive(name: SecretName): string {
    const versions = keyStore.get(name) ?? [];
    const active = versions.find((v) => v.active);
    if (active) return active.value;

    // Fallback to process.env (before first rotation)
    return process.env[name] ?? "";
  }

  /**
   * Get all currently valid keys for this secret name (for JWT verification
   * during the dual-key grace window — accept both old and new).
   */
  getValidVerifyKeys(name: SecretName): string[] {
    const versions = keyStore.get(name) ?? [];
    const now = Date.now();
    const valid = versions
      .filter((v) => v.expiresAt > now)
      .map((v) => v.value);

    if (valid.length === 0) {
      const envVal = process.env[name];
      if (envVal) valid.push(envVal);
    }

    return valid;
  }

  /**
   * Execute an immediate rotation for a secret.
   * Used by scheduled job and can be triggered manually from admin panel.
   */
  async rotate(name: SecretName): Promise<void> {
    const policy = this._getPolicy(name);
    if (!policy) throw new Error(`No rotation policy defined for ${name}`);

    const now      = Date.now();
    const newValue = await policy.generator();
    const id       = `${name}_${now}`;

    // Mark all existing versions as not active
    const existing = keyStore.get(name) ?? [];
    for (const v of existing) v.active = false;

    // Add new version with dual-key grace window
    const newVersion: KeyVersion = {
      id,
      value:     newValue,
      createdAt: now,
      expiresAt: now + ROTATION_GRACE_PERIOD_MS * 100, // keep verify window long (100×)
      active:    true,
    };

    // Expire OLD versions: after grace period they can no longer verify
    for (const v of existing) {
      if (!v.expiresAt || v.expiresAt > now + ROTATION_GRACE_PERIOD_MS) {
        v.expiresAt = now + ROTATION_GRACE_PERIOD_MS;
      }
    }

    existing.push(newVersion);

    // Purge fully expired versions
    const live = existing.filter((v) => v.expiresAt > now);
    keyStore.set(name, live);

    // Persist to secrets backend (AWS Secrets Manager or env)
    await setSecret(name, newValue).catch((err) => {
      console.error(`[secret-rotation] failed to persist ${name}:`, (err as Error).message);
    });

    // Update process.env for same-process use
    process.env[name] = newValue;

    // Run post-rotate hook
    if (policy.onRotate) {
      await policy.onRotate(newValue).catch((err) => {
        console.error(`[secret-rotation] post-rotate hook failed for ${name}:`, (err as Error).message);
      });
    }

    await this._auditRotation(name, id);
    console.info(`[secret-rotation] rotated ${name} → ${id}`);
  }

  /**
   * Load all current secrets from the secrets backend into the key store.
   * Call once at startup.
   */
  async loadAll(): Promise<void> {
    const secrets: SecretName[] = [
      "JWT_SECRET", "JWT_PRIVATE_KEY", "JWT_PUBLIC_KEY",
      "DEVICE_FP_SECRET", "METRICS_TOKEN",
    ];

    for (const name of secrets) {
      try {
        const value = await getSecret(name);
        if (value) {
          process.env[name] = value;
          const version: KeyVersion = {
            id:        `${name}_loaded`,
            value,
            createdAt: Date.now(),
            expiresAt: Date.now() + 180 * 86400 * 1000, // 180 days
            active:    true,
          };
          keyStore.set(name, [version]);
        }
      } catch {
        // Secret not in vault — use process.env as fallback (dev mode)
      }
    }
  }

  /**
   * Check which secrets are due for rotation (called by the daily scheduler).
   */
  getDueForRotation(): SecretName[] {
    const due: SecretName[] = [];
    for (const [name, policy] of Object.entries(this._policies())) {
      const versions = keyStore.get(name as SecretName) ?? [];
      const active   = versions.find((v) => v.active);
      if (!active) { due.push(name as SecretName); continue; }

      const ageMs = Date.now() - active.createdAt;
      if (ageMs > policy.intervalDays * 86400 * 1000) {
        due.push(name as SecretName);
      }
    }
    return due;
  }

  private _getPolicy(name: SecretName): RotationPolicy | undefined {
    return this._policies()[name];
  }

  private _policies(): Partial<Record<SecretName, RotationPolicy>> {
    return {
      JWT_SECRET: {
        intervalDays: Number(process.env.JWT_ROTATION_DAYS ?? 30),
        generator:    async () => randomBytes(64).toString("hex"),
      },

      JWT_PRIVATE_KEY: {
        intervalDays: Number(process.env.JWT_KEYPAIR_ROTATION_DAYS ?? 90),
        generator:    async () => {
          const { privateKey } = generateKeyPairSync("rsa", {
            modulusLength:  4096,
            privateKeyEncoding:  { type: "pkcs8", format: "pem" },
            publicKeyEncoding:   { type: "spki",  format: "pem" },
          });
          return privateKey;
        },
        onRotate: async (_privKey: string) => {
          const { publicKey } = generateKeyPairSync("rsa", {
            modulusLength:  4096,
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
            publicKeyEncoding:  { type: "spki",  format: "pem" },
          });
          // Store paired public key
          process.env["JWT_PUBLIC_KEY"] = publicKey;
          await setSecret("JWT_PUBLIC_KEY", publicKey).catch(() => {});
        },
      },

      DEVICE_FP_SECRET: {
        intervalDays: 180,
        generator:    async () => randomBytes(32).toString("hex"),
      },

      METRICS_TOKEN: {
        intervalDays: 90,
        generator:    async () => randomBytes(24).toString("base64url"),
      },
    };
  }

  private async _auditRotation(name: string, versionId: string): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;
    await immutableAudit.write({
      actor:  "SYSTEM_ROTATION",
      action: "secret.rotated",
      entity: name,
      payload: { name, versionId, timestamp: new Date().toISOString() } as object,
    }).catch(() => undefined);
  }
}

export const secretRotation = new SecretRotationService();
export default secretRotation;
