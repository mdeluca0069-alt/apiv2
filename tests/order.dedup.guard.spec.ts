/**
 * order.dedup.guard.spec.ts
 *
 * Milestone 1 / Fix #2 — proves the short-window duplicate-submission guard
 * itself (pure logic), and that OrderController.placeOrder() actually
 * consults it as the very first check, before any other rejection path,
 * so a rapid double-fire of an identical order (e.g. the OrderConfirmDialog
 * double-Enter bug) can never reach the execution pipeline twice.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildSubmissionKey,
  isDuplicateSubmission,
  _resetDedupGuardForTests,
} from "../trading-service/order.dedup.guard.js";

beforeEach(() => {
  _resetDedupGuardForTests();
});

describe("order.dedup.guard — pure logic", () => {
  it("allows the first submission through", () => {
    const key = buildSubmissionKey("user-1", { symbol: "EURUSD", side: "BUY", quantity: 1 });
    expect(isDuplicateSubmission(key, 1_000)).toBe(false);
  });

  it("rejects an identical submission within the dedup window", () => {
    const key = buildSubmissionKey("user-1", { symbol: "EURUSD", side: "BUY", quantity: 1 });
    expect(isDuplicateSubmission(key, 1_000)).toBe(false);
    expect(isDuplicateSubmission(key, 1_500)).toBe(true); // 500ms later, same key
  });

  it("allows a resubmission once the window has elapsed", () => {
    const key = buildSubmissionKey("user-1", { symbol: "EURUSD", side: "BUY", quantity: 1 });
    expect(isDuplicateSubmission(key, 1_000)).toBe(false);
    expect(isDuplicateSubmission(key, 5_000)).toBe(false); // 4s later — past the 3s window
  });

  it("treats different symbol/side/type/quantity/price as distinct keys", () => {
    const base = { symbol: "EURUSD", side: "BUY", quantity: 1 };
    const k1 = buildSubmissionKey("user-1", base);
    const k2 = buildSubmissionKey("user-1", { ...base, symbol: "GBPUSD" });
    const k3 = buildSubmissionKey("user-1", { ...base, side: "SELL" });
    const k4 = buildSubmissionKey("user-1", { ...base, quantity: 2 });
    const k5 = buildSubmissionKey("user-1", { ...base, price: 1.1 });
    const k6 = buildSubmissionKey("user-2", base); // different user entirely

    expect(isDuplicateSubmission(k1, 1_000)).toBe(false);
    expect(isDuplicateSubmission(k2, 1_001)).toBe(false);
    expect(isDuplicateSubmission(k3, 1_002)).toBe(false);
    expect(isDuplicateSubmission(k4, 1_003)).toBe(false);
    expect(isDuplicateSubmission(k5, 1_004)).toBe(false);
    expect(isDuplicateSubmission(k6, 1_005)).toBe(false);
  });
});

// ─── Integration: OrderController.placeOrder() consults the guard first ──────

const { mockQuoteGet } = vi.hoisted(() => ({ mockQuoteGet: vi.fn() }));

vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockQuoteGet },
}));

const { OrderController } = await import("../trading-service/order.controller.js");

describe("OrderController.placeOrder — duplicate-submission guard integration", () => {
  beforeEach(() => {
    _resetDedupGuardForTests();
    mockQuoteGet.mockReset();
    // No live quote for this made-up symbol — every call that gets past the
    // dedup guard hits the NO_LIVE_MARKET_DATA rejection, which is fine: it
    // proves the *specific* rejection reason on the second call is the
    // dedup guard's, not this one, i.e. the guard really did fire first.
    mockQuoteGet.mockReturnValue(undefined);
  });

  it("rejects an identical rapid-fire second request with DUPLICATE_SUBMISSION_WINDOW", async () => {
    const controller = new OrderController();
    const req = { symbol: "ZZZTEST", side: "BUY" as const, type: "MARKET" as const, quantity: 1, leverage: 1 };
    const ctx = { userId: "user-dedup-1", tenantId: "tenant-1" };

    const first  = await controller.placeOrder(req, ctx);
    const second = await controller.placeOrder(req, ctx);

    expect(first.status).toBe("REJECTED");
    expect(first.rejectionReason).toContain("NO_LIVE_MARKET_DATA");

    expect(second.status).toBe("REJECTED");
    expect(second.rejectionReason).toContain("DUPLICATE_SUBMISSION_WINDOW");
  });

  it("does not dedupe two different users placing the same-shaped order", async () => {
    const controller = new OrderController();
    const req = { symbol: "ZZZTEST", side: "BUY" as const, type: "MARKET" as const, quantity: 1, leverage: 1 };

    const a = await controller.placeOrder(req, { userId: "user-a", tenantId: "tenant-1" });
    const b = await controller.placeOrder(req, { userId: "user-b", tenantId: "tenant-1" });

    expect(a.rejectionReason).toContain("NO_LIVE_MARKET_DATA");
    expect(b.rejectionReason).toContain("NO_LIVE_MARKET_DATA"); // not deduped — different user
  });
});
