/**
 * immutable.audit.spec.ts
 *
 * REALTIME_FREEZE.md Critical #2 — no test existed for security/
 * immutable.audit.ts before this fix, despite it being the single module
 * every AuditLog write in the platform now routes through. This file
 * proves the two bugs discovered and fixed while expanding its coverage
 * from 3 call sites to ~60:
 *
 *   1. write() previously left `createdAt` to Postgres's own
 *      @default(now()) while hashing a DIFFERENT app-level `now` --
 *      verifyChain() re-derives each hash from the STORED createdAt
 *      column, so the two values could never match and every chain would
 *      report itself broken from entry #1, always. Fixed by explicitly
 *      setting `createdAt` to the exact same timestamp used in the hash.
 *   2. The chain-head read + insert had no concurrency protection --
 *      two concurrent write() calls could both read the same prevHash
 *      and both insert, forking the chain (a false "tampering" positive
 *      on two entirely legitimate writes). Fixed with a Postgres
 *      advisory lock (pg_advisory_xact_lock) around the read+insert.
 *
 * Also proves the `tx` parameter's atomicity contract (uses the caller's
 * transaction directly, never opens a second one) and verifyChain()'s
 * tamper-detection logic in isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const { mockAuditCreate, mockAuditFindMany, mockExecuteRaw, mockTransaction } = vi.hoisted(() => ({
  mockAuditCreate:   vi.fn().mockResolvedValue({}),
  mockAuditFindMany: vi.fn().mockResolvedValue([]),
  // $executeRaw, not $queryRaw: pg_advisory_xact_lock() returns SQL type
  // `void`, which $queryRaw cannot deserialize (throws on every call) --
  // see the identical comment in write() itself.
  mockExecuteRaw:    vi.fn().mockResolvedValue(0),
  mockTransaction:   vi.fn(),
}));

vi.mock("../shared/db.js", () => {
  const mockPrisma: Record<string, unknown> = {
    auditLog: {
      create:   mockAuditCreate,
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: mockAuditFindMany,
    },
    $executeRaw: mockExecuteRaw,
  };
  mockPrisma.$transaction = mockTransaction;
  return { IS_PERSISTENT: true, prisma: mockPrisma };
});

const { immutableAudit } = await import("../security/immutable.audit.js");

const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

function computeHash(
  prevHash: string, id: string, actor: string, action: string, entity: string,
  ts: string, payload: object,
): string {
  const content = JSON.stringify({ prevHash, id, actor, action, entity, ts, payload });
  return createHash("sha256").update(content).digest("hex");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditCreate.mockResolvedValue({});
  mockAuditFindMany.mockResolvedValue([]);
  mockExecuteRaw.mockResolvedValue(0);
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const tx = { auditLog: { create: mockAuditCreate, findFirst: vi.fn().mockResolvedValue(null) }, $executeRaw: mockExecuteRaw };
    return cb(tx);
  });
});

describe("ImmutableAuditLog.write() — Bug: createdAt/hash timestamp consistency", () => {
  it("stores createdAt EXACTLY equal to the timestamp used to compute _chain_hash (the core bug)", async () => {
    const fixedNow = new Date("2026-07-23T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    await immutableAudit.write({
      actor: "TEST", action: "test.action", entity: "e-1", payload: { foo: "bar" },
    });

    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    const data = mockAuditCreate.mock.calls[0][0].data as {
      id: string; createdAt: Date; payload: { _chain_hash: string; _prev_hash: string };
    };

    // The bug: createdAt used to be omitted (Postgres default), which is a
    // DIFFERENT instant than the `now` used to compute the hash below.
    expect(data.createdAt).toEqual(fixedNow);

    // Recompute the hash independently using the STORED createdAt (exactly
    // what verifyChain() does) and confirm it matches the stored hash --
    // this is only possible if createdAt and the hash's `ts` input are the
    // same value, which is the fix.
    const cleanPayload = { ...data.payload };
    delete (cleanPayload as Record<string, unknown>)._chain_hash;
    delete (cleanPayload as Record<string, unknown>)._prev_hash;
    delete (cleanPayload as Record<string, unknown>)._severity;
    delete (cleanPayload as Record<string, unknown>)._written_at;
    const expectedHash = computeHash(
      GENESIS_HASH, data.id, "TEST", "test.action", "e-1",
      data.createdAt.toISOString(), { foo: "bar", ...cleanPayload },
    );
    expect(data.payload._chain_hash).toBe(expectedHash);

    vi.useRealTimers();
  });

  it("honors an explicit `timestamp` override for both the hash and the stored createdAt (audit.outbox.consumer.ts's use case)", async () => {
    const eventTime = new Date("2026-07-20T08:00:00.000Z");

    await immutableAudit.write({
      actor: "SYSTEM", action: "position.closed", entity: "pos-1", payload: {},
      timestamp: eventTime,
    });

    const data = mockAuditCreate.mock.calls[0][0].data as { createdAt: Date };
    expect(data.createdAt).toEqual(eventTime);
  });
});

describe("ImmutableAuditLog.write() — advisory lock ordering", () => {
  it("acquires the advisory lock before reading the chain head or inserting", async () => {
    const callOrder: string[] = [];
    mockExecuteRaw.mockImplementation(async () => { callOrder.push("lock"); return 0; });
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        auditLog: {
          create:    vi.fn(async () => { callOrder.push("create"); return {}; }),
          findFirst: vi.fn(async () => { callOrder.push("findFirst"); return null; }),
        },
        $executeRaw: mockExecuteRaw,
      };
      return cb(tx);
    });

    await immutableAudit.write({ actor: "a", action: "b", entity: "c", payload: {} });

    expect(callOrder).toEqual(["lock", "findFirst", "create"]);
  });
});

describe("ImmutableAuditLog.write() — tx parameter atomicity", () => {
  it("writes through the caller's tx directly, never opening its own prisma.$transaction", async () => {
    const txAuditCreate = vi.fn().mockResolvedValue({});
    const tx = {
      auditLog:    { create: txAuditCreate, findFirst: vi.fn().mockResolvedValue(null) },
      $executeRaw: vi.fn().mockResolvedValue(0),
    };

    await immutableAudit.write({ actor: "a", action: "b", entity: "c", payload: {} }, tx as never);

    expect(txAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockTransaction).not.toHaveBeenCalled();
    // The module-level mock's own auditLog.create must never be touched --
    // proves this write never fell back to a second, independent transaction.
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});

describe("ImmutableAuditLog.verifyChain() — tamper detection", () => {
  it("reports valid:true for a correctly-chained sequence of entries", async () => {
    const ts1 = new Date("2026-07-23T09:00:00.000Z");
    const ts2 = new Date("2026-07-23T09:01:00.000Z");

    const hash1 = computeHash(GENESIS_HASH, "id-1", "a1", "act1", "e1", ts1.toISOString(), { x: 1 });
    const hash2 = computeHash(hash1, "id-2", "a2", "act2", "e2", ts2.toISOString(), { x: 2 });

    mockAuditFindMany.mockResolvedValue([
      { id: "id-1", actor: "a1", action: "act1", entity: "e1", createdAt: ts1, payload: { x: 1, _chain_hash: hash1, _prev_hash: GENESIS_HASH } },
      { id: "id-2", actor: "a2", action: "act2", entity: "e2", createdAt: ts2, payload: { x: 2, _chain_hash: hash2, _prev_hash: hash1 } },
    ]);

    const result = await immutableAudit.verifyChain();

    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(2);
  });

  it("reports valid:false with the exact break position when a payload was tampered with post-hoc", async () => {
    const ts1 = new Date("2026-07-23T09:00:00.000Z");
    const hash1 = computeHash(GENESIS_HASH, "id-1", "a1", "act1", "e1", ts1.toISOString(), { x: 1 });

    mockAuditFindMany.mockResolvedValue([
      // Payload tampered after the fact (x: 1 -> x: 999) without recomputing _chain_hash.
      { id: "id-1", actor: "a1", action: "act1", entity: "e1", createdAt: ts1, payload: { x: 999, _chain_hash: hash1, _prev_hash: GENESIS_HASH } },
    ]);

    const result = await immutableAudit.verifyChain();

    expect(result.valid).toBe(false);
    expect(result.firstBreak?.position).toBe(1);
  });

  it("reports valid:false when a prev_hash link is broken (a row deleted from the middle of the chain)", async () => {
    const ts2 = new Date("2026-07-23T09:01:00.000Z");
    const bogusPrev = "deadbeef".repeat(8);
    const hash2 = computeHash(bogusPrev, "id-2", "a2", "act2", "e2", ts2.toISOString(), { x: 2 });

    mockAuditFindMany.mockResolvedValue([
      { id: "id-2", actor: "a2", action: "act2", entity: "e2", createdAt: ts2, payload: { x: 2, _chain_hash: hash2, _prev_hash: bogusPrev } },
    ]);

    const result = await immutableAudit.verifyChain();

    expect(result.valid).toBe(false);
    expect(result.firstBreak?.expectedHash).toBe(GENESIS_HASH);
    expect(result.firstBreak?.storedHash).toBe(bogusPrev);
  });
});
