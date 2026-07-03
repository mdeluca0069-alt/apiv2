/**
 * security/secrets-vault.ts — Multi-backend secret retrieval with in-process cache.
 *
 * Backends (VAULT_BACKEND env var):
 *   env   — reads process.env (default)
 *   vault — HashiCorp Vault KV v2  (VAULT_ADDR, VAULT_TOKEN, VAULT_MOUNT)
 *   aws   — AWS Secrets Manager    (VAULT_AWS_REGION or AWS_REGION)
 *
 * All backends share a 5-minute in-process LRU-style cache.
 */

type VaultBackend = "env" | "vault" | "aws";

interface CacheEntry {
  value:     string;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1_000;
const _cache = new Map<string, CacheEntry>();

function fromCache(name: string): string | null {
  const entry = _cache.get(name);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(name); return null; }
  return entry.value;
}

function toCache(name: string, value: string): void {
  _cache.set(name, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function resolveBackend(): VaultBackend {
  const b = (process.env.VAULT_BACKEND ?? "env").toLowerCase();
  if (b === "vault" || b === "aws") return b as VaultBackend;
  return "env";
}

// ── Env backend ────────────────────────────────────────────────────────────────
function getFromEnv(name: string): string {
  const key = name.toUpperCase().replaceAll("-", "_").replaceAll(".", "_");
  const val = process.env[key];
  if (!val) throw new Error(`[secrets-vault] env: secret "${name}" not set (env var: ${key})`);
  return val;
}

// ── HashiCorp Vault KV v2 backend ──────────────────────────────────────────────
async function getFromVault(name: string): Promise<string> {
  const addr  = process.env.VAULT_ADDR  ?? "http://127.0.0.1:8200";
  const token = process.env.VAULT_TOKEN ?? "";
  const mount = process.env.VAULT_MOUNT ?? "secret";
  if (!token) throw new Error("[secrets-vault] vault: VAULT_TOKEN not set");

  const url = `${addr}/v1/${mount}/data/${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { "X-Vault-Token": token, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`[secrets-vault] vault: GET ${url} → ${res.status} ${res.statusText}`);
  }
  type VaultKvResponse = { data?: { data?: Record<string, string> } };
  const body = await res.json() as VaultKvResponse;
  const value = body?.data?.data?.[name] ?? body?.data?.data?.["value"];
  if (!value) throw new Error(`[secrets-vault] vault: key "${name}" not found in secret`);
  return value;
}

// ── AWS Secrets Manager backend ────────────────────────────────────────────────
async function getFromAws(name: string): Promise<string> {
  type SsmClientCtor = new (cfg: { region: string }) => {
    send(cmd: unknown): Promise<{ SecretString?: string }>;
  };
  type SsmCmdCtor = new (input: { SecretId: string }) => unknown;

  let ClientCtor: SsmClientCtor;
  let CmdCtor: SsmCmdCtor;
  try {
    const mod = await import("@aws-sdk/client-secrets-manager" as string) as {
      SecretsManagerClient: SsmClientCtor;
      GetSecretValueCommand: SsmCmdCtor;
    };
    ClientCtor = mod.SecretsManagerClient;
    CmdCtor    = mod.GetSecretValueCommand;
  } catch {
    throw new Error(
      "[secrets-vault] aws: @aws-sdk/client-secrets-manager not installed — " +
      "run: npm install @aws-sdk/client-secrets-manager",
    );
  }

  const region = process.env.VAULT_AWS_REGION ?? process.env.AWS_REGION ?? "us-east-1";
  const client = new ClientCtor({ region });
  const result = await client.send(new CmdCtor({ SecretId: name }));
  const value  = result.SecretString;
  if (!value) throw new Error(`[secrets-vault] aws: SecretString empty for "${name}"`);
  return value;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function getSecret(name: string): Promise<string> {
  const cached = fromCache(name);
  if (cached !== null) return cached;

  const backend = resolveBackend();
  let value: string;

  if (backend === "vault")     value = await getFromVault(name);
  else if (backend === "aws")  value = await getFromAws(name);
  else                         value = getFromEnv(name);

  toCache(name, value);
  return value;
}

export function getSecretSync(name: string): string {
  const cached = fromCache(name);
  if (cached !== null) return cached;
  return getFromEnv(name);
}

/**
 * Write a new secret value to the configured backend (for secret rotation).
 * Updates the in-process cache immediately.
 */
export async function setSecret(name: string, value: string): Promise<void> {
  // Always update in-process cache immediately
  toCache(name, value);

  const backend = resolveBackend();

  if (backend === "aws") {
    const region = process.env.VAULT_AWS_REGION ?? process.env.AWS_REGION ?? "us-east-1";
    type SsmClientCtor = new (cfg: { region: string }) => { send(cmd: unknown): Promise<void> };
    type SsmCmdCtor = new (input: { SecretId: string; SecretString: string }) => unknown;
    const mod = await import("@aws-sdk/client-secrets-manager" as string) as {
      SecretsManagerClient: SsmClientCtor;
      PutSecretValueCommand: SsmCmdCtor;
    };
    const client = new mod.SecretsManagerClient({ region });
    await client.send(new mod.PutSecretValueCommand({ SecretId: name, SecretString: value }));
    return;
  }

  if (backend === "vault") {
    const addr  = process.env.VAULT_ADDR  ?? "http://127.0.0.1:8200";
    const token = process.env.VAULT_TOKEN ?? "";
    const mount = process.env.VAULT_MOUNT ?? "secret";
    await fetch(`${addr}/v1/${mount}/data/${encodeURIComponent(name)}`, {
      method:  "POST",
      headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
      body:    JSON.stringify({ data: { value } }),
    });
    return;
  }

  // env backend: update process.env only (no persistent store)
  const key = name.toUpperCase().replaceAll("-", "_").replaceAll(".", "_");
  process.env[key] = value;
}

export async function warmSecrets(names: string[]): Promise<void> {
  await Promise.all(
    names.map((n) =>
      getSecret(n).catch((err: Error) =>
        console.warn(`[secrets-vault] warm failed "${n}": ${err.message}`),
      ),
    ),
  );
}
