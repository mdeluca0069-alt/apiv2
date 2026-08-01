/**
 * mfa.enforcer.stepup.race.spec.ts
 *
 * PHASE C PENTEST (race-condition finding #3): checkStepUp() previously did
 * `redis.get(key)` -> JS `if (token.consumed)` check -> `redis.setex` to
 * mark it consumed -- a plain read-modify-write with no atomicity. Two
 * concurrent requests carrying the same single-use step-up token (client
 * double-submit, two tabs, or a deliberate race) could both read
 * consumed:false before either wrote back, so both would pass the gate and
 * both proceed to the guarded operation (e.g. two concurrent withdrawal or
 * 2FA-disable calls authorized by ONE MFA verification).
 *
 * Fix: single-use operation classes (WITHDRAWAL, CAPITAL_OPERATION,
 * SECURITY_CHANGE) now go through a Lua script that GETs, checks, and
 * SETs consumed in one atomic Redis EVAL -- Redis never interleaves
 * commands within a script, so two concurrent EVAL calls for the same key
 * are fully serialized; only the first can observe consumed:false.
 *
 * This mock's `eval` implementation faithfully replicates the real Lua
 * script's logic against an in-memory store (not just returning a
 * canned value), so these tests exercise the actual check-then-consume
 * semantics, not a mocked-away assumption that it works.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("id") }));
vi.mock("../security/immutable.audit.js", () => ({ immutableAudit: { write: mockAuditWrite } }));
vi.mock("../shared/db.js", () => ({ prisma: null, IS_PERSISTENT: false }));
vi.mock("../auth-service/2fa.service.js", () => ({ twoFactorService: { isEnabled: vi.fn() } }));

// In-memory Redis stand-in. `eval` replicates CONSUME_STEPUP_SCRIPT's exact
// GET -> check expiresAt/consumed -> SET logic against this store, so a
// "concurrent" call in these tests really does observe whatever the first
// call already committed (same as two real EVALs serialized by Redis).
const store = new Map<string, string>();

function fakeEval(_script: string, _numKeys: number, key: string, nowMs: number, _ttlSeconds: number): string | null {
  const raw = store.get(key);
  if (!raw) return null;
  let token: { expiresAt: number; consumed: boolean; [k: string]: unknown };
  try {
    token = JSON.parse(raw);
  } catch {
    store.delete(key);
    return "INVALID";
  }
  if (token.expiresAt < nowMs) {
    store.delete(key);
    return "EXPIRED";
  }
  if (token.consumed) return "ALREADY_CONSUMED";
  token.consumed = true;
  const encoded = JSON.stringify(token);
  store.set(key, encoded);
  return encoded;
}

// A real event-loop tick between GET and the caller's subsequent SETEX --
// this is what makes a genuine concurrency race observable in a
// single-threaded JS test. Without this, two sequential `await
// checkStepUp()` calls never actually interleave (the first fully
// resolves, including its write, before the second's read even starts),
// which would make even the OLD non-atomic implementation look safe in a
// naive test -- the real bug only manifests when two callers' GETs both
// land before either's SETEX does.
const tick = () => new Promise((r) => setTimeout(r, 5));

const mockRedis = {
  get:    vi.fn(async (key: string) => { await tick(); return store.get(key) ?? null; }),
  setex:  vi.fn(async (key: string, _ttl: number, val: string) => { await tick(); store.set(key, val); return "OK"; }),
  del:    vi.fn(async (key: string) => { store.delete(key); return 1; }),
  eval:   vi.fn(async (...args: [string, number, string, number, number]) => fakeEval(...args)),
};

vi.mock("../shared/redis.js", () => ({ getRedis: vi.fn(() => mockRedis) }));

const { mfaEnforcer } = await import("../security/mfa.enforcer.js");

function seedToken(userId: string, operationClass: string, overrides: Partial<{ consumed: boolean; expiresAt: number }> = {}) {
  const key = `mfa:stepup:${userId}:${operationClass}`;
  store.set(key, JSON.stringify({
    token: "tok-1", userId, operationClass,
    issuedAt: Date.now(), expiresAt: Date.now() + 300_000,
    method: "totp", consumed: false,
    ...overrides,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
});

describe("MFAEnforcer.checkStepUp() — PHASE C PENTEST: atomic single-use consumption", () => {
  it("accepts a valid, unconsumed single-use token and marks it consumed", async () => {
    seedToken("user-1", "WITHDRAWAL");

    const result = await mfaEnforcer.checkStepUp("user-1", "WITHDRAWAL");

    expect(result.valid).toBe(true);
    const stored = JSON.parse(store.get("mfa:stepup:user-1:WITHDRAWAL")!);
    expect(stored.consumed).toBe(true);
  });

  it("REPLAY / DOUBLE-SPEND: the same single-use token cannot authorize two SEQUENTIAL operations", async () => {
    seedToken("user-1", "WITHDRAWAL");

    const first = await mfaEnforcer.checkStepUp("user-1", "WITHDRAWAL");
    expect(first.valid).toBe(true);

    const second = await mfaEnforcer.checkStepUp("user-1", "WITHDRAWAL");
    expect(second.valid).toBe(false);
    expect((second as { reason: string }).reason).toContain("already consumed");
  });

  it("REPLAY / DOUBLE-SPEND under true CONCURRENCY: two interleaved checkStepUp() calls for the same token, only one succeeds", async () => {
    // This is the actual bug scenario: two requests racing, not two
    // sequential calls. mockRedis.get()/setex() both yield a real
    // event-loop tick (see the `tick()` helper above), so if checkStepUp()
    // were still doing a separate GET-then-SETEX (the old, non-atomic
    // shape), both concurrent calls' GETs would land before either's
    // SETEX -- both would observe consumed:false and both would succeed.
    // The atomic eval()-based fix has no such gap: each call is a single
    // round-trip Redis executes without interleaving any other command.
    seedToken("user-1", "WITHDRAWAL");

    const [a, b] = await Promise.all([
      mfaEnforcer.checkStepUp("user-1", "WITHDRAWAL"),
      mfaEnforcer.checkStepUp("user-1", "WITHDRAWAL"),
    ]);

    const successes = [a, b].filter((r) => r.valid).length;
    expect(successes).toBe(1);
  });

  it("rejects an expired single-use token and deletes it", async () => {
    seedToken("user-1", "SECURITY_CHANGE", { expiresAt: Date.now() - 1000 });

    const result = await mfaEnforcer.checkStepUp("user-1", "SECURITY_CHANGE");

    expect(result.valid).toBe(false);
    expect(store.has("mfa:stepup:user-1:SECURITY_CHANGE")).toBe(false);
  });

  it("rejects when no token exists at all", async () => {
    const result = await mfaEnforcer.checkStepUp("user-1", "CAPITAL_OPERATION");
    expect(result.valid).toBe(false);
    expect((result as { reason: string }).reason).toContain("required");
  });

  it("multi-use operation classes (e.g. KYC_APPROVAL) are NOT consumed on check -- can be reused within the window", async () => {
    seedToken("user-1", "KYC_APPROVAL");

    const first = await mfaEnforcer.checkStepUp("user-1", "KYC_APPROVAL");
    const second = await mfaEnforcer.checkStepUp("user-1", "KYC_APPROVAL");

    expect(first.valid).toBe(true);
    expect(second.valid).toBe(true);
    // Confirms the multi-use path never touched eval() (no mutation risk).
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it("different operation classes for the same user have independent single-use state", async () => {
    seedToken("user-1", "WITHDRAWAL");
    seedToken("user-1", "SECURITY_CHANGE");

    const withdrawal = await mfaEnforcer.checkStepUp("user-1", "WITHDRAWAL");
    const securityChange = await mfaEnforcer.checkStepUp("user-1", "SECURITY_CHANGE");

    expect(withdrawal.valid).toBe(true);
    expect(securityChange.valid).toBe(true);
  });
});
