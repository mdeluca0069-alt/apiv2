/**
 * feed.manager.primary.gating.spec.ts
 *
 * MULTI-REPLICA TWELVEDATA REMEDIATION — proves FeedManager.start() no
 * longer opens a TwelveData WS/REST connection unconditionally (scenario
 * 3: "followers do not open TwelveData WebSockets"), and that
 * startPrimary()/stopPrimary() correctly gate it.
 *
 * Mocks the two external feed classes so no real network connection is
 * ever attempted — this file asserts constructor/lifecycle-call counts,
 * not real WebSocket behavior (that remains covered by the existing feed
 * classes' own tests, untouched by this change).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const twelveDataInstances: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
const binanceInstances:    Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];

vi.mock("../market-data/feeds/twelvedata.feed.js", () => ({
  TwelveDataFeed: vi.fn().mockImplementation(() => {
    const instance = { start: vi.fn(), stop: vi.fn() };
    twelveDataInstances.push(instance);
    return instance;
  }),
}));

vi.mock("../market-data/feeds/binance.feed.js", () => ({
  BinanceFeed: vi.fn().mockImplementation(() => {
    const instance = { start: vi.fn(), stop: vi.fn() };
    binanceInstances.push(instance);
    return instance;
  }),
}));

vi.mock("../market-data/feeds/twelvedata.rest.js", () => ({
  fetchCurrentPrices: vi.fn().mockResolvedValue(new Map()),
}));

import { FeedManager } from "../market-data/feed.manager.js";

beforeEach(() => {
  vi.clearAllMocks();
  twelveDataInstances.length = 0;
  binanceInstances.length = 0;
});

function makeManager() {
  return new FeedManager({
    apiKey:  "test-key",
    symbols: ["EURUSD", "XAUUSD", "BTCUSD"],
    wsSymbols: ["EUR/USD", "XAU/USD", "BTC/USD"],
    ingestPrice: vi.fn(),
  });
}

describe("FeedManager.start() — secondary feed only, no TwelveData by default", () => {
  it("starts Binance-WS but does NOT start a TwelveData WS connection", () => {
    const manager = makeManager();
    manager.start();

    expect(binanceInstances).toHaveLength(1);
    expect(binanceInstances[0].start).toHaveBeenCalledTimes(1);
    expect(twelveDataInstances).toHaveLength(0);
    expect(manager.isPrimaryRunning()).toBe(false);

    manager.stop();
  });

  it("is idempotent — calling start() twice does not open a second Binance connection", () => {
    const manager = makeManager();
    manager.start();
    manager.start();

    expect(binanceInstances).toHaveLength(1);
    manager.stop();
  });
});

describe("FeedManager.startPrimary()/stopPrimary() — leader-gated TwelveData WS+REST", () => {
  it("startPrimary() opens exactly one TwelveData WS connection", () => {
    const manager = makeManager();
    manager.start();
    manager.startPrimary();

    expect(twelveDataInstances).toHaveLength(1);
    expect(twelveDataInstances[0].start).toHaveBeenCalledTimes(1);
    expect(manager.isPrimaryRunning()).toBe(true);

    manager.stop();
  });

  it("startPrimary() is idempotent — calling it twice does not open a second TwelveData connection", () => {
    const manager = makeManager();
    manager.start();
    manager.startPrimary();
    manager.startPrimary();

    expect(twelveDataInstances).toHaveLength(1);
    manager.stop();
  });

  it("stopPrimary() stops the TwelveData WS connection and flips isPrimaryRunning() to false", () => {
    const manager = makeManager();
    manager.start();
    manager.startPrimary();
    const feed = twelveDataInstances[0];

    manager.stopPrimary();

    expect(feed.stop).toHaveBeenCalledTimes(1);
    expect(manager.isPrimaryRunning()).toBe(false);

    manager.stop();
  });

  it("stopPrimary() when never started is a safe no-op", () => {
    const manager = makeManager();
    manager.start();

    expect(() => manager.stopPrimary()).not.toThrow();
    expect(manager.isPrimaryRunning()).toBe(false);

    manager.stop();
  });

  it("a full leadership cycle (become leader -> lose leadership -> become leader again) opens/closes exactly one TwelveData connection per cycle, Binance untouched throughout", () => {
    const manager = makeManager();
    manager.start();
    expect(binanceInstances).toHaveLength(1);

    manager.startPrimary(); // became leader
    expect(twelveDataInstances).toHaveLength(1);

    manager.stopPrimary();  // lost leadership
    expect(twelveDataInstances[0].stop).toHaveBeenCalledTimes(1);

    manager.startPrimary(); // became leader again (e.g. after a takeover)
    expect(twelveDataInstances).toHaveLength(2); // a fresh connection, not the stopped one reused
    expect(manager.isPrimaryRunning()).toBe(true);

    // Binance-WS was never touched by any of the leadership transitions above.
    expect(binanceInstances).toHaveLength(1);
    expect(binanceInstances[0].stop).not.toHaveBeenCalled();

    manager.stop();
  });

  it("manager.stop() also stops the primary feed if it was running (no leaked connection on full shutdown)", () => {
    const manager = makeManager();
    manager.start();
    manager.startPrimary();
    const feed = twelveDataInstances[0];

    manager.stop();

    expect(feed.stop).toHaveBeenCalledTimes(1);
    expect(manager.isPrimaryRunning()).toBe(false);
  });
});
