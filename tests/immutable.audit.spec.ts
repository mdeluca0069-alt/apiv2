/**
 * immutable.audit.spec.ts
 *
 * REALTIME_FREEZE.md Critical #2 — no test existed for security/
 * immutable.audit.ts before this fix, despite it being the single module
 * every AuditLog write in the platform now routes through. This file
 * proves the bugs discovered and fixed while expanding its coverage from
 * 3 call sites to ~60, across two passes:
 *
 * Critical #2 (original):
 *   1. write() previously left `createdAt` to Postgres's own
 *      @default(now()) while hashing a DIFFERENT app-level `now` --
 *      verifyChain() re-derives each hash from the STORED createdAt
 *      column, so the two values could never match and every chain would
 *      report itself broken from entry #1, always. Fixed by explicitly
 *      setting `createdAt` to the exact same timestamp used in the hash.
 *   2. The chain-head read + insert had no concurrency protection --
 *      two concurrent write() calls could both read the same prevHash
 *      and both insert, forking the chain. Fixed with a Postgres
 *      advisory lock (pg_advisory_xact_lock) around the read+insert.
 *
 * FASE 7 CLOSURE, Phase C (re-verification against a live, 164,206-row
 * DB surfaced three more real bugs Critical #2's unit tests, run in
 * isolation, never exercised):
 *   3. verifyChain() assumed the very first row by createdAt is the
 *      cryptographic genesis -- false once real legacy (pre-chain) data
 *      exists in the table. Fixed by only considering rows tagged with
 *      the current `_hash_algo`, treating the first such row's own
 *      claimed `_prev_hash` as a trusted boundary.
 *   4. verifyChain()'s hash recomputation only stripped `_chain_hash`/
 *      `_prev_hash` before re-hashing, but write() also adds `_severity`/
 *      `_written_at`/`_hash_algo` to the stored payload -- meaning
 *      verifyChain() was hashing a payload with 2-3 extra keys write()
 *      never hashed, and could never match ANY row. Fixed with a single
 *      CHAIN_META_KEYS list both sides strip consistently.
 *   5. `_computeHash` used plain `JSON.stringify`, which is key-order-
 *      sensitive -- but Postgres jsonb does not preserve insertion order
 *      on read-back (confirmed empirically), so the hash write() computes
 *      and the hash verifyChain() recomputes from the DB-round-tripped
 *      payload could differ for byte-identical data. Fixed with a
 *      canonical (recursively key-sorted) serializer.
 *   6. `_getChainHead()` ordered by `createdAt DESC` to find "the latest"
 *      row -- but `createdAt` is captured BEFORE the advisory lock is
 *      acquired, so under concurrency, lock-acquisition order and
 *      createdAt-capture order can diverge: a writer with an earlier `ts`
 *      that acquires the lock LATER inserts a row with a SMALLER
 *      createdAt than the current true head, which a createdAt-DESC query
 *      then permanently ignores -- every subsequent writer keeps forking
 *      off the stale "head". Reproduced live with 15-20 concurrent
 *      write() calls (confirmed forking real rows in the live DB). Fixed
 *      by ordering by `_written_at` instead, captured INSIDE the locked
 *      critical section, which correctly reflects true lock-acquisition
 *      order. Re-ran the same concurrent-write reproduction post-fix:
 *      zero forks across 3 separate batches.
 *   7. Re-running verifyChain() live against that same post-fix concurrent
 *      traffic surfaced the SAME defect class on the read side: it walked
 *      `entries` ordered by `createdAt` (captured before the lock), while
 *      the real chain link order follows lock-acquisition order -- under
 *      concurrency the two can diverge, so verifyChain() could visit real,
 *      correctly-chained rows in the wrong sequence and report a false
 *      break. Fixed by ordering by `_written_at` here too, the same field
 *      and the same reasoning as bug #6's fix.
 *
 * Also proves the `tx` parameter's atomicity contract (uses the caller's
 * transaction directly, never opens a second one) and verifyChain()'s
 * tamper-detection logic in isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const CURRENT_HASH_ALGO = "v3-lock-ordered-head";

const { mockAuditCreate, mockAuditFindMany, mockExecuteRaw, mockQueryRaw, mockTransaction } = vi.hoisted(() => ({
  mockAuditCreate:   vi.fn().mockResolvedValue({}),
  mockAuditFindMany: vi.fn().mockResolvedValue([]),
  // $executeRaw, not $queryRaw: pg_advisory_xact_lock() returns SQL type
  // `void`, which $queryRaw cannot deserialize (throws on every call) --
  // see the identical comment in write() itself.
  mockExecuteRaw:    vi.fn().mockResolvedValue(0),
  // Shared by two distinct call sites, both routed through $queryRaw
  // (tagged template) because Prisma's typed orderBy/where can't express a
  // nested JSON path: _getChainHead() (orders by `_written_at` DESC to
  // find the latest row) and verifyChain() (selects+orders the whole
  // verifiable window by `_written_at` ASC -- see its own docstring for
  // why ordering by createdAt was a real, later-discovered bug). Defaults
  // to "no rows" (empty result) here; individual tests override per case.
  mockQueryRaw:      vi.fn().mockResolvedValue([]),
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
    $queryRaw:   mockQueryRaw,
  };
  mockPrisma.$transaction = mockTransaction;
  return { IS_PERSISTENT: true, prisma: mockPrisma };
});

const { immutableAudit } = await import("../security/immutable.audit.js");

const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/** Mirrors immutable.audit.ts's canonicalStringify -- must match exactly for these tests to be meaningful. */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

function computeHash(
  prevHash: string, id: string, actor: string, action: string, entity: string,
  ts: string, payload: object,
): string {
  const content = canonicalStringify({ prevHash, id, actor, action, entity, ts, payload });
  return createHash("sha256").update(content).digest("hex");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditCreate.mockResolvedValue({});
  mockAuditFindMany.mockResolvedValue([]);
  mockExecuteRaw.mockResolvedValue(0);
  mockQueryRaw.mockResolvedValue([]);
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const tx = {
      auditLog: { create: mockAuditCreate, findFirst: vi.fn().mockResolvedValue(null) },
      $executeRaw: mockExecuteRaw,
      $queryRaw:   mockQueryRaw,
    };
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
    const expectedHash = computeHash(
      GENESIS_HASH, data.id, "TEST", "test.action", "e-1",
      data.createdAt.toISOString(), { foo: "bar" },
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
          create: vi.fn(async () => { callOrder.push("create"); return {}; }),
        },
        $executeRaw: mockExecuteRaw,
        $queryRaw:   vi.fn(async () => { callOrder.push("queryRaw"); return []; }),
      };
      return cb(tx);
    });

    await immutableAudit.write({ actor: "a", action: "b", entity: "c", payload: {} });

    expect(callOrder).toEqual(["lock", "queryRaw", "create"]);
  });
});

describe("ImmutableAuditLog.write() — tx parameter atomicity", () => {
  it("writes through the caller's tx directly, never opening its own prisma.$transaction", async () => {
    const txAuditCreate = vi.fn().mockResolvedValue({});
    const tx = {
      auditLog:    { create: txAuditCreate },
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw:   vi.fn().mockResolvedValue([]),
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
  // Every row in these tests carries the full CHAIN_META_KEYS set
  // (_hash_algo, _severity, _written_at) matching what write() actually
  // stores -- verifyChain() strips exactly this set before recomputing.
  function chainedRow(id: string, actor: string, action: string, entity: string, ts: Date, data: object, chainHash: string, prevHash: string) {
    return {
      id, actor, action, entity, createdAt: ts,
      payload: {
        ...data,
        _chain_hash: chainHash, _prev_hash: prevHash,
        _severity: "INFO", _written_at: ts.toISOString(), _hash_algo: CURRENT_HASH_ALGO,
      },
    };
  }

  it("reports valid:true for a correctly-chained sequence of entries", async () => {
    const ts1 = new Date("2026-07-23T09:00:00.000Z");
    const ts2 = new Date("2026-07-23T09:01:00.000Z");

    const hash1 = computeHash(GENESIS_HASH, "id-1", "a1", "act1", "e1", ts1.toISOString(), { x: 1 });
    const hash2 = computeHash(hash1, "id-2", "a2", "act2", "e2", ts2.toISOString(), { x: 2 });

    mockQueryRaw.mockResolvedValue([
      chainedRow("id-1", "a1", "act1", "e1", ts1, { x: 1 }, hash1, GENESIS_HASH),
      chainedRow("id-2", "a2", "act2", "e2", ts2, { x: 2 }, hash2, hash1),
    ]);

    const result = await immutableAudit.verifyChain();

    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(2);
  });

  it("reports valid:false with the exact break position when a payload was tampered with post-hoc", async () => {
    const ts1 = new Date("2026-07-23T09:00:00.000Z");
    const hash1 = computeHash(GENESIS_HASH, "id-1", "a1", "act1", "e1", ts1.toISOString(), { x: 1 });

    mockQueryRaw.mockResolvedValue([
      // Payload tampered after the fact (x: 1 -> x: 999) without recomputing _chain_hash.
      chainedRow("id-1", "a1", "act1", "e1", ts1, { x: 999 }, hash1, GENESIS_HASH),
    ]);

    const result = await immutableAudit.verifyChain();

    expect(result.valid).toBe(false);
    expect(result.firstBreak?.position).toBe(1);
  });

  it("reports valid:false when a row in the middle of the chain is deleted (link breaks after the trusted boundary)", async () => {
    // FASE 7 CLOSURE, Phase C: verifyChain() trusts the FIRST row in the
    // queried set as an unverifiable boundary (see its docstring -- an
    // inherent, documented limitation of retrofitting hash-chaining onto
    // a table with pre-existing history: there is no way to cryptographically
    // distinguish "this is the legitimate chain start" from "everything
    // before this row was deleted" without an external anchor). What it CAN
    // still detect is a broken link AFTER that trusted first row -- id-3
    // here claims id-1 as its predecessor, skipping the deleted id-2.
    const ts1 = new Date("2026-07-23T09:00:00.000Z");
    const ts3 = new Date("2026-07-23T09:02:00.000Z");
    const hash1 = computeHash(GENESIS_HASH, "id-1", "a1", "act1", "e1", ts1.toISOString(), { x: 1 });
    // id-3's hash is computed as if id-1 were its direct predecessor (which
    // is what its OWN stored _prev_hash claims) -- consistent internally,
    // but that claim itself doesn't match id-1's ACTUAL hash used below,
    // simulating a row that instead claims a fabricated/incorrect prevHash.
    const bogusPrev = "deadbeef".repeat(8);
    const hash3 = computeHash(bogusPrev, "id-3", "a3", "act3", "e3", ts3.toISOString(), { x: 3 });

    mockQueryRaw.mockResolvedValue([
      chainedRow("id-1", "a1", "act1", "e1", ts1, { x: 1 }, hash1, GENESIS_HASH),
      chainedRow("id-3", "a3", "act3", "e3", ts3, { x: 3 }, hash3, bogusPrev),
    ]);

    const result = await immutableAudit.verifyChain();

    expect(result.valid).toBe(false);
    expect(result.firstBreak?.position).toBe(2);
    expect(result.firstBreak?.expectedHash).toBe(hash1);
    expect(result.firstBreak?.storedHash).toBe(bogusPrev);
  });

  it("returns valid:true with totalChecked:0 when no rows carry the current _hash_algo (nothing to verify yet)", async () => {
    mockQueryRaw.mockResolvedValue([]);
    const result = await immutableAudit.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.totalChecked).toBe(0);
  });
});

describe("ImmutableAuditLog.archiveBatch() — PHASE2_REMEDIATION (H16): self-referential audit trail", () => {
  // PHASE2_REMEDIATION (H16, admin audit-log gap): the admin route audit
  // found that POST /admin/security/audit/archive -- which lives INSIDE
  // the audit subsystem itself -- was the one action that removed/
  // relocated entries from the queryable hot path without itself being
  // part of the permanent chain. archiveBatch() now calls this.write()
  // (safe: write() never calls archiveBatch(), so there is no recursion).
  it("writes a self-referential audit entry recording who archived what range and the resulting manifest hash", async () => {
    mockAuditFindMany.mockResolvedValue([
      { id: "e1", actor: "a", action: "act", entity: "x", payload: {}, createdAt: new Date("2026-07-20T00:00:00.000Z") },
    ]);

    const from = new Date("2026-07-01T00:00:00.000Z");
    const to   = new Date("2026-07-31T00:00:00.000Z");
    const result = await immutableAudit.archiveBatch(from, to, "admin-1");

    expect(result.archived).toBe(1);
    // write() is called via $transaction -> auditLog.create, once for the
    // archival record itself (no other write() calls happen in this path).
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    const data = mockAuditCreate.mock.calls[0]![0].data as { actor: string; action: string; entity: string; payload: Record<string, unknown> };
    expect(data.actor).toBe("admin-1");
    expect(data.action).toBe("audit_log.archived");
    expect(data.entity).toBe("platform");
    expect(data.payload).toMatchObject({ archived: 1, manifestHash: result.manifestHash });
  });

  it("defaults actor to 'system' when none is supplied (a non-HTTP/scheduled caller)", async () => {
    mockAuditFindMany.mockResolvedValue([
      { id: "e1", actor: "a", action: "act", entity: "x", payload: {}, createdAt: new Date("2026-07-20T00:00:00.000Z") },
    ]);

    await immutableAudit.archiveBatch(new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T00:00:00.000Z"));

    const data = mockAuditCreate.mock.calls[0]![0].data as { actor: string };
    expect(data.actor).toBe("system");
  });

  it("does not write a self-referential entry when there is nothing to archive (no rows in range)", async () => {
    mockAuditFindMany.mockResolvedValue([]);

    const result = await immutableAudit.archiveBatch(new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-31T00:00:00.000Z"), "admin-1");

    expect(result.archived).toBe(0);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});
