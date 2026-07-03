import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Envelope encryption: AES-256-GCM
//
// Each file gets a unique random DEK (data encryption key).
// The DEK is AES-256-GCM encrypted with the master key and stored as hex in
// StoredDocument.encryptedDek. The ciphertext stored in S3/R2 is:
//   [ IV(12) | AuthTag(16) | ciphertext ]
//
// This means even if someone gains read access to the bucket, they cannot
// decrypt files without the master key in env.

const ALGORITHM  = "aes-256-gcm";
const KEY_BYTES  = 32;   // 256-bit key
const IV_BYTES   = 12;   // 96-bit IV for GCM
const TAG_BYTES  = 16;   // 128-bit authentication tag

export type EncryptResult = {
  ciphertext:   Buffer;   // IV + Tag + encrypted file bytes
  encryptedDek: string;   // hex: IV + Tag + encrypted DEK bytes
};

export type DecryptResult = {
  plaintext: Buffer;
};

function parseMasterKey(masterKeyHex: string): Buffer {
  const cleaned = (masterKeyHex ?? "").trim();
  if (cleaned.length < 64) {
    throw new Error(
      "STORAGE_MASTER_KEY must be a 64-character hex string (32 bytes). " +
      "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return Buffer.from(cleaned.slice(0, 64), "hex");
}

function encryptWithKey(plaintext: Buffer, key: Buffer): Buffer {
  const iv     = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct     = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

function decryptWithKey(payload: Buffer, key: Buffer): Buffer {
  const iv      = payload.subarray(0, IV_BYTES);
  const tag     = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct      = payload.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export class StorageEncryption {
  private masterKey: Buffer;

  constructor(masterKeyHex: string) {
    this.masterKey = parseMasterKey(masterKeyHex);
  }

  // Encrypt file bytes. Returns ciphertext to store in S3 and the encrypted
  // DEK to store in the database (never in S3).
  encrypt(plaintext: Buffer): EncryptResult {
    const dek  = randomBytes(KEY_BYTES);
    const ciphertext   = encryptWithKey(plaintext, dek);
    const encryptedDek = encryptWithKey(dek, this.masterKey).toString("hex");
    return { ciphertext, encryptedDek };
  }

  // Decrypt file bytes retrieved from S3 using the encrypted DEK from the DB.
  decrypt(ciphertext: Buffer, encryptedDekHex: string): DecryptResult {
    const dek = decryptWithKey(Buffer.from(encryptedDekHex, "hex"), this.masterKey);
    const plaintext = decryptWithKey(ciphertext, dek);
    return { plaintext };
  }

  // Verify the master key is valid without exposing the key itself.
  selfTest(): boolean {
    try {
      const sample = Buffer.from("igfxpro-enc-selftest");
      const { ciphertext, encryptedDek } = this.encrypt(sample);
      const { plaintext } = this.decrypt(ciphertext, encryptedDek);
      return plaintext.toString() === sample.toString();
    } catch {
      return false;
    }
  }

  get isConfigured(): boolean {
    return this.masterKey.length === KEY_BYTES;
  }
}
