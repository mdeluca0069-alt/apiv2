/**
 * pending.order.book.spec.ts
 *
 * Unit tests for PendingOrderBook — the in-memory + DB-backed store for
 * resting LIMIT, STOP, STOP_LIMIT and TRAILING_STOP orders.
 *
 * Isolation strategy:
 *   - IS_PERSISTENT = true so persistence paths execute (prisma mocked)
 *   - prisma.brokerSetting.upsert / findMany are vi.fn() — fully controllable
 *   - eventBus.emit is vi.fn() — captured for assertion
 *   - Each test cleans the book via markTriggered on all pending orders in afterEach
 *
 * Coverage:
 *   1. add() — creates order with correct fields, emits order.pending
 *   2. add() — persistence failure: removes from memory and throws
 *   3. add() — retries: succeeds on second attempt
 *   4. getAll() / getBySymbol() / getForUser() filtering
 *   5. cancel() — removes from book, emits order.cancelled
 *   6. cancel() — rejects wrong userId / missing order
 *   7. markTriggered() — idempotent: second call returns null
 *   8. updateTrailingStops() — BUY: peak rises, trigger adjusts down
 *   9. updateTrailingStops() — SELL: peak falls, trigger adjusts up
 *  10. updateTrailingStops() — non-trailing orders untouched
 *  11. updateTrailingStops() — only PENDING orders updated (TRIGGERED ignored)
 *  12. armedByStopLimit flag preserved after add()
 *  13. expiresAt preserved as Date after add()
 *  14. initialize() — expired orders in DB are skipped (not loaded)
 *  15. initialize() — valid PENDING rows loaded into memory
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mock declarations (vi.hoisted ensures they exist before vi.mock factory runs) ──

const { mockUpsert, mockFindMany, mockExecuteRaw, claimedKeys, emitSpy } = vi.hoisted(() => {
  const claimedKeys = new Set<string>();
  return {
    mockUpsert:  vi.fn().mockResolvedValue({ key: "", value: {} }),
    mockFindMany: vi.fn().mockResolvedValue([]),
    // CRITICAL_REMEDIATION (C6): markTriggered() now atomically claims the
    // persisted row via $executeRaw before committing TRIGGERED locally.
    // A real Postgres UPDATE ... WHERE value->>'status'='PENDING' only
    // ever lets ONE caller affect the row per key -- this mock reproduces
    // that same one-claim-per-key semantics (rather than always
    // succeeding) so tests can genuinely exercise "another replica/call
    // already claimed this order" without relying on real Postgres.
    mockExecuteRaw: vi.fn(async (_strings: TemplateStringsArray, key: string) => {
      if (claimedKeys.has(key)) return 0;
      claimedKeys.add(key);
      return 1;
    }),
    claimedKeys,
    emitSpy: vi.fn(),
  };
});

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    brokerSetting: {
      upsert:   mockUpsert,
      findMany: mockFindMany,
    },
    $executeRaw: mockExecuteRaw,
  },
}));

vi.mock("../events-bus/event.bus.js", () => ({
  eventBus: { emit: emitSpy, on: vi.fn() },
}));

// ── Import under test (after mocks are registered) ───────────────────────────

import { pendingOrderBook } from "../trading-service/pending.order.book.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function cleanBook(): Promise<void> {
  for (const order of pendingOrderBook.getAll()) {
    await pendingOrderBook.markTriggered(order.id);
  }
}

function makeOrder(
  overrides: Partial<{
    userId:           string;
    symbol:           string;
    side:             "BUY" | "SELL";
    type:             "LIMIT" | "STOP" | "STOP_LIMIT" | "TRAILING_STOP";
    quantity:         number;
    triggerPrice:     number;
    limitPrice?:      number;
    trailAmount?:     number;
    leverage:         number;
    marginRequired:   number;
    notional:         number;
    armedByStopLimit?: boolean;
    expiresAt?:       Date;
    ocoGroupId?:      string;
  }> = {},
) {
  return {
    orderId:        "ord-" + Math.random().toString(36).slice(2),
    userId:         "user-1",
    symbol:         "EURUSD",
    side:           "BUY" as const,
    type:           "LIMIT" as const,
    quantity:       1,
    triggerPrice:   1.0900,
    leverage:       30,
    marginRequired: 100,
    notional:       3000,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.clearAllMocks();
  mockUpsert.mockResolvedValue({ key: "", value: {} });
  mockFindMany.mockResolvedValue([]);
  claimedKeys.clear();
  await cleanBook();
});

afterEach(async () => {
  await cleanBook();
});

// ─── 1. add() — basic fields ──────────────────────────────────────────────────

describe("add()", () => {

  it("returns a PendingOrder with auto-generated id, status=PENDING, createdAt", async () => {
    const req = makeOrder({ symbol: "EURUSD", side: "BUY", type: "LIMIT", triggerPrice: 1.09 });
    const result = await pendingOrderBook.add(req);

    expect(result.id).toBeTruthy();
    expect(result.status).toBe("PENDING");
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.symbol).toBe("EURUSD");
    expect(result.side).toBe("BUY");
    expect(result.type).toBe("LIMIT");
    expect(result.triggerPrice).toBe(1.09);
    expect(result.leverage).toBe(30);
  });

  it("emits order.pending event with correct fields", async () => {
    const req = makeOrder({ symbol: "GBPUSD", type: "STOP", triggerPrice: 1.2500 });
    await pendingOrderBook.add(req);

    expect(emitSpy).toHaveBeenCalledWith(
      "order.pending",
      expect.objectContaining({
        orderId:      req.orderId,
        symbol:       "GBPUSD",
        type:         "STOP",
        triggerPrice: 1.2500,
      }),
    );
  });

  it("makes order retrievable via getAll() immediately after add", async () => {
    const req = makeOrder({ symbol: "EURUSD" });
    const pending = await pendingOrderBook.add(req);

    const all = pendingOrderBook.getAll();
    expect(all.some((o) => o.id === pending.id)).toBe(true);
  });

  it("preserves armedByStopLimit flag", async () => {
    const req = makeOrder({ type: "LIMIT", armedByStopLimit: true });
    const result = await pendingOrderBook.add(req);
    expect(result.armedByStopLimit).toBe(true);
  });

  it("preserves expiresAt as Date", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const req = makeOrder({ expiresAt });
    const result = await pendingOrderBook.add(req);
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it("calls prisma upsert to persist the order", async () => {
    const req = makeOrder();
    await pendingOrderBook.add(req);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].where.key).toMatch(/^pending_order:/);
  });

  it("TRAILING_STOP BUY: initialises peakPrice to -Infinity (starts low so any ask raises peak)", async () => {
    const req = makeOrder({ type: "TRAILING_STOP", side: "BUY", trailAmount: 0.0050 });
    const result = await pendingOrderBook.add(req);
    // BUY trailing: peak must start at -Infinity so the first ask becomes the initial peak
    expect(result.peakPrice).toBe(-Infinity);
  });

  it("TRAILING_STOP SELL: initialises peakPrice to +Infinity (starts high so any bid lowers peak)", async () => {
    const req = makeOrder({ type: "TRAILING_STOP", side: "SELL", trailAmount: 0.0050 });
    const result = await pendingOrderBook.add(req);
    // SELL trailing: peak must start at +Infinity so the first bid becomes the initial peak
    expect(result.peakPrice).toBe(Infinity);
  });

  it("STOP_LIMIT: stores limitPrice", async () => {
    const req = makeOrder({ type: "STOP_LIMIT", triggerPrice: 1.0950, limitPrice: 1.0960 });
    const result = await pendingOrderBook.add(req);
    expect(result.limitPrice).toBe(1.0960);
  });
});

// ─── NewOrderRequest.expiresAt → pendingOrderBook.add() threading (Task 13, Phase 2) ──
// order.controller.ts's _parkPendingOrder converts the optional ISO-string
// NewOrderRequest.expiresAt into the Date pendingOrderBook.add() expects.
// Mirrors that exact conversion expression — manual trading never sets this
// field, so the undefined branch must stay byte-for-byte unchanged.

describe("NewOrderRequest.expiresAt → PendingOrder.expiresAt conversion", () => {
  function convert(reqExpiresAt: string | undefined): Date | undefined {
    return reqExpiresAt ? new Date(reqExpiresAt) : undefined;
  }

  it("converts an ISO string expiresAt into a Date", () => {
    const iso = new Date(Date.now() + 15 * 60_000).toISOString();
    const result = convert(iso);
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe(iso);
  });

  it("stays undefined when the request omits expiresAt (manual trading, regression)", () => {
    expect(convert(undefined)).toBeUndefined();
  });

  it("an order placed through pendingOrderBook.add() with a converted expiresAt is retrievable and bounded", async () => {
    const iso = new Date(Date.now() + 15 * 60_000).toISOString();
    const req = makeOrder({ expiresAt: convert(iso) });
    const result = await pendingOrderBook.add(req);
    expect(result.expiresAt?.toISOString()).toBe(iso);
  });
});

// ─── 2. add() — persistence failure ──────────────────────────────────────────

describe("add() — persistence failure", () => {

  it("throws when all 3 persist attempts fail", async () => {
    mockUpsert
      .mockRejectedValueOnce(new Error("DB timeout 1"))
      .mockRejectedValueOnce(new Error("DB timeout 2"))
      .mockRejectedValueOnce(new Error("DB timeout 3"));

    const req = makeOrder();
    await expect(pendingOrderBook.add(req)).rejects.toThrow("PENDING_ORDER_PERSIST_FAILED");
  }, 10_000);

  it("removes order from memory when persistence fails", async () => {
    mockUpsert.mockRejectedValue(new Error("DB down"));

    const sizeBefore = pendingOrderBook.getAll().length;
    try { await pendingOrderBook.add(makeOrder()); } catch { /* expected */ }

    expect(pendingOrderBook.getAll().length).toBe(sizeBefore);
  }, 10_000);

  it("succeeds when third attempt works", async () => {
    mockUpsert
      .mockRejectedValueOnce(new Error("first fail"))
      .mockRejectedValueOnce(new Error("second fail"))
      .mockResolvedValueOnce({ key: "", value: {} }); // third succeeds

    const req = makeOrder();
    const result = await pendingOrderBook.add(req);

    expect(result.status).toBe("PENDING");
    expect(mockUpsert).toHaveBeenCalledTimes(3);
  }, 10_000);
});

// ─── 3. Filtering ─────────────────────────────────────────────────────────────

describe("getAll() / getBySymbol() / getForUser()", () => {

  it("getAll() returns only PENDING orders", async () => {
    const a = await pendingOrderBook.add(makeOrder({ symbol: "EURUSD" }));
    const b = await pendingOrderBook.add(makeOrder({ symbol: "GBPUSD" }));

    // Mark one as triggered (remove from PENDING)
    await pendingOrderBook.markTriggered(a.id);

    const all = pendingOrderBook.getAll();
    expect(all.some((o) => o.id === b.id)).toBe(true);
    expect(all.some((o) => o.id === a.id)).toBe(false);
  });

  it("getBySymbol() filters by symbol and PENDING only", async () => {
    await pendingOrderBook.add(makeOrder({ symbol: "EURUSD" }));
    await pendingOrderBook.add(makeOrder({ symbol: "GBPUSD" }));
    await pendingOrderBook.add(makeOrder({ symbol: "EURUSD" }));

    const eur = pendingOrderBook.getBySymbol("EURUSD");
    expect(eur.length).toBe(2);
    expect(eur.every((o) => o.symbol === "EURUSD")).toBe(true);
  });

  it("getForUser() filters by userId", async () => {
    await pendingOrderBook.add(makeOrder({ userId: "user-A", symbol: "EURUSD" }));
    await pendingOrderBook.add(makeOrder({ userId: "user-B", symbol: "EURUSD" }));
    await pendingOrderBook.add(makeOrder({ userId: "user-A", symbol: "GBPUSD" }));

    const userA = pendingOrderBook.getForUser("user-A");
    expect(userA.length).toBe(2);
    expect(userA.every((o) => o.userId === "user-A")).toBe(true);
  });

  it("getBySymbol() returns empty array for unknown symbol", () => {
    expect(pendingOrderBook.getBySymbol("XAUUSD")).toEqual([]);
  });

  it("getForUser() returns empty array for unknown user", () => {
    expect(pendingOrderBook.getForUser("nobody")).toEqual([]);
  });
});

// ─── 4. cancel() ─────────────────────────────────────────────────────────────

describe("cancel()", () => {

  it("removes order and returns true for correct userId", async () => {
    const order = await pendingOrderBook.add(makeOrder({ userId: "user-X" }));
    const result = await pendingOrderBook.cancel(order.id, "user-X");

    expect(result).toBe(true);
    expect(pendingOrderBook.getAll().some((o) => o.id === order.id)).toBe(false);
  });

  it("emits order.cancelled with reason CLIENT_CANCEL", async () => {
    const order = await pendingOrderBook.add(makeOrder({ userId: "user-Y", symbol: "EURUSD" }));
    vi.clearAllMocks(); // clear emit from add()

    await pendingOrderBook.cancel(order.id, "user-Y");

    expect(emitSpy).toHaveBeenCalledWith(
      "order.cancelled",
      expect.objectContaining({
        pendingId: order.id,
        userId:    "user-Y",
        reason:    "CLIENT_CANCEL",
      }),
    );
  });

  it("returns false when userId does not match (auth guard)", async () => {
    const order = await pendingOrderBook.add(makeOrder({ userId: "owner" }));
    const result = await pendingOrderBook.cancel(order.id, "attacker");

    expect(result).toBe(false);
    // Order still in book
    expect(pendingOrderBook.getAll().some((o) => o.id === order.id)).toBe(true);
  });

  it("returns false for non-existent pendingId", async () => {
    const result = await pendingOrderBook.cancel("does-not-exist", "user-1");
    expect(result).toBe(false);
  });

  it("returns false if order already triggered (status not PENDING)", async () => {
    const order = await pendingOrderBook.add(makeOrder({ userId: "user-Z" }));
    await pendingOrderBook.markTriggered(order.id); // status → TRIGGERED, deleted from map

    const result = await pendingOrderBook.cancel(order.id, "user-Z");
    expect(result).toBe(false);
  });
});

// ─── 5. markTriggered() ───────────────────────────────────────────────────────

describe("markTriggered()", () => {

  it("returns the removed PendingOrder on first call", async () => {
    const order = await pendingOrderBook.add(makeOrder());
    const removed = await pendingOrderBook.markTriggered(order.id);

    expect(removed).not.toBeNull();
    expect(removed!.id).toBe(order.id);
  });

  it("removes order from in-memory book", async () => {
    const order = await pendingOrderBook.add(makeOrder());
    await pendingOrderBook.markTriggered(order.id);

    expect(pendingOrderBook.getAll().some((o) => o.id === order.id)).toBe(false);
  });

  it("is idempotent: a second, later call for the same (now-removed) order returns null", async () => {
    const order = await pendingOrderBook.add(makeOrder());
    const first  = await pendingOrderBook.markTriggered(order.id);
    const second = await pendingOrderBook.markTriggered(order.id);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  // CRITICAL_REMEDIATION (C6): this is the direct regression test for the
  // cross-replica duplicate-fill bug. It fires three concurrent (not
  // sequentially awaited) markTriggered() calls for the SAME order id --
  // simulating three replicas whose watchers all observed the same price
  // tick and all still see the order as PENDING in their own local memory,
  // exactly as described in markTriggered()'s docstring. The stateful
  // mockExecuteRaw above reproduces Postgres's real row-level locking
  // semantics (only one UPDATE ... WHERE status='PENDING' can ever affect
  // the row), so this proves the claim -- not JS's single-threadedness --
  // is what makes exactly one caller win.
  it("CRITICAL_REMEDIATION (C6): three concurrent callers racing the same order -- exactly one wins, not JS execution order", async () => {
    const order = await pendingOrderBook.add(makeOrder());

    const [r1, r2, r3] = await Promise.all([
      pendingOrderBook.markTriggered(order.id),
      pendingOrderBook.markTriggered(order.id),
      pendingOrderBook.markTriggered(order.id),
    ]);

    const successes = [r1, r2, r3].filter((r) => r !== null);
    expect(successes.length).toBe(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(3);
  });

  it("returns null for non-existent id", async () => {
    expect(await pendingOrderBook.markTriggered("ghost")).toBeNull();
  });
});

// ─── 6. updateTrailingStops() ─────────────────────────────────────────────────

describe("updateTrailingStops()", () => {

  it("BUY trailing: peak rises when ask moves up", async () => {
    const order = await pendingOrderBook.add(
      makeOrder({ type: "TRAILING_STOP", side: "BUY", triggerPrice: 1.0900, trailAmount: 0.0100 }),
    );

    pendingOrderBook.updateTrailingStops("EURUSD", 1.1000, 1.1010);
    const updated = pendingOrderBook.getAll().find((o) => o.id === order.id)!;

    expect(updated.peakPrice).toBe(1.1010); // new peak = ask
    expect(updated.triggerPrice).toBeCloseTo(1.1010 - 0.0100, 4); // peak - trail
  });

  it("BUY trailing: peak does NOT fall when ask drops (trailing only upward)", async () => {
    const order = await pendingOrderBook.add(
      makeOrder({ type: "TRAILING_STOP", side: "BUY", triggerPrice: 1.0900, trailAmount: 0.0100 }),
    );
    // Push peak up first
    pendingOrderBook.updateTrailingStops("EURUSD", 1.1050, 1.1060);
    const afterUp = pendingOrderBook.getAll().find((o) => o.id === order.id)!;
    const peakAfterUp = afterUp.peakPrice!;

    // Now ask drops — peak should stay
    pendingOrderBook.updateTrailingStops("EURUSD", 1.0900, 1.0910);
    const afterDown = pendingOrderBook.getAll().find((o) => o.id === order.id)!;

    expect(afterDown.peakPrice).toBe(peakAfterUp);
    expect(afterDown.triggerPrice).toBeCloseTo(peakAfterUp - 0.0100, 4);
  });

  it("SELL trailing: peak falls when bid drops", async () => {
    const order = await pendingOrderBook.add(
      makeOrder({ type: "TRAILING_STOP", side: "SELL", triggerPrice: 1.0900, trailAmount: 0.0100 }),
    );

    pendingOrderBook.updateTrailingStops("EURUSD", 1.0800, 1.0810);
    const updated = pendingOrderBook.getAll().find((o) => o.id === order.id)!;

    expect(updated.peakPrice).toBe(1.0800); // new peak = bid
    expect(updated.triggerPrice).toBeCloseTo(1.0800 + 0.0100, 4); // peak + trail
  });

  it("SELL trailing: peak does NOT rise when bid rises", async () => {
    const order = await pendingOrderBook.add(
      makeOrder({ type: "TRAILING_STOP", side: "SELL", triggerPrice: 1.0900, trailAmount: 0.0100 }),
    );
    pendingOrderBook.updateTrailingStops("EURUSD", 1.0800, 1.0810); // drop to 1.0800
    const afterDrop = pendingOrderBook.getAll().find((o) => o.id === order.id)!;
    const peakAfterDrop = afterDrop.peakPrice!;

    pendingOrderBook.updateTrailingStops("EURUSD", 1.0900, 1.0910); // bid rises
    const afterRise = pendingOrderBook.getAll().find((o) => o.id === order.id)!;

    expect(afterRise.peakPrice).toBe(peakAfterDrop); // peak unchanged (we keep minimum)
  });

  it("non-trailing orders (LIMIT, STOP) are NOT updated", async () => {
    const limit = await pendingOrderBook.add(makeOrder({ type: "LIMIT",  triggerPrice: 1.0900 }));
    const stop  = await pendingOrderBook.add(makeOrder({ type: "STOP",   triggerPrice: 1.0900 }));

    pendingOrderBook.updateTrailingStops("EURUSD", 1.1000, 1.1010);

    const updatedLimit = pendingOrderBook.getAll().find((o) => o.id === limit.id)!;
    const updatedStop  = pendingOrderBook.getAll().find((o) => o.id === stop.id)!;

    expect(updatedLimit.triggerPrice).toBe(1.0900);
    expect(updatedStop.triggerPrice).toBe(1.0900);
  });

  it("only PENDING trailing orders are updated (not orders on different symbol)", async () => {
    const eur = await pendingOrderBook.add(
      makeOrder({ type: "TRAILING_STOP", side: "BUY", symbol: "EURUSD", triggerPrice: 1.0900, trailAmount: 0.0100 }),
    );
    const gbp = await pendingOrderBook.add(
      makeOrder({ type: "TRAILING_STOP", side: "BUY", symbol: "GBPUSD", triggerPrice: 1.2500, trailAmount: 0.0100 }),
    );

    pendingOrderBook.updateTrailingStops("EURUSD", 1.1000, 1.1010);

    const updatedEur = pendingOrderBook.getAll().find((o) => o.id === eur.id)!;
    const updatedGbp = pendingOrderBook.getAll().find((o) => o.id === gbp.id)!;

    expect(updatedEur.peakPrice).toBe(1.1010); // EURUSD updated
    expect(updatedGbp.triggerPrice).toBe(1.2500); // GBPUSD untouched
  });

  it("trailing stop does not update if no peak change occurred", async () => {
    const order = await pendingOrderBook.add(
      makeOrder({ type: "TRAILING_STOP", side: "BUY", triggerPrice: 1.0900, trailAmount: 0.0100 }),
    );
    pendingOrderBook.updateTrailingStops("EURUSD", 1.1050, 1.1060); // sets peak
    const callCount = mockUpsert.mock.calls.length;

    pendingOrderBook.updateTrailingStops("EURUSD", 1.0950, 1.0960); // ask < peak → no update
    const callCountAfter = mockUpsert.mock.calls.length;

    // No additional persist call because peak did not change
    expect(callCountAfter).toBe(callCount);

    // Clean up
    await pendingOrderBook.markTriggered(order.id);
  });
});

// ─── 8. OCO (One-Cancels-Other) cascade — FASE 3.6 ───────────────────────────
// Two orders sharing an ocoGroupId: whichever resolves first (client cancel
// OR trigger) cancels the other. Orders with no ocoGroupId (the overwhelming
// majority — existing coverage above) must be completely unaffected.

describe("OCO cascade", () => {

  it("cancel(): cancelling one leg also cancels its sibling", async () => {
    const groupId = "oco-group-1";
    const legA = await pendingOrderBook.add(makeOrder({ userId: "user-1", symbol: "EURUSD", ocoGroupId: groupId }));
    const legB = await pendingOrderBook.add(makeOrder({ userId: "user-1", symbol: "EURUSD", ocoGroupId: groupId }));

    const result = await pendingOrderBook.cancel(legA.id, "user-1");

    expect(result).toBe(true);
    expect(pendingOrderBook.getAll().some((o) => o.id === legA.id)).toBe(false);
    expect(pendingOrderBook.getAll().some((o) => o.id === legB.id)).toBe(false);
  });

  it("cancel(): sibling cancellation is emitted with reason OCO_SIBLING_CANCELLED", async () => {
    const groupId = "oco-group-2";
    const legA = await pendingOrderBook.add(makeOrder({ userId: "user-1", ocoGroupId: groupId }));
    const legB = await pendingOrderBook.add(makeOrder({ userId: "user-1", ocoGroupId: groupId }));
    vi.clearAllMocks();

    await pendingOrderBook.cancel(legA.id, "user-1");

    expect(emitSpy).toHaveBeenCalledWith(
      "order.cancelled",
      expect.objectContaining({ pendingId: legA.id, reason: "CLIENT_CANCEL" }),
    );
    expect(emitSpy).toHaveBeenCalledWith(
      "order.cancelled",
      expect.objectContaining({ pendingId: legB.id, reason: "OCO_SIBLING_CANCELLED" }),
    );
  });

  it("cancel(): an order with no ocoGroupId cancels alone (no sibling side-effects)", async () => {
    const solo  = await pendingOrderBook.add(makeOrder({ userId: "user-1", symbol: "EURUSD" }));
    const other = await pendingOrderBook.add(makeOrder({ userId: "user-1", symbol: "GBPUSD" }));

    await pendingOrderBook.cancel(solo.id, "user-1");

    expect(pendingOrderBook.getAll().some((o) => o.id === other.id)).toBe(true);
  });

  it("cancelOcoSiblingsOnTrigger(): cancels the sibling with reason OCO_SIBLING_TRIGGERED", async () => {
    const groupId = "oco-group-3";
    const legA = await pendingOrderBook.add(makeOrder({ userId: "user-1", ocoGroupId: groupId }));
    const legB = await pendingOrderBook.add(makeOrder({ userId: "user-1", ocoGroupId: groupId }));
    vi.clearAllMocks();

    // legA "triggers" — caller (order.trigger.watcher.ts) removes it via
    // markTriggered() first, then asks the book to cancel legA's sibling(s).
    await pendingOrderBook.markTriggered(legA.id);
    await pendingOrderBook.cancelOcoSiblingsOnTrigger(legA.id, groupId);

    expect(pendingOrderBook.getAll().some((o) => o.id === legB.id)).toBe(false);
    expect(emitSpy).toHaveBeenCalledWith(
      "order.cancelled",
      expect.objectContaining({ pendingId: legB.id, reason: "OCO_SIBLING_TRIGGERED" }),
    );
  });

  it("cancelOcoSiblingsOnTrigger(): no-op when ocoGroupId is undefined", async () => {
    const solo = await pendingOrderBook.add(makeOrder({ userId: "user-1" }));
    vi.clearAllMocks();

    await expect(pendingOrderBook.cancelOcoSiblingsOnTrigger(solo.id, undefined)).resolves.toBeUndefined();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("cancelOcoSiblingsOnTrigger(): no-op when the sibling already resolved (idempotent)", async () => {
    const groupId = "oco-group-4";
    const legA = await pendingOrderBook.add(makeOrder({ userId: "user-1", ocoGroupId: groupId }));
    const legB = await pendingOrderBook.add(makeOrder({ userId: "user-1", ocoGroupId: groupId }));

    // legB already cancelled independently (e.g. client cancelled it directly
    // a moment before legA's trigger tick was processed).
    await pendingOrderBook.cancel(legB.id, "user-1");
    vi.clearAllMocks();

    await pendingOrderBook.markTriggered(legA.id);
    await expect(pendingOrderBook.cancelOcoSiblingsOnTrigger(legA.id, groupId)).resolves.toBeUndefined();

    // No spurious second cancellation emitted for legB.
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("cancel(): does not cancel orders from a DIFFERENT ocoGroupId", async () => {
    const legA = await pendingOrderBook.add(makeOrder({ userId: "user-1", ocoGroupId: "group-X" }));
    const unrelated = await pendingOrderBook.add(makeOrder({ userId: "user-1", ocoGroupId: "group-Y" }));

    await pendingOrderBook.cancel(legA.id, "user-1");

    expect(pendingOrderBook.getAll().some((o) => o.id === unrelated.id)).toBe(true);
  });
});

// ─── 7. initialize() — startup loading ───────────────────────────────────────

describe("initialize()", () => {

  it("skip initialize when already initialized (idempotent)", async () => {
    // First call sets initialized=true and calls findMany
    await pendingOrderBook.initialize();
    mockFindMany.mockClear();

    // Second call should return early — findMany NOT called again
    await pendingOrderBook.initialize();
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
