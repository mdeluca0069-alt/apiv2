/**
 * reconciliation.engine.orphan.margin.spec.ts
 *
 * FASE 5.1 (Ledger, Bug #2, LEDGER_FREEZE.md §0.2) — ReconciliationEngine's
 * repairOrphanMargin() is the system's own autonomous correction of a
 * client's wallet.locked -- it wrote only Ledger+Wallet (atomically) and a
 * Metrics increment after commit, with no AuditLog, no Notification, and no
 * Event Bus record at all. The self-correction mechanism was strictly LESS
 * traceable than an ordinary user-initiated action.
 *
 * Fix: the same transaction now also writes an AuditLog row (mirroring the
 * one branch in the codebase that already did this right --
 * recovery.service.ts's equivalent startup-time repair), and a successful
 * repair now emits a wallet.event (captured durably by the event archive)
 * and sends the affected user a notification.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockInc } = vi.hoisted(() => ({ mockInc: vi.fn() }));
vi.mock("../gateway/metrics.js", () => ({ metrics: { inc: mockInc, observe: vi.fn(), set: vi.fn(), get: vi.fn() } }));

const { mockSendAll } = vi.hoisted(() => ({ mockSendAll: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../notification-service/notification.router.js", () => ({
  notificationRouter: { sendAll: mockSendAll },
}));

vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { send: vi.fn(), auditConsumerFailure: vi.fn() },
}));

const { mockWalletUpdate, mockLedgerCreate, mockAuditLogCreate, mockAggregate, mockQueryRaw, mockTransaction } = vi.hoisted(() => ({
  mockWalletUpdate:  vi.fn(async () => ({})),
  mockLedgerCreate:  vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "ledger-1", ...args.data })),
  mockAuditLogCreate: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "audit-1", ...args.data })),
  mockAggregate:     vi.fn(),
  mockQueryRaw:      vi.fn(),
  mockTransaction:   vi.fn(),
}));

vi.mock("../shared/db.js", () => {
  const tx = {
    $queryRaw:            mockQueryRaw,
    walletAccount:        { update: mockWalletUpdate },
    position:             { aggregate: mockAggregate },
    ledgerEntry:           { create: mockLedgerCreate },
    auditLog:              { create: mockAuditLogCreate },
  };
  return {
    IS_PERSISTENT: true,
    prisma: { $transaction: mockTransaction, __tx: tx },
  };
});

const { eventBus } = await import("../events-bus/event.bus.js");
const emitSpy = vi.spyOn(eventBus, "emit");

const { reconciliationEngine } = await import("../settlement/reconciliation.engine.js");
const { prisma } = await import("../shared/db.js");

beforeEach(() => {
  vi.clearAllMocks();
  const tx = (prisma as unknown as { __tx: unknown }).__tx;
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
});

describe("ReconciliationEngine.repairOrphanMargin — Bug #2 fix", () => {
  it("writes an AuditLog row inside the same transaction as the Ledger/Wallet mutation", async () => {
    mockQueryRaw.mockResolvedValue([{ locked: "150.00" }]);
    mockAggregate.mockResolvedValue({ _sum: { marginUsed: new Decimal(100) } }); // orphan = 50

    const released = await reconciliationEngine.repairOrphanMargin("user-1");

    expect(released).toBeCloseTo(50, 2);
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const entry = mockAuditLogCreate.mock.calls[0][0].data as { action: string; entity: string; payload: { orphanAmount: number } };
    expect(entry.action).toBe("margin.orphan_released");
    expect(entry.entity).toBe("user-1");
    expect(entry.payload.orphanAmount).toBeCloseTo(50, 2);
    // Same transaction as the wallet/ledger writes -- proven by mockTransaction
    // having been invoked exactly once and all writes landing on the same tx.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockWalletUpdate).toHaveBeenCalledTimes(1);
    expect(mockLedgerCreate).toHaveBeenCalledTimes(1);
  });

  it("emits a wallet.event (durable event archive) and notifies the user after a successful repair", async () => {
    mockQueryRaw.mockResolvedValue([{ locked: "150.00" }]);
    mockAggregate.mockResolvedValue({ _sum: { marginUsed: new Decimal(100) } }); // orphan = 50

    await reconciliationEngine.repairOrphanMargin("user-1");

    expect(emitSpy).toHaveBeenCalledWith("wallet.event", expect.objectContaining({
      userId: "user-1", type: "MARGIN_RELEASE", amount: 50,
    }));
    expect(mockSendAll).toHaveBeenCalledTimes(1);
    expect(mockSendAll.mock.calls[0][0]).toBe("user-1");
    expect(mockSendAll.mock.calls[0][1]).toBe("margin");
  });

  it("increments the existing repair metric (unchanged behavior)", async () => {
    mockQueryRaw.mockResolvedValue([{ locked: "150.00" }]);
    mockAggregate.mockResolvedValue({ _sum: { marginUsed: new Decimal(100) } });

    await reconciliationEngine.repairOrphanMargin("user-1");

    expect(mockInc).toHaveBeenCalledWith("reconciliation_orphan_margin_repaired_total");
  });

  it("does nothing (no Audit/Notification/EventBus/Metrics) when there is no orphan margin to repair", async () => {
    mockQueryRaw.mockResolvedValue([{ locked: "100.00" }]);
    mockAggregate.mockResolvedValue({ _sum: { marginUsed: new Decimal(100) } }); // orphan = 0

    const released = await reconciliationEngine.repairOrphanMargin("user-1");

    expect(released).toBe(0);
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
    expect(mockWalletUpdate).not.toHaveBeenCalled();
    expect(mockLedgerCreate).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
    expect(mockSendAll).not.toHaveBeenCalled();
    expect(mockInc).not.toHaveBeenCalled();
  });

  it("does nothing when the wallet is a genuine deficit (negative orphan) -- never auto-repairs a deficit", async () => {
    mockQueryRaw.mockResolvedValue([{ locked: "50.00" }]);
    mockAggregate.mockResolvedValue({ _sum: { marginUsed: new Decimal(100) } }); // orphan = -50

    const released = await reconciliationEngine.repairOrphanMargin("user-1");

    expect(released).toBe(0);
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
    expect(mockWalletUpdate).not.toHaveBeenCalled();
  });
});
