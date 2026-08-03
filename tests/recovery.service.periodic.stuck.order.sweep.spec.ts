/**
 * recovery.service.periodic.stuck.order.sweep.spec.ts
 *
 * PHASE E (failure-injection audit): RecoveryService.run() -- and its
 * stuck-order rejection sweep (RECEIVED/RISK_REVIEW/ACCEPTED orders older
 * than STUCK_ORDER_TTL_MS, with margin release for ACCEPTED ones) -- only
 * ever executed once, at process boot, before the server starts accepting
 * connections. That's the right cadence for the other four startup checks
 * (P&L recompute is a one-time catch-up; orphan margin already has its own
 * separate periodic sweep via reconciliationEngine.runFullWithRepair()
 * every 5 min in main.ts; orphan positions are flag-only), but an order can
 * get stuck mid-process too -- a caught-but-non-fatal exception, not a
 * crash -- and had no periodic path back to REJECTED with margin released
 * until the next deploy/restart happened to trigger another startup run.
 *
 * Fix: the stuck-order logic is extracted into its own
 * RecoveryService.sweepStuckOrders() method, independently callable (no
 * P&L recompute, no wallet/position aggregate scan, no reconciliation
 * sweep needed) -- run() calls it as step 4 exactly as before, and
 * main.ts now ALSO schedules it via a jobCoordinator-gated setInterval
 * every 2 minutes.
 *
 * Reuses recovery.service.stuck.order.audit.spec.ts's mocking scaffold.
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
  mockTransaction, mockPositionAggregate,
} = vi.hoisted(() => ({
  mockPositionFindMany:  vi.fn().mockResolvedValue([]),
  mockWalletFindMany:    vi.fn().mockResolvedValue([]),
  mockOrderFindMany:     vi.fn(),
  mockPositionFindFirst: vi.fn().mockResolvedValue(null),
  mockWalletFindUnique:  vi.fn(),
  mockWalletUpdate:      vi.fn(async () => ({})),
  mockLedgerCreate:      vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "l-1", ...args.data })),
  mockOrderUpdate:       vi.fn(async () => ({})),
  mockAuditLogCreate:    vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "a-1", ...args.data })),
  mockTransaction:       vi.fn(),
  mockPositionAggregate: vi.fn().mockResolvedValue({ _sum: { marginUsed: null } }),
}));

vi.mock("../shared/db.js", () => {
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
      position:      { findMany: mockPositionFindMany, findFirst: mockPositionFindFirst, aggregate: mockPositionAggregate, update: vi.fn() },
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
  id: "order-mid-process", userId: "user-1", status: "ACCEPTED" as const,
  marginRequired: new Decimal(150), createdAt: new Date(Date.now() - 10 * 60 * 1000),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPositionFindMany.mockResolvedValue([]);
  mockWalletFindMany.mockResolvedValue([]);
  mockPositionFindFirst.mockResolvedValue(null);
  mockRunFull.mockResolvedValue({ summary: "ok" });
  mockGetSuspendedUsers.mockReturnValue([]);
  mockPositionAggregate.mockResolvedValue({ _sum: { marginUsed: null } });
  const tx = (prisma as unknown as { __tx: unknown }).__tx;
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
});

describe("RecoveryService.sweepStuckOrders() — PHASE E: independently callable, periodic-safe", () => {
  it("rejects a stuck ACCEPTED order and releases its margin, exactly like run()'s step 4 used to inline", async () => {
    mockOrderFindMany.mockResolvedValue([STUCK_ORDER]);
    mockWalletFindUnique.mockResolvedValue({ locked: new Decimal(150) });

    const result = await recoveryService.sweepStuckOrders();

    expect(result.stuckOrdersRejected).toBe(1);
    expect(mockWalletUpdate).toHaveBeenCalledTimes(1);
    expect(mockLedgerCreate).toHaveBeenCalledTimes(1);
    expect(mockOrderUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "order-mid-process" },
      data: expect.objectContaining({ status: "REJECTED" }),
    }));
    const payload = mockAuditLogCreate.mock.calls[0][0].data.payload as { marginReleased: boolean };
    expect(payload.marginReleased).toBe(true);
  });

  it("does NOT touch P&L recompute, wallet-aggregate scan, or the reconciliation sweep -- genuinely standalone, safe to run on a tight interval", async () => {
    mockOrderFindMany.mockResolvedValue([]);

    await recoveryService.sweepStuckOrders();

    expect(mockPositionFindMany).not.toHaveBeenCalled();
    expect(mockWalletFindMany).not.toHaveBeenCalled();
    expect(mockPositionAggregate).not.toHaveBeenCalled();
    expect(mockRunFull).not.toHaveBeenCalled();
  });

  it("returns stuckOrdersRejected: 0 with no side effects when nothing is stuck", async () => {
    mockOrderFindMany.mockResolvedValue([]);

    const result = await recoveryService.sweepStuckOrders();

    expect(result).toEqual({ stuckOrdersRejected: 0 });
    expect(mockOrderUpdate).not.toHaveBeenCalled();
  });

  it("returns { stuckOrdersRejected: 0 } without querying the DB at all in sandbox/non-persistent mode", async () => {
    vi.resetModules();
    vi.doMock("../shared/db.js", () => ({ IS_PERSISTENT: false, prisma: null }));
    const { recoveryService: sandboxRecoveryService } = await import("../settlement/recovery.service.js");

    const result = await sandboxRecoveryService.sweepStuckOrders();

    expect(result).toEqual({ stuckOrdersRejected: 0 });
    expect(mockOrderFindMany).not.toHaveBeenCalled();
    vi.doUnmock("../shared/db.js");
  });

  it("run() still calls through to the same stuck-order handling via sweepStuckOrders() — no behavior change from the extraction", async () => {
    mockOrderFindMany.mockResolvedValue([STUCK_ORDER]);
    mockWalletFindUnique.mockResolvedValue({ locked: new Decimal(150) });

    const report = await recoveryService.run();

    expect(report?.stuckOrdersRejected).toBe(1);
    expect(mockWalletUpdate).toHaveBeenCalledTimes(1);
    expect(mockRunFull).toHaveBeenCalledTimes(1); // run()'s own step 5, unaffected by the extraction
  });
});
