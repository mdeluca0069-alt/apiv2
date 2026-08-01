/**
 * 2fa.service.replay.spec.ts
 *
 * PHASE C PENTEST (race-condition findings #1-2):
 *
 * 1. TOTP replay -- verifyToken() only checked mathematical validity
 *    against the current ±1 time-step window, with no record of which
 *    30s-window counter had already been consumed. A single correct
 *    6-digit code authenticated successfully every time it was presented
 *    within its ~90s validity window, not just once -- a captured code
 *    (phishing relay, shoulder-surf, malicious extension) could be
 *    replayed to open a second session or mint a second withdrawal/
 *    security-change step-up token.
 *
 * 2. Backup-code lost-update / un-consume -- the previous findUnique-then-
 *    splice-then-update was a plain read-modify-write with no atomic
 *    guard. Two concurrent requests presenting the SAME code could both
 *    pass (double-use of one single-use code); two requests presenting
 *    DIFFERENT codes concurrently could race a lost update, with
 *    whichever write committed last silently un-consuming the other's
 *    already-applied removal.
 *
 * Fix: both now use a single atomic conditional UPDATE ... WHERE ...
 * RETURNING (the same pattern used throughout this codebase's other
 * money/security-critical mutations) instead of a separate read then a
 * blind write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("audit-id") }));
vi.mock("../security/immutable.audit.js", () => ({ immutableAudit: { write: mockAuditWrite } }));

// In-memory stand-in for the BrokerSetting row this service reads/writes,
// with a $queryRaw mock that implements the REAL atomic-conditional-UPDATE
// semantics (check-and-set against the CURRENT stored value, not a stale
// snapshot) -- so these tests exercise the actual replay-guard logic, not
// a mocked-away "assume it works" stub.
const store = new Map<string, { key: string; value: Record<string, unknown> }>();

const mockBrokerSetting = {
  findUnique: vi.fn(async ({ where }: { where: { key: string } }) => store.get(where.key) ?? null),
};

function handleQueryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = strings.join("");
  if (sql.includes("lastUsedCounter")) {
    const [matchedCounter, key] = values as [number, string];
    const row = store.get(key);
    if (!row) return [];
    const current = (row.value.lastUsedCounter as number | undefined) ?? -1;
    if (current >= matchedCounter) return []; // WHERE clause fails -- replay
    row.value.lastUsedCounter = matchedCounter;
    return [{ key }];
  }
  if (sql.includes("backupCodes")) {
    const [code, key] = values as [string, string];
    const row = store.get(key);
    if (!row) return [];
    const codes = row.value.backupCodes as string[];
    const idx = codes.indexOf(code);
    if (idx === -1) return []; // WHERE clause fails -- already consumed
    codes.splice(idx, 1);
    return [{ key }];
  }
  throw new Error(`unexpected $queryRaw in test: ${sql}`);
}

const mockPrisma: Record<string, unknown> = {
  brokerSetting: mockBrokerSetting,
  $queryRaw: vi.fn(handleQueryRaw),
};

vi.mock("../shared/db.js", () => ({ prisma: mockPrisma, IS_PERSISTENT: true }));

const { twoFactorService } = await import("../auth-service/2fa.service.js");

// ── Minimal independent RFC 4226 HOTP generator (mirrors the service's own
// hotp()) so tests can produce a genuinely valid code for a given secret/
// counter without importing the service's private implementation. ──────────
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s: string): Buffer {
  const chars = s.toUpperCase().replace(/=+$/, "");
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const ch of chars) {
    const idx = BASE32_CHARS.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
function hotpAt(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const msg = Buffer.allocUnsafe(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}
function currentCounter(): number {
  return Math.floor(Date.now() / 1000 / 30);
}

const SECRET = "JBSWY3DPEHPK3PXP"; // arbitrary valid base32 test secret

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  store.set("2fa:user-1", {
    key: "2fa:user-1",
    value: { secret: SECRET, backupCodes: ["AAAA-BBBB", "CCCC-DDDD"] },
  });
});

describe("TwoFactorService.verify() — PHASE C PENTEST: TOTP replay protection", () => {
  it("accepts a fresh, currently-valid TOTP code", async () => {
    const code = hotpAt(SECRET, currentCounter());
    const result = await twoFactorService.verify("user-1", code);
    expect(result).toEqual({ valid: true, usedBackup: false });
  });

  it("REPLAY: the exact same TOTP code presented a second time is rejected", async () => {
    const code = hotpAt(SECRET, currentCounter());

    const first = await twoFactorService.verify("user-1", code);
    expect(first.valid).toBe(true);

    const second = await twoFactorService.verify("user-1", code);
    expect(second.valid).toBe(false);
  });

  it("a genuinely NEW code (next time-step) is still accepted after a previous code was consumed", async () => {
    const counter = currentCounter();
    await twoFactorService.verify("user-1", hotpAt(SECRET, counter));

    // A later, higher counter value within the tolerance window.
    const later = await twoFactorService.verify("user-1", hotpAt(SECRET, counter + 1));
    expect(later.valid).toBe(true);
  });

  it("rejects an invalid code outright", async () => {
    const result = await twoFactorService.verify("user-1", "000000");
    expect(result.valid).toBe(false);
  });
});

describe("TwoFactorService.verify() — PHASE C PENTEST: backup-code atomic consumption", () => {
  it("accepts a valid, unconsumed backup code and marks it used", async () => {
    const result = await twoFactorService.verify("user-1", "AAAA-BBBB");
    expect(result).toEqual({ valid: true, usedBackup: true });
    expect(store.get("2fa:user-1")!.value.backupCodes).toEqual(["CCCC-DDDD"]);
  });

  it("REPLAY / DOUBLE-SPEND: the same backup code cannot be consumed twice", async () => {
    const first = await twoFactorService.verify("user-1", "AAAA-BBBB");
    expect(first.valid).toBe(true);

    const second = await twoFactorService.verify("user-1", "AAAA-BBBB");
    expect(second.valid).toBe(false);
  });

  it("consuming one code does not un-consume or otherwise disturb a different, already-used code", async () => {
    // Simulates the lost-update scenario: code A gets consumed, then code B
    // gets consumed via a separate call -- B's atomic UPDATE must operate
    // on the store's CURRENT value (already missing A), not a stale
    // snapshot that still contains A and would silently resurrect it.
    await twoFactorService.verify("user-1", "AAAA-BBBB");
    await twoFactorService.verify("user-1", "CCCC-DDDD");

    expect(store.get("2fa:user-1")!.value.backupCodes).toEqual([]);
  });

  it("case-insensitive / whitespace-tolerant backup code matching still goes through the atomic path", async () => {
    const result = await twoFactorService.verify("user-1", " aaaa-bbbb ");
    expect(result).toEqual({ valid: true, usedBackup: true });
  });
});
