/**
 * market.data.metrics.spec.ts
 *
 * FASE 3.1 — Internal Liquidity Engine.
 *
 * Proves the periodic stale-symbol snapshot in initMarketDataMetrics()
 * actually reads feedHealthMonitor's real per-symbol data
 * (snapshot.qualityMetrics) instead of iterating the snapshot object's own
 * top-level keys as if they were [symbol, health] pairs — the bug that made
 * stale-symbol detection silently report 0 regardless of real feed state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetSnapshot } = vi.hoisted(() => ({ mockGetSnapshot: vi.fn() }));
vi.mock("../market-data/feed.health.monitor.js", () => ({
  feedHealthMonitor: { getSnapshot: mockGetSnapshot },
}));

const { mockMetrics } = vi.hoisted(() => ({
  mockMetrics: { inc: vi.fn(), incL: vi.fn(), set: vi.fn(), setL: vi.fn(), observeL: vi.fn() },
}));
vi.mock("../shared/metrics.js", () => ({ metrics: mockMetrics }));

function snapshotWith(qualityMetrics: Array<{ symbol: string; ageMs: number }>) {
  return {
    checkedAt: new Date().toISOString(),
    circuitOpen: false,
    staleSymbols: [],
    freshSymbols: [],
    totalSymbols: qualityMetrics.length,
    qualityMetrics,
    reconnectAudit: [],
    ordersBlocked: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("initMarketDataMetrics() — periodic stale-symbol snapshot", () => {
  it("reads snapshot.qualityMetrics (real per-symbol data), not Object.entries(snapshot)", async () => {
    mockGetSnapshot.mockReturnValue(snapshotWith([
      { symbol: "EURUSD", ageMs: 100 },   // fresh
      { symbol: "GBPUSD", ageMs: 8_000 }, // stale (>5000ms)
    ]));

    const { initMarketDataMetrics } = await import("../observability/market.data.metrics.js");
    initMarketDataMetrics();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockGetSnapshot).toHaveBeenCalled();
    expect(mockMetrics.setL).toHaveBeenCalledWith("igfx_market_stale_symbols", { symbol: "EURUSD" }, 0);
    expect(mockMetrics.setL).toHaveBeenCalledWith("igfx_market_stale_symbols", { symbol: "GBPUSD" }, 1);
    expect(mockMetrics.set).toHaveBeenCalledWith("igfx_market_stale_symbols", 1);
    expect(mockMetrics.set).toHaveBeenCalledWith("market_data_stale_symbols", 1);
  });

  it("treats ageMs:-1 (never received a quote) as stale, not as 0ms/fresh", async () => {
    mockGetSnapshot.mockReturnValue(snapshotWith([{ symbol: "USDJPY", ageMs: -1 }]));

    const { initMarketDataMetrics } = await import("../observability/market.data.metrics.js");
    initMarketDataMetrics();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockMetrics.setL).toHaveBeenCalledWith("igfx_market_stale_symbols", { symbol: "USDJPY" }, 1);
    expect(mockMetrics.set).toHaveBeenCalledWith("igfx_market_stale_symbols", 1);
  });

  it("reports 0 stale symbols when every symbol is fresh", async () => {
    mockGetSnapshot.mockReturnValue(snapshotWith([
      { symbol: "EURUSD", ageMs: 50 },
      { symbol: "GBPUSD", ageMs: 200 },
    ]));

    const { initMarketDataMetrics } = await import("../observability/market.data.metrics.js");
    initMarketDataMetrics();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockMetrics.set).toHaveBeenCalledWith("igfx_market_stale_symbols", 0);
  });
});
