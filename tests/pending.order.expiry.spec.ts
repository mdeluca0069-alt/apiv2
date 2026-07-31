/**
 * pending.order.expiry.spec.ts
 *
 * PHASE2_REMEDIATION (H1/H3) — the admin/architecture audit found that
 * PendingOrderExpiryService._scan() sourced its expiry candidates from
 * pendingOrderBook.getAll() (the leader worker's own local, per-process
 * Map), not the DB. Because pending orders are only synced into a worker's
 * local Map at boot (or now, incrementally via startSync()'s pub/sub —
 * itself best-effort), an order created on a DIFFERENT worker than the one
 * elected leader for this scan could be entirely invisible to it and would
 * never expire, no matter how long past its expiresAt.
 *
 * Fix: _scan() now calls pendingOrderBook.getExpiredFromSource(now)
 * instead, which queries the DB directly. This is the first test file for
 * pending.order.expiry.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTryLead, mockRelease } = vi.hoisted(() => ({
  mockTryLead: vi.fn().mockResolvedValue(true),
  mockRelease: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../realtime-infra/job.coordinator.js", () => ({
  jobCoordinator: { tryLead: mockTryLead, release: mockRelease },
}));

const { mockGetExpiredFromSource, mockMarkTriggered, mockGetAll } = vi.hoisted(() => ({
  mockGetExpiredFromSource: vi.fn().mockResolvedValue([]),
  mockMarkTriggered: vi.fn(),
  mockGetAll: vi.fn().mockReturnValue([]),
}));
vi.mock("../trading-service/pending.order.book.js", () => ({
  pendingOrderBook: {
    getExpiredFromSource: mockGetExpiredFromSource,
    markTriggered: mockMarkTriggered,
    getAll: mockGetAll,
  },
}));

const { mockTransition } = vi.hoisted(() => ({ mockTransition: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../trading-service/order.lifecycle.js", () => ({
  orderLifecycle: { transition: mockTransition },
}));

const { mockEmit } = vi.hoisted(() => ({ mockEmit: vi.fn() }));
vi.mock("../events-bus/event.bus.js", () => ({
  eventBus: { emit: mockEmit },
}));

// PHASE2_REMEDIATION (H2): _expireOrder() now releases the margin locked
// at placement time once an order is confirmed expired.
const { mockReleaseMargin } = vi.hoisted(() => ({ mockReleaseMargin: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../risk-service/margin.controller.js", () => ({
  marginController: { releaseMargin: mockReleaseMargin },
}));

const { pendingOrderExpiryService } = await import("../trading-service/pending.order.expiry.js");

function pendingOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pend-1", orderId: "ord-1", userId: "user-1", symbol: "EURUSD",
    side: "BUY", type: "LIMIT", quantity: 1, triggerPrice: 1.09, leverage: 30,
    marginRequired: 100, notional: 3000, status: "PENDING",
    createdAt: new Date(Date.now() - 3_600_000),
    expiresAt: new Date(Date.now() - 1000),
    armedByStopLimit: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTryLead.mockResolvedValue(true);
  mockRelease.mockResolvedValue(undefined);
  mockGetExpiredFromSource.mockResolvedValue([]);
  mockGetAll.mockReturnValue([]);
  mockTransition.mockResolvedValue(undefined);
  mockReleaseMargin.mockResolvedValue(undefined);
});

describe("PendingOrderExpiryService._scan() — PHASE2_REMEDIATION (H1/H3): DB-sourced, not local-Map-sourced", () => {
  it("sources expiry candidates from getExpiredFromSource(), never from getAll()", async () => {
    const order = pendingOrder();
    mockGetExpiredFromSource.mockResolvedValue([order]);
    mockMarkTriggered.mockResolvedValue(order);

    const result = await pendingOrderExpiryService.scanNow();

    expect(mockGetExpiredFromSource).toHaveBeenCalledTimes(1);
    expect(mockGetAll).not.toHaveBeenCalled();
    expect(result.expired).toBe(1);
  });

  it("expires an order that was NEVER in this (leader) worker's local Map -- the core cross-replica gap", async () => {
    // Simulates: this worker is the elected leader, but the order was
    // created on a different replica -- getAll() would return [] for it,
    // yet getExpiredFromSource() (DB-backed) finds it correctly.
    const remoteOrder = pendingOrder({ id: "remote-pend-1", orderId: "remote-ord-1" });
    mockGetExpiredFromSource.mockResolvedValue([remoteOrder]);
    mockMarkTriggered.mockResolvedValue(remoteOrder);

    const result = await pendingOrderExpiryService.scanNow();

    expect(result.expired).toBe(1);
    expect(result.errors).toBe(0);
    expect(mockMarkTriggered).toHaveBeenCalledWith("remote-pend-1");
    expect(mockTransition).toHaveBeenCalledWith("remote-ord-1", "CANCELLED", expect.any(String), "SYSTEM");
  });

  it("transitions an armed STOP_LIMIT leg to LIMIT_EXPIRED instead of CANCELLED", async () => {
    const order = pendingOrder({ armedByStopLimit: true });
    mockGetExpiredFromSource.mockResolvedValue([order]);
    mockMarkTriggered.mockResolvedValue(order);

    await pendingOrderExpiryService.scanNow();

    expect(mockTransition).toHaveBeenCalledWith("ord-1", "LIMIT_EXPIRED", expect.any(String), "SYSTEM");
  });

  it("is idempotent: markTriggered() returning null (already filled/cancelled elsewhere) skips the transition, no error", async () => {
    const order = pendingOrder();
    mockGetExpiredFromSource.mockResolvedValue([order]);
    mockMarkTriggered.mockResolvedValue(null); // e.g. a different replica already claimed it

    const result = await pendingOrderExpiryService.scanNow();

    expect(result.expired).toBe(1); // loop counted the attempt, but no transition happened
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it("only the elected leader scans -- tryLead()=false short-circuits without touching the DB", async () => {
    mockTryLead.mockResolvedValue(false);

    const result = await pendingOrderExpiryService.scanNow();

    expect(result).toEqual({ expired: 0, errors: 0 });
    expect(mockGetExpiredFromSource).not.toHaveBeenCalled();
  });

  it("counts a per-order failure without aborting the rest of the batch", async () => {
    const good = pendingOrder({ id: "good-1", orderId: "good-ord-1" });
    const bad  = pendingOrder({ id: "bad-1", orderId: "bad-ord-1" });
    mockGetExpiredFromSource.mockResolvedValue([bad, good]);
    mockMarkTriggered
      .mockImplementationOnce(() => { throw new Error("claim exploded"); })
      .mockImplementationOnce(async () => good);

    const result = await pendingOrderExpiryService.scanNow();

    expect(result.errors).toBe(1);
    expect(result.expired).toBe(1);
  });

  it("fails closed (empty candidate set, no throw) when getExpiredFromSource()'s own DB scan errors -- verified via its own tests; this only checks the lock is still released on a normal scan", async () => {
    mockGetExpiredFromSource.mockResolvedValue([]);

    await pendingOrderExpiryService.scanNow();

    expect(mockRelease).toHaveBeenCalledWith("pending-order-expiry");
  });

  it("releases the job lock even when an individual order's expiry throws", async () => {
    const order = pendingOrder();
    mockGetExpiredFromSource.mockResolvedValue([order]);
    mockMarkTriggered.mockImplementation(() => { throw new Error("claim exploded"); });

    await pendingOrderExpiryService.scanNow();

    expect(mockRelease).toHaveBeenCalledWith("pending-order-expiry");
  });
});

describe("PendingOrderExpiryService._expireOrder() — PHASE2_REMEDIATION (H2): releases margin locked at placement", () => {
  it("releases the claimed order's margin after a successful expiry claim", async () => {
    const order = pendingOrder({ marginRequired: 250 });
    mockGetExpiredFromSource.mockResolvedValue([order]);
    mockMarkTriggered.mockResolvedValue(order);

    await pendingOrderExpiryService.scanNow();

    expect(mockReleaseMargin).toHaveBeenCalledWith("user-1", "ord-1", 250);
  });

  it("does not release margin when the claim fails (already filled/cancelled elsewhere)", async () => {
    const order = pendingOrder();
    mockGetExpiredFromSource.mockResolvedValue([order]);
    mockMarkTriggered.mockResolvedValue(null);

    await pendingOrderExpiryService.scanNow();

    expect(mockReleaseMargin).not.toHaveBeenCalled();
  });

  it("still transitions the order to its terminal status even if the margin release itself fails", async () => {
    const order = pendingOrder();
    mockGetExpiredFromSource.mockResolvedValue([order]);
    mockMarkTriggered.mockResolvedValue(order);
    mockReleaseMargin.mockRejectedValue(new Error("wallet unreachable"));

    const result = await pendingOrderExpiryService.scanNow();

    expect(result.expired).toBe(1);
    expect(result.errors).toBe(0);
    expect(mockTransition).toHaveBeenCalledWith("ord-1", "CANCELLED", expect.any(String), "SYSTEM");
  });
});
