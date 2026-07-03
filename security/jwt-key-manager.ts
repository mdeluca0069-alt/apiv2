/**
 * security/jwt-key-manager.ts — JWT key rotation with kid support.
 *
 * Maintains a primary key slot and an optional secondary slot (the previous
 * primary, kept valid during a 24-hour grace period after rotation).
 *
 * Tokens carry a `kid` header derived from the first 16 hex chars of SHA-256
 * of the verification key, so verification can immediately select the right slot.
 */

import {
  createHash,
  createHmac,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { TokenPayload } from "../shared/security.js";

// ── Key slot ───────────────────────────────────────────────────────────────────

export interface KeySlot {
  kid:       string;
  signingKey: string;
  verifyKey:  string;
  algorithm: "RS256" | "HS256";
  createdAt: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1_000;
const TOKEN_TTL_S     = 7 * 24 * 60 * 60;

function computeKid(keyMaterial: string): string {
  return createHash("sha256").update(keyMaterial).digest("hex").slice(0, 16);
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(s: string): Buffer {
  return Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

function makeHs256Slot(secret: string): KeySlot {
  return { kid: computeKid(secret), signingKey: secret, verifyKey: secret, algorithm: "HS256", createdAt: Date.now() };
}

function makeRs256Slot(privateKey: string, publicKey: string): KeySlot {
  return { kid: computeKid(publicKey), signingKey: privateKey, verifyKey: publicKey, algorithm: "RS256", createdAt: Date.now() };
}

function generateHs256Slot(): KeySlot {
  return makeHs256Slot(randomBytes(64).toString("hex"));
}

function generateRs256Slot(): KeySlot {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength:      2048,
    publicKeyEncoding:  { type: "spki",  format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return makeRs256Slot(privateKey as string, publicKey as string);
}

// ── Token building ─────────────────────────────────────────────────────────────

function signToken(slot: KeySlot, payload: Omit<TokenPayload, "exp">, ttlSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: slot.algorithm, typ: "JWT", kid: slot.kid }));
  const body   = base64Url(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1_000) + ttlSeconds }),
  );
  const sigInput = `${header}.${body}`;

  let signature: string;
  if (slot.algorithm === "RS256") {
    const signer = createSign("RSA-SHA256");
    signer.update(sigInput);
    signature = signer.sign(slot.signingKey, "base64")
      .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  } else {
    signature = base64Url(createHmac("sha256", slot.signingKey).update(sigInput).digest());
  }
  return `${header}.${body}.${signature}`;
}

function verifyWithSlot(token: string, slot: KeySlot): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const sigInput = `${header}.${body}`;

  try {
    if (slot.algorithm === "RS256") {
      const verifier = createVerify("RSA-SHA256");
      verifier.update(sigInput);
      const norm = signature.replaceAll("-", "+").replaceAll("_", "/");
      if (!verifier.verify(slot.verifyKey, norm, "base64")) return null;
    } else {
      const expected = base64Url(createHmac("sha256", slot.verifyKey).update(sigInput).digest());
      const sigBuf   = Buffer.from(signature);
      const expBuf   = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
    }
    const parsed = JSON.parse(decodeBase64Url(body).toString("utf8")) as TokenPayload;
    if (parsed.exp < Math.floor(Date.now() / 1_000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function extractKid(token: string): string | null {
  try {
    const headerB64 = token.split(".")[0] ?? "";
    const header = JSON.parse(decodeBase64Url(headerB64).toString("utf8")) as { kid?: unknown };
    return typeof header.kid === "string" ? header.kid : null;
  } catch {
    return null;
  }
}

// ── Manager ────────────────────────────────────────────────────────────────────

interface KeyState {
  primary:   KeySlot;
  secondary: KeySlot | null;
}

class JwtKeyManager {
  private state:          KeyState | null = null;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  init(): void {
    const pk   = process.env.JWT_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
    const pub  = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, "\n") ?? "";
    const sec  = process.env.JWT_SECRET    ?? "";
    const sec2 = process.env.JWT_SECRET_SECONDARY ?? "";
    const pk2  = process.env.JWT_PRIVATE_KEY_2?.replace(/\\n/g, "\n") ?? "";
    const pub2 = process.env.JWT_PUBLIC_KEY_2?.replace(/\\n/g, "\n") ?? "";

    const useRSA  = pk.includes("BEGIN") && pub.includes("BEGIN");
    const primary = useRSA ? makeRs256Slot(pk, pub) : makeHs256Slot(sec);

    let secondary: KeySlot | null = null;
    if (useRSA && pk2.includes("BEGIN") && pub2.includes("BEGIN")) {
      secondary = makeRs256Slot(pk2, pub2);
    } else if (!useRSA && sec2.length >= 32) {
      secondary = makeHs256Slot(sec2);
    }

    this.state = { primary, secondary };
    console.log(
      `[jwt-key-manager] initialized kid=${primary.kid} alg=${primary.algorithm}` +
      (secondary ? ` secondary-kid=${secondary.kid}` : ""),
    );
  }

  rotate(): void {
    if (!this.state) throw new Error("[jwt-key-manager] not initialized");
    const previous = this.state.primary;

    const newPrimary = previous.algorithm === "RS256"
      ? generateRs256Slot()
      : generateHs256Slot();

    this.state = { primary: newPrimary, secondary: previous };
    console.log(`[jwt-key-manager] rotated primary=${newPrimary.kid} grace-secondary=${previous.kid}`);

    setTimeout(() => {
      if (this.state?.secondary?.kid === previous.kid) {
        this.state = { ...this.state, secondary: null };
        console.log(`[jwt-key-manager] grace period expired for kid=${previous.kid}`);
      }
    }, GRACE_PERIOD_MS);
  }

  scheduleAutoRotation(intervalMs = 24 * 60 * 60 * 1_000): void {
    if (this.rotationTimer) return;
    this.rotationTimer = setInterval(() => this.rotate(), intervalMs);
    console.log(`[jwt-key-manager] auto-rotation every ${intervalMs / 3_600_000}h`);
  }

  getPrimarySlot(): KeySlot {
    if (!this.state) throw new Error("[jwt-key-manager] not initialized");
    return this.state.primary;
  }

  getVerificationSlots(): KeySlot[] {
    if (!this.state) throw new Error("[jwt-key-manager] not initialized");
    const slots: KeySlot[] = [this.state.primary];
    if (this.state.secondary) slots.push(this.state.secondary);
    return slots;
  }

  createToken(payload: Omit<TokenPayload, "exp">, ttlSeconds = TOKEN_TTL_S): string {
    return signToken(this.getPrimarySlot(), payload, ttlSeconds);
  }

  verifyToken(token: string): TokenPayload | null {
    const kid   = extractKid(token);
    const slots = this.getVerificationSlots();
    // Try kid-matched slot first for O(1) common path, then fall back to all
    const ordered = kid
      ? [...slots].sort((a) => (a.kid === kid ? -1 : 1))
      : slots;
    for (const slot of ordered) {
      const result = verifyWithSlot(token, slot);
      if (result) return result;
    }
    return null;
  }
}

export const jwtKeyManager = new JwtKeyManager();
