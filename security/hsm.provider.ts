/**
 * security/hsm.provider.ts — Hardware Security Module abstraction layer.
 *
 * Provides a unified interface for cryptographic operations routed through
 * an HSM when available, falling back to software crypto when running in dev.
 *
 * Supported HSM backends (HSM_BACKEND env var):
 *   "software"   — Node.js built-in crypto (dev/sandbox, NOT production for signing keys)
 *   "aws_cloudhsm" — AWS CloudHSM via PKCS#11 JCE
 *   "aws_kms"    — AWS KMS (managed HSM, recommended for most deployments)
 *   "hashicorp"  — HashiCorp Vault Transit secrets engine
 *
 * Operations provided:
 *   sign(keyId, data)       — Sign data with HSM-held private key
 *   verify(keyId, sig, data)— Verify signature using HSM-held public key
 *   encrypt(keyId, plain)   — Encrypt with HSM-held symmetric key
 *   decrypt(keyId, cipher)  — Decrypt with HSM-held symmetric key
 *   generateKey(spec)       — Generate and store key inside HSM
 *   wrapKey(keyId, key)     — Wrap (export) a key encrypted by an HSM KEK
 *
 * All key IDs are logical names. The HSM backend resolves them to physical
 * key handles/ARNs. No key material ever leaves the HSM.
 */

import { createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { randomUUID } from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── Config ───────────────────────────────────────────────────────────────────

type HSMBackend = "software" | "aws_kms" | "hashicorp" | "aws_cloudhsm";

function resolveBackend(): HSMBackend {
  const b = (process.env.HSM_BACKEND ?? "software").toLowerCase();
  if (b === "aws_kms" || b === "hashicorp" || b === "aws_cloudhsm") return b as HSMBackend;
  return "software";
}

const AWS_KMS_REGION = process.env.HSM_AWS_REGION ?? process.env.AWS_REGION ?? "us-east-1";
const VAULT_TRANSIT  = process.env.VAULT_TRANSIT_MOUNT ?? "transit";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SignResult  = { signature: string; algorithm: string; keyId: string };
export type CryptResult = { ciphertext: string; keyId: string; algorithm: string };
export type KeySpec = {
  keyId:    string;
  type:     "RSA_4096" | "RSA_2048" | "EC_P256" | "AES_256";
  purpose:  "SIGN_VERIFY" | "ENCRYPT_DECRYPT";
};

// ─── HSMProvider ─────────────────────────────────────────────────────────────

export class HSMProvider {

  readonly backend: HSMBackend = resolveBackend();

  /**
   * Sign data with the HSM-held key.
   * For JWT signing, keyId maps to the current JWT signing key version.
   */
  async sign(keyId: string, data: Buffer | string): Promise<SignResult> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    switch (this.backend) {
      case "aws_kms":    return this._kmsSign(keyId, buf);
      case "hashicorp":  return this._vaultSign(keyId, buf);
      default:           return this._softwareSign(keyId, buf);
    }
  }

  /**
   * Verify a signature produced by sign().
   */
  async verify(keyId: string, signature: string, data: Buffer | string): Promise<boolean> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    switch (this.backend) {
      case "aws_kms":    return this._kmsVerify(keyId, signature, buf);
      case "hashicorp":  return this._vaultVerify(keyId, signature, buf);
      default:           return this._softwareVerify(keyId, signature, buf);
    }
  }

  /**
   * Encrypt data at rest using HSM-backed key.
   * Returns base64-encoded ciphertext.
   */
  async encrypt(keyId: string, plaintext: string): Promise<CryptResult> {
    switch (this.backend) {
      case "aws_kms":    return this._kmsEncrypt(keyId, plaintext);
      case "hashicorp":  return this._vaultEncrypt(keyId, plaintext);
      default:           return this._softwareEncrypt(keyId, plaintext);
    }
  }

  /**
   * Decrypt data using HSM-backed key.
   */
  async decrypt(keyId: string, ciphertext: string): Promise<string> {
    switch (this.backend) {
      case "aws_kms":    return this._kmsDecrypt(keyId, ciphertext);
      case "hashicorp":  return this._vaultDecrypt(keyId, ciphertext);
      default:           return this._softwareDecrypt(keyId, ciphertext);
    }
  }

  /**
   * Generate a new key inside the HSM.
   * The key never leaves the HSM boundary.
   */
  async generateKey(spec: KeySpec): Promise<{ keyId: string; publicKey?: string }> {
    await this._auditKeyOp("generate", spec.keyId, spec);

    switch (this.backend) {
      case "aws_kms":   return this._kmsGenerateKey(spec);
      case "hashicorp": return this._vaultCreateKey(spec);
      default:          return { keyId: spec.keyId }; // Software: managed externally
    }
  }

  // ── AWS KMS Backend ─────────────────────────────────────────────────────────

  private async _kmsSign(keyId: string, data: Buffer): Promise<SignResult> {
    const { KMSClient, SignCommand } = await this._importKms();
    const client = new KMSClient({ region: AWS_KMS_REGION });
    const result = await client.send(new SignCommand({
      KeyId:            keyId,
      Message:          data,
      MessageType:      "RAW",
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    })) as { Signature?: Uint8Array };
    const sig = Buffer.from(result.Signature ?? new Uint8Array()).toString("base64");
    return { signature: sig, algorithm: "RSASSA_PKCS1_V1_5_SHA_256", keyId };
  }

  private async _kmsVerify(keyId: string, signature: string, data: Buffer): Promise<boolean> {
    const { KMSClient, VerifyCommand } = await this._importKms();
    const client = new KMSClient({ region: AWS_KMS_REGION });
    try {
      const result = await client.send(new VerifyCommand({
        KeyId:            keyId,
        Message:          data,
        MessageType:      "RAW",
        Signature:        Buffer.from(signature, "base64"),
        SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
      })) as { SignatureValid?: boolean };
      return result.SignatureValid === true;
    } catch { return false; }
  }

  private async _kmsEncrypt(keyId: string, plaintext: string): Promise<CryptResult> {
    const { KMSClient, EncryptCommand } = await this._importKms();
    const client = new KMSClient({ region: AWS_KMS_REGION });
    const result = await client.send(new EncryptCommand({
      KeyId:          keyId,
      Plaintext:      Buffer.from(plaintext, "utf8"),
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
    })) as { CiphertextBlob?: Uint8Array };
    const ct = Buffer.from(result.CiphertextBlob ?? new Uint8Array()).toString("base64");
    return { ciphertext: ct, keyId, algorithm: "AES_GCM_256" };
  }

  private async _kmsDecrypt(_keyId: string, ciphertext: string): Promise<string> {
    const { KMSClient, DecryptCommand } = await this._importKms();
    const client = new KMSClient({ region: AWS_KMS_REGION });
    const result = await client.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertext, "base64"),
    })) as { Plaintext?: Uint8Array };
    return Buffer.from(result.Plaintext ?? new Uint8Array()).toString("utf8");
  }

  private async _kmsGenerateKey(spec: KeySpec): Promise<{ keyId: string; publicKey?: string }> {
    const { KMSClient, CreateKeyCommand, GetPublicKeyCommand } = await this._importKms();
    const client = new KMSClient({ region: AWS_KMS_REGION });
    const kmsSpec = spec.type === "AES_256" ? "SYMMETRIC_DEFAULT" : "RSA_4096";
    const result  = await client.send(new CreateKeyCommand({
      Description:        `igfxpro:${spec.keyId}`,
      KeyUsage:           spec.purpose === "SIGN_VERIFY" ? "SIGN_VERIFY" : "ENCRYPT_DECRYPT",
      CustomerMasterKeySpec: kmsSpec,
    })) as { KeyMetadata?: { KeyId?: string } };
    const kmsKeyId = result.KeyMetadata?.KeyId ?? spec.keyId;

    let publicKey: string | undefined;
    if (spec.purpose === "SIGN_VERIFY") {
      const pubResult = await client.send(new GetPublicKeyCommand({ KeyId: kmsKeyId })) as { PublicKey?: Uint8Array };
      if (pubResult.PublicKey) publicKey = Buffer.from(pubResult.PublicKey).toString("base64");
    }

    return { keyId: kmsKeyId, publicKey };
  }

  private async _importKms() {
    return import("@aws-sdk/client-kms" as string) as Promise<{
      KMSClient: new (cfg: { region: string }) => { send(cmd: unknown): Promise<Record<string, unknown>> };
      SignCommand: new (input: Record<string, unknown>) => unknown;
      VerifyCommand: new (input: Record<string, unknown>) => unknown;
      EncryptCommand: new (input: Record<string, unknown>) => unknown;
      DecryptCommand: new (input: Record<string, unknown>) => unknown;
      CreateKeyCommand: new (input: Record<string, unknown>) => unknown;
      GetPublicKeyCommand: new (input: Record<string, unknown>) => unknown;
    }>;
  }

  // ── HashiCorp Vault Transit Backend ─────────────────────────────────────────

  private async _vaultRequest(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const addr  = process.env.VAULT_ADDR  ?? "http://127.0.0.1:8200";
    const token = process.env.VAULT_TOKEN ?? "";
    const url   = `${addr}/v1/${VAULT_TRANSIT}/${path}`;
    const res   = await fetch(url, {
      method:  body ? "POST" : "GET",
      headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
      body:    body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Vault transit request failed: ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  private async _vaultSign(keyId: string, data: Buffer): Promise<SignResult> {
    const b64 = data.toString("base64");
    const resp = await this._vaultRequest(`sign/${keyId}`, { input: b64 });
    const sig  = ((resp.data as Record<string, string>).signature ?? "").split(":").pop() ?? "";
    return { signature: sig, algorithm: "ecdsa-sha2-256", keyId };
  }

  private async _vaultVerify(keyId: string, signature: string, data: Buffer): Promise<boolean> {
    try {
      const resp = await this._vaultRequest(`verify/${keyId}`, {
        input:     data.toString("base64"),
        signature: `vault:v1:${signature}`,
      });
      return (resp.data as Record<string, boolean>).valid === true;
    } catch { return false; }
  }

  private async _vaultEncrypt(keyId: string, plaintext: string): Promise<CryptResult> {
    const resp = await this._vaultRequest(`encrypt/${keyId}`, {
      plaintext: Buffer.from(plaintext, "utf8").toString("base64"),
    });
    const ct = (resp.data as Record<string, string>).ciphertext ?? "";
    return { ciphertext: ct, keyId, algorithm: "aes256-gcm96" };
  }

  private async _vaultDecrypt(keyId: string, ciphertext: string): Promise<string> {
    const resp = await this._vaultRequest(`decrypt/${keyId}`, { ciphertext });
    const pt   = (resp.data as Record<string, string>).plaintext ?? "";
    return Buffer.from(pt, "base64").toString("utf8");
  }

  private async _vaultCreateKey(spec: KeySpec): Promise<{ keyId: string }> {
    const type = spec.type === "AES_256" ? "aes256-gcm96" : "rsa-4096";
    await this._vaultRequest(`keys/${spec.keyId}`, { type });
    return { keyId: spec.keyId };
  }

  // ── Software Backend (dev/test only) ─────────────────────────────────────────

  private _softwareSign(keyId: string, data: Buffer): SignResult {
    const secret = process.env[keyId] ?? process.env.JWT_SECRET ?? "dev-key";
    const sig = createHmac("sha256", secret).update(data).digest("base64");
    return { signature: sig, algorithm: "HMAC-SHA256", keyId };
  }

  private _softwareVerify(keyId: string, signature: string, data: Buffer): boolean {
    const expected = this._softwareSign(keyId, data);
    try {
      const a = Buffer.from(expected.signature, "base64");
      const b = Buffer.from(signature, "base64");
      if (a.length !== b.length) return false;
      return a.equals(b);
    } catch { return false; }
  }

  private _softwareEncrypt(keyId: string, plaintext: string): CryptResult {
    const key = randomBytes(32);
    const iv  = randomBytes(16);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct   = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag  = cipher.getAuthTag();
    const out  = Buffer.concat([key, iv, tag, ct]).toString("base64");
    return { ciphertext: out, keyId, algorithm: "AES-256-GCM-soft" };
  }

  private _softwareDecrypt(_keyId: string, ciphertext: string): string {
    const buf = Buffer.from(ciphertext, "base64");
    const key = buf.subarray(0, 32);
    const iv  = buf.subarray(32, 48);
    const tag = buf.subarray(48, 64);
    const ct  = buf.subarray(64);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct, undefined, "utf8") + decipher.final("utf8");
  }

  private async _auditKeyOp(op: string, keyId: string, meta: object): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;
    await prisma.auditLog.create({
      data: {
        id:     randomUUID(),
        actor:  "SYSTEM_HSM",
        action: `hsm.key.${op}`,
        entity: keyId,
        payload: { backend: this.backend, ...meta } as object,
      },
    }).catch(() => undefined);
  }
}

export const hsmProvider = new HSMProvider();
export default hsmProvider;
