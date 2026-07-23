/**
 * margin.controller.release.audit.spec.ts
 *
 * FASE 5.2 (Ledger, Bug #7, LEDGER_FREEZE.md §0.7) — MarginController.releaseMargin()
 * -- reached today only from execution.engine.ts's follow-up release of the
 * unused margin portion after a genuine partial fill -- wrote Ledger+Wallet
 * atomically but had no AuditLog and no Metrics on success at all; the only
 * metric that existed fired solely when every retry AND the fire-and-forget
 * repair both failed.
 *
 * Fix: the same transaction now also writes an AuditLog row, and a
 * successful release emits a wallet.event (captured durably by the event
 * archive, same mechanism proven in the FASE 5.1 fixes) and increments a
 * newly-registered `partial_fill_margin_released_total` counter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockMetricsInc } = vi.hoisted(() => ({ mockMetricsInc: vi.fn() }));
vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: mockMetricsInc, observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

const { mockQueryRaw, mockWalletUpdate, mockLedgerCreate, mockAuditLogCreate, mockTransaction } = vi.hoisted(() => ({
  mockQueryRaw:       vi.fn(),
  mockWalletUpdate:   vi.fn(async () => ({})),
  mockLedgerCreate:   vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "l-1", ...args.data })),
  mockAuditLogCreate: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "a-1", ...args.data })),
  mockTransaction:    vi.fn(),
}));

vi.mock("../shared/db.js", () => {
  const tx = {
    // margin.controller.ts's own row-lock SELECT (returns rows -- $queryRaw
    // is correct here). Separately, REALTIME_FREEZE.md Critical #2's
    // immutableAudit.write() uses $executeRaw for its advisory lock
    // (pg_advisory_xact_lock returns void, which $queryRaw cannot
    // deserialize) -- two distinct Prisma methods, neither asserted on by
    // call count/args in these tests.
    $queryRaw:     mockQueryRaw,
    $executeRaw:   vi.fn().mockResolvedValue(0),
    walletAccount: { update: mockWalletUpdate },
    ledgerEntry:   { create: mockLedgerCreate },
    auditLog:      { create: mockAuditLogCreate, findFirst: vi.fn().mockResolvedValue(null) },
  };
  return { IS_PERSISTENT: true, prisma: { $transaction: mockTransaction, __tx: tx } };
});

const { eventBus } = await import("../events-bus/event.bus.js");
const emitSpy = vi.spyOn(eventBus, "emit");

const { marginController } = await import("../risk-service/margin.controller.js");
const { prisma } = await import("../shared/db.js");

beforeEach(() => {
  vi.clearAllMocks();
  const tx = (prisma as unknown as { __tx: unknown }).__tx;
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
});

describe("MarginController.releaseMargin() — Bug #7 fix", () => {
  it("writes an AuditLog row inside the same transaction as the Ledger/Wallet mutation", async () => {
    mockQueryRaw.mockResolvedValue([{ locked: "500" }]);

    await marginController.releaseMargin("user-1", "position-1", 120);

    expect(mockWalletUpdate).toHaveBeenCalledTimes(1);
    expect(mockLedgerCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const entry = mockAuditLogCreate.mock.calls[0][0].data as { action: string; entity: string; payload: { released: number } };
    expect(entry.action).toBe("margin.released");
    expect(entry.entity).toBe("position-1");
    expect(entry.payload.released).toBe(120);
  });

  it("emits a wallet.event (durable event archive) and increments the success metric", async () => {
    mockQueryRaw.mockResolvedValue([{ locked: "500" }]);

    await marginController.releaseMargin("user-1", "position-1", 120);

    expect(emitSpy).toHaveBeenCalledWith("wallet.event", expect.objectContaining({
      userId: "user-1", type: "MARGIN_RELEASE", amount: 120, reference: "position-1",
    }));
    expect(mockMetricsInc).toHaveBeenCalledWith("partial_fill_margin_released_total");
  });

  it("does nothing (no Audit/EventBus/Metrics) when locked is already zero -- a genuine no-op", async () => {
    mockQueryRaw.mockResolvedValue([{ locked: "0" }]);

    await marginController.releaseMargin("user-1", "position-1", 120);

    expect(mockWalletUpdate).not.toHaveBeenCalled();
    expect(mockLedgerCreate).not.toHaveBeenCalled();
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
    expect(mockMetricsInc).not.toHaveBeenCalled();
  });

  it("floor-safe partial release still writes an accurate audit/metric for the amount actually released, not requested", async () => {
    mockQueryRaw.mockResolvedValue([{ locked: "50" }]); // less than the 120 requested

    await marginController.releaseMargin("user-1", "position-1", 120);

    const entry = mockAuditLogCreate.mock.calls[0][0].data as { payload: { requested: number; released: number } };
    expect(entry.payload.requested).toBe(120);
    expect(entry.payload.released).toBe(50);
    expect(emitSpy).toHaveBeenCalledWith("wallet.event", expect.objectContaining({ amount: 50 }));
  });
});
