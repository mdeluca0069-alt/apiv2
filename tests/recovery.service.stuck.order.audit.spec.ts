/**
 * recovery.service.stuck.order.audit.spec.ts
 *
 * FASE 5.1 (Ledger, Bug #3, LEDGER_FREEZE.md §0.3) — RecoveryService's stuck-
 * order handling releases orphan margin in one transaction (Step 1), then
 * unconditionally rejects the order and writes an AuditLog row (Step 2) whose
 * payload set `marginReleased: order.status === "ACCEPTED"` -- true whenever
 * a release was ATTEMPTED, even if Step 1's transaction threw and never
 * actually wrote anything. A transient DB error left `wallet.locked`
 * permanently orphaned while the one audit record for the incident falsely
 * asserted the release had succeeded.
 *
 * Fix: a `marginReleased` flag is now set to true only inside the
 * transaction callback, after both writes have run -- so it can only be
 * true if Step 1 genuinely committed -- and that real flag, not a guess
 * derived from order.status, is what gets written to the audit payload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

vi.mock("../market-data/quote.cache.js", () => ({ quoteCache: { get: vi.fn().mockReturnValue(undefined) } }));

const { mockRunFull } = vi.hoisted(() => ({ mockRunFull: vi.fn().mockResolvedValue({ summary: "ok" }) }));
vi.mock("../settlement/reconciliation.engine.js", () => ({
  reconciliationEngine: { runFull: mockRunFull },
}));

const { mockSuspend, mockGetSuspendedUsers } = vi.hoisted(() => ({
  mockSuspend: vi.fn(),
  mockGetSuspendedUsers: vi.fn().mockReturnValue([]),
}));
vi.mock("../shared/trading.suspension.js", () => ({
  tradingSuspension: { suspend: mockSuspend, getSuspendedUsers: mockGetSuspendedUsers },
}));

const {
  mockPositionFindMany, mockWalletFindMany, mockOrderFindMany, mockPositionFindFirst,
  mockWalletFindUnique, mockWalletUpdate, mockLedgerCreate, mockOrderUpdate, mockAuditLogCreate,
  mockTransaction,
} = vi.hoisted(() => ({
  mockPositionFindMany:  vi.fn().mockResolvedValue([]),
  mockWalletFindMany:    vi.fn().mockResolvedValue([]),
  mockOrderFindMany:     vi.fn(),
  mockPositionFindFirst: vi.fn().mockResolvedValue(null), // no position -> margin is orphaned
  mockWalletFindUnique:  vi.fn(),
  mockWalletUpdate:      vi.fn(async () => ({})),
  mockLedgerCreate:      vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "l-1", ...args.data })),
  mockOrderUpdate:       vi.fn(async () => ({})),
  mockAuditLogCreate:    vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "a-1", ...args.data })),
  mockTransaction:       vi.fn(),
}));

vi.mock("../shared/db.js", () => {
  // REALTIME_FREEZE.md Critical #2: recovery.service.ts's order-auto-reject
  // AuditLog write is non-transactional (no `tx` threaded through), so it
  // now calls immutableAudit.write() with no tx -- which internally opens
  // its OWN prisma.$transaction(). Since this test's mockTransaction is a
  // single shared mock also used for recovery.service.ts's own internal
  // margin-release transaction, `tx` needs $executeRaw/$queryRaw/auditLog
  // too so either transaction's callback can run against it. $executeRaw
  // (not $queryRaw) backs the advisory lock itself (pg_advisory_xact_lock
  // returns void, which $queryRaw cannot deserialize); $queryRaw backs
  // _getChainHead()'s chain-head lookup.
  const tx = {
    walletAccount: { findUnique: mockWalletFindUnique, update: mockWalletUpdate },
    ledgerEntry:   { create: mockLedgerCreate },
    auditLog:      { create: mockAuditLogCreate },
    $executeRaw:   vi.fn().mockResolvedValue(0),
    $queryRaw:     vi.fn().mockResolvedValue([]),
  };
  return {
    IS_PERSISTENT: true,
    prisma: {
      position:      { findMany: mockPositionFindMany, findFirst: mockPositionFindFirst, aggregate: vi.fn().mockResolvedValue({ _sum: { marginUsed: null } }), update: vi.fn() },
      walletAccount: { findMany: mockWalletFindMany },
      order:         { findMany: mockOrderFindMany, update: mockOrderUpdate },
      auditLog:      { create: mockAuditLogCreate },
      $executeRaw:   vi.fn().mockResolvedValue(0),
      $queryRaw:     vi.fn().mockResolvedValue([]),
      $transaction:  mockTransaction,
      __tx: tx,
    },
  };
});

const { recoveryService } = await import("../settlement/recovery.service.js");
const { prisma } = await import("../shared/db.js");

const STUCK_ORDER = {
  id: "order-1", userId: "user-1", status: "ACCEPTED" as const,
  marginRequired: new Decimal(200), createdAt: new Date(Date.now() - 10 * 60 * 1000),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPositionFindMany.mockResolvedValue([]);
  mockWalletFindMany.mockResolvedValue([]);
  mockPositionFindFirst.mockResolvedValue(null);
  mockRunFull.mockResolvedValue({ summary: "ok" });
  mockGetSuspendedUsers.mockReturnValue([]);
  const tx = (prisma as unknown as { __tx: unknown }).__tx;
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
});

describe("RecoveryService — stuck-order audit payload reflects the real outcome (Bug #3)", () => {
  it("marginReleased: true only when the release transaction genuinely committed", async () => {
    mockOrderFindMany.mockResolvedValue([STUCK_ORDER]);
    mockWalletFindUnique.mockResolvedValue({ locked: new Decimal(200) });

    await recoveryService.run();

    expect(mockWalletUpdate).toHaveBeenCalledTimes(1);
    expect(mockLedgerCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const payload = mockAuditLogCreate.mock.calls[0][0].data.payload as { marginReleased: boolean };
    expect(payload.marginReleased).toBe(true);
  });

  it("marginReleased: false when the release transaction throws -- never claims a release that didn't happen", async () => {
    mockOrderFindMany.mockResolvedValue([STUCK_ORDER]);
    mockWalletFindUnique.mockResolvedValue({ locked: new Decimal(200) });
    mockTransaction.mockRejectedValueOnce(new Error("transient DB error"));

    await recoveryService.run();

    // The transaction never committed -- no wallet/ledger write should be visible.
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const payload = mockAuditLogCreate.mock.calls[0][0].data.payload as { marginReleased: boolean };
    expect(payload.marginReleased).toBe(false);
  });

  it("marginReleased: false when the transaction is a safe no-op (locked already zeroed) -- no write occurred", async () => {
    mockOrderFindMany.mockResolvedValue([STUCK_ORDER]);
    mockWalletFindUnique.mockResolvedValue({ locked: new Decimal(0) }); // safeRelease clamps to 0 -> early return inside tx

    await recoveryService.run();

    expect(mockWalletUpdate).not.toHaveBeenCalled();
    expect(mockLedgerCreate).not.toHaveBeenCalled();
    const payload = mockAuditLogCreate.mock.calls[0][0].data.payload as { marginReleased: boolean };
    expect(payload.marginReleased).toBe(false);
  });

  it("marginReleased: false for a stuck order that never reached ACCEPTED (no release ever attempted)", async () => {
    mockOrderFindMany.mockResolvedValue([{ ...STUCK_ORDER, status: "RECEIVED" as const }]);

    await recoveryService.run();

    // REALTIME_FREEZE.md Critical #2: mockTransaction is now ALSO the
    // transaction wrapper immutableAudit.write() opens for the (always
    // fired, unconditional) order.auto_rejected audit write itself -- so
    // it's no longer zero in this case. The actual invariant this test
    // guards -- the margin-RELEASE step was never attempted -- is what
    // mockWalletUpdate/mockLedgerCreate being uncalled proves.
    expect(mockWalletUpdate).not.toHaveBeenCalled();
    expect(mockLedgerCreate).not.toHaveBeenCalled();
    const payload = mockAuditLogCreate.mock.calls[0][0].data.payload as { marginReleased: boolean };
    expect(payload.marginReleased).toBe(false);
  });
});
