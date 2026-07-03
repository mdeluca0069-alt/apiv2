import {
  createHmac,
  createSign,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — covers full Mon–Fri trading week
const DEV_SECRET_DEFAULT = "local-development-secret-change-before-production";

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(input: string): Buffer {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(normalized, "base64");
}

export type TokenPayload = {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
  permissions: string[];
  exp: number;
};

function isRSAKey(key: string): boolean {
  return key.trimStart().startsWith("-----BEGIN");
}

function createTokenRS256(
  payload: Omit<TokenPayload, "exp">,
  privateKey: string,
  ttlSeconds: number
): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64Url(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  const signature = signer
    .sign(privateKey, "base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${header}.${body}.${signature}`;
}

function verifyTokenRS256(token: string, publicKey: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${body}`);
    const normalized = signature.replaceAll("-", "+").replaceAll("_", "/");
    const valid = verifier.verify(publicKey, normalized, "base64");
    if (!valid) return null;
    const parsed = JSON.parse(decodeBase64Url(body).toString("utf8")) as TokenPayload;
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function createTokenHS256(
  payload: Omit<TokenPayload, "exp">,
  secret: string,
  ttlSeconds: number
): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })
  );
  const signature = base64Url(
    createHmac("sha256", secret).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${signature}`;
}

function verifyTokenHS256(token: string, secret: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = base64Url(
    createHmac("sha256", secret).update(`${header}.${body}`).digest()
  );
  const sig = Buffer.from(signature);
  const exp = Buffer.from(expected);
  if (sig.length !== exp.length || !timingSafeEqual(sig, exp)) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(body).toString("utf8")) as TokenPayload;
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createToken(
  payload: Omit<TokenPayload, "exp">,
  signingKey: string,
  ttlSeconds = TOKEN_TTL_SECONDS
): string {
  return isRSAKey(signingKey)
    ? createTokenRS256(payload, signingKey, ttlSeconds)
    : createTokenHS256(payload, signingKey, ttlSeconds);
}

export function verifyToken(token: string, verifyKey: string): TokenPayload | null {
  return isRSAKey(verifyKey)
    ? verifyTokenRS256(token, verifyKey)
    : verifyTokenHS256(token, verifyKey);
}

export function createOpaqueToken(prefix: string): string {
  return `${prefix}_${base64Url(randomBytes(32))}`;
}

export function assertValidSecret(secret: string, context = "JWT_SECRET"): void {
  if (!secret || secret === DEV_SECRET_DEFAULT || secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `[security] FATAL: ${context} is missing, too short, or using the default dev value. ` +
        `Refusing to start in production. Generate with: openssl rand -hex 64`
      );
    }
    console.warn(
      `[security] WARNING: ${context} is using a weak or default value. ` +
      `This is acceptable in development only.`
    );
  }
}
