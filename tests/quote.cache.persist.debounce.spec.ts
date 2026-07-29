/**
 * quote.cache.persist.debounce.spec.ts
 *
 * CRITICAL_REMEDIATION Phase 1, finding C8 (PRODUCTION_RISK_REGISTER.md /
 * CRITICAL_REMEDIATION_REPORT.md).
 *
 * Root cause: quoteCache.set() called the fire-and-forget DB persistence
 * helper on EVERY tick, from every replica independently, with no
 * debounce. Live-measured: ~93 writes/sec at idle against a table with 4
 * live rows, ~18M cumulative updates, individual upserts up to 7.7s, and
 * Postgres connection-pool exhaustion severe enough to make ordinary API
 * requests (registration, login, deposits) fail outright during Phase 1
 * remediation verification with a single test user and zero load-test
 * traffic running -- corroborated independently by three separate audit
 * passes (realtime, performance, infrastructure) in the prior due-
 * diligence phase.
 *
 * Fix: debounce persistence to at most once per symbol per
 * PERSIST_DEBOUNCE_MS (10s). The in-memory cache (the actual hot-path read
 * target for every order/margin/quote consumer) is still updated on every
 * single tick, unthrottled -- only the DB write, which exists solely to
 * warm the cache after a restart, is debounced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockUpsert, mockFindMany } = vi.hoisted(() => ({
  mockUpsert:   vi.fn().mockResolvedValue({}),
  mockFindMany: vi.fn().mockResolvedValue([]),
}));
vi.mock("../shared/db.js", () => ({
  prisma: { brokerSetting: { upsert: mockUpsert, findMany: mockFindMany } },
}));

const { mockEmit } = vi.hoisted(() => ({ mockEmit: vi.fn() }));
vi.mock("../events-bus/event.bus.js", () => ({ eventBus: { emit: mockEmit } }));

function makeQuote(symbol: string, mid: number) {
  return { symbol, bid: mid - 0.01, ask: mid + 0.01, mid, spread: 0.02, changePct: 0, ts: new Date().toISOString() };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CRITICAL_REMEDIATION (C8) — quote persistence is debounced per symbol", () => {
  it("persists on the first tick for a symbol", async () => {
    const { quoteCache } = await import("../market-data/quote.cache.js");
    quoteCache.set(makeQuote("EURUSD_C8A", 1.1));
    await vi.runAllTimersAsync();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it("does NOT persist again for the same symbol within the debounce window, even across many rapid ticks -- this is the exact 93-writes/sec-at-idle pattern that saturated Postgres live", async () => {
    const { quoteCache } = await import("../market-data/quote.cache.js");
    quoteCache.set(makeQuote("EURUSD_C8B", 1.1000));
    await vi.runAllTimersAsync();
    expect(mockUpsert).toHaveBeenCalledTimes(1);

    // Simulate a real feed: dozens of ticks in rapid succession, well within
    // the debounce window (advance only 1ms between each).
    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(1);
      quoteCache.set(makeQuote("EURUSD_C8B", 1.1000 + i * 0.0001));
    }
    await vi.runAllTimersAsync();

    // Still exactly 1 -- none of the 50 subsequent ticks triggered a write.
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    // But the in-memory cache -- the actual hot-path read target -- DID
    // update on every tick, unthrottled: the last tick's price is visible.
    expect(quoteCache.get("EURUSD_C8B")?.mid).toBeCloseTo(1.1000 + 49 * 0.0001, 6);
  });

  it("persists again once the debounce window has elapsed", async () => {
    const { quoteCache } = await import("../market-data/quote.cache.js");
    quoteCache.set(makeQuote("EURUSD_C8C", 1.1));
    await vi.runAllTimersAsync();
    expect(mockUpsert).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001); // just past PERSIST_DEBOUNCE_MS
    quoteCache.set(makeQuote("EURUSD_C8C", 1.2));
    await vi.runAllTimersAsync();

    expect(mockUpsert).toHaveBeenCalledTimes(2);
  });

  it("debounce windows are independent per symbol -- a burst across many symbols still writes once per symbol, not zero", async () => {
    const { quoteCache } = await import("../market-data/quote.cache.js");
    const symbols = Array.from({ length: 22 }, (_, i) => `SYM_C8D_${i}`);
    for (const s of symbols) quoteCache.set(makeQuote(s, 1.0));
    await vi.runAllTimersAsync();

    expect(mockUpsert).toHaveBeenCalledTimes(22);
  });

  it("a persistence failure is logged, not silently swallowed, and does not throw or block the caller", async () => {
    mockUpsert.mockRejectedValueOnce(new Error("connection pool exhausted"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { quoteCache } = await import("../market-data/quote.cache.js");

    expect(() => quoteCache.set(makeQuote("EURUSD_C8E", 1.1))).not.toThrow();
    await vi.runAllTimersAsync();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[quote-cache] persist failed"),
      expect.stringContaining("connection pool exhausted"),
    );
    warnSpy.mockRestore();
  });
});
