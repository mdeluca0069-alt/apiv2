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
    // margin.controller.ts's own row-lock SELECT AND immutableAudit.write()'s
    // _getChainHead() lookup both go through $queryRaw now -- routed by
    // setLockedAmount()'s SQL-text-aware mockImplementation below.
    // $executeRaw backs immutableAudit.write()'s advisory lock
    // (pg_advisory_xact_lock returns void, which $queryRaw cannot
    // deserialize) -- a distinct Prisma method, not asserted on by call
    // count/args in these tests.
    $queryRaw:     mockQueryRaw,
    $executeRaw:   vi.fn().mockResolvedValue(0),
    walletAccount: { update: mockWalletUpdate },
    ledgerEntry:   { create: mockLedgerCreate },
    auditLog:      { create: mockAuditLogCreate },
  };
  return { IS_PERSISTENT: true, prisma: { $transaction: mockTransaction, __tx: tx } };
});

const { eventBus } = await import("../events-bus/event.bus.js");
const emitSpy = vi.spyOn(eventBus, "emit");

const { marginController } = await import("../risk-service/margin.controller.js");
const { prisma } = await import("../shared/db.js");

// FASE 7 CLOSURE, Phase C: mockQueryRaw is shared between two DISTINCT raw
// queries now -- margin.controller.ts's own row-lock SELECT (returns
// `{ locked }` rows) and immutableAudit.write()'s _getChainHead() lookup
// (returns `{ payload }` rows, ordered by the _written_at JSON path since
// Prisma's typed orderBy can't express it). A blanket mockResolvedValue
// would make _getChainHead() receive `{ locked }` rows and crash reading
// `.payload` off them. Routes by inspecting the tagged template's SQL text.
function setLockedAmount(locked: string): void {
  mockQueryRaw.mockImplementation((strings: TemplateStringsArray) =>
    strings.join("").includes("AuditLog") ? Promise.resolve([]) : Promise.resolve([{ locked }]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  const tx = (prisma as unknown as { __tx: unknown }).__tx;
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
});

describe("MarginController.releaseMargin() — Bug #7 fix", () => {
  it("writes an AuditLog row inside the same transaction as the Ledger/Wallet mutation", async () => {
    setLockedAmount("500");

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
    setLockedAmount("500");

    await marginController.releaseMargin("user-1", "position-1", 120);

    expect(emitSpy).toHaveBeenCalledWith("wallet.event", expect.objectContaining({
      userId: "user-1", type: "MARGIN_RELEASE", amount: 120, reference: "position-1",
    }));
    expect(mockMetricsInc).toHaveBeenCalledWith("partial_fill_margin_released_total");
  });

  it("does nothing (no Audit/EventBus/Metrics) when locked is already zero -- a genuine no-op", async () => {
    setLockedAmount("0");

    await marginController.releaseMargin("user-1", "position-1", 120);

    expect(mockWalletUpdate).not.toHaveBeenCalled();
    expect(mockLedgerCreate).not.toHaveBeenCalled();
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
    expect(mockMetricsInc).not.toHaveBeenCalled();
  });

  it("floor-safe partial release still writes an accurate audit/metric for the amount actually released, not requested", async () => {
    setLockedAmount("50"); // less than the 120 requested

    await marginController.releaseMargin("user-1", "position-1", 120);

    const entry = mockAuditLogCreate.mock.calls[0][0].data as { payload: { requested: number; released: number } };
    expect(entry.payload.requested).toBe(120);
    expect(entry.payload.released).toBe(50);
    expect(emitSpy).toHaveBeenCalledWith("wallet.event", expect.objectContaining({ amount: 50 }));
  });
});

describe("MarginController.releaseMargin() — PHASE2_REMEDIATION (H2): composable `db` param", () => {
  // PHASE2_REMEDIATION (H2): execution.engine.ts's resting-order fill
  // true-up needs to release the placement-time estimate and lock the real
  // fill-price amount in ONE transaction, so a failure partway through
  // rolls back both -- the same composability contract checkAndLockMargin()
  // already had. Mirrors that method's own `db` tests in spirit: when `db`
  // is supplied, no new prisma.$transaction is opened.
  it("uses the supplied tx directly instead of opening prisma.$transaction", async () => {
    setLockedAmount("500");
    const tx = (prisma as unknown as { __tx: unknown }).__tx;

    await marginController.releaseMargin("user-1", "order-1", 120, tx as never);

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockWalletUpdate).toHaveBeenCalledTimes(1);
    expect(mockLedgerCreate).toHaveBeenCalledTimes(1);
  });

  it("still writes the AuditLog row atomically inside the composed tx", async () => {
    setLockedAmount("500");
    const tx = (prisma as unknown as { __tx: unknown }).__tx;

    await marginController.releaseMargin("user-1", "order-1", 120, tx as never);

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const entry = mockAuditLogCreate.mock.calls[0][0].data as { action: string; entity: string };
    expect(entry.action).toBe("margin.released");
    expect(entry.entity).toBe("order-1");
  });

  it("defers the metric/event emission to the caller -- the composed transaction hasn't committed yet", async () => {
    setLockedAmount("500");
    const tx = (prisma as unknown as { __tx: unknown }).__tx;

    await marginController.releaseMargin("user-1", "order-1", 120, tx as never);

    expect(emitSpy).not.toHaveBeenCalled();
    expect(mockMetricsInc).not.toHaveBeenCalled();
  });
});
