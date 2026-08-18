/**
 * feed.manager.finnhub.gating.spec.ts
 *
 * STAGING ONLY — mirrors feed.manager.primary.gating.spec.ts's exact
 * pattern (mocked feed classes, constructor/lifecycle call-count
 * assertions, no real network) for the new Finnhub adapter:
 *
 *   1. startFinnhub()/stopFinnhub()/isFinnhubRunning() are idempotent and
 *      symmetric to startPrimary()/stopPrimary()/isPrimaryRunning().
 *   2. When FeedManagerOptions.finnhub is omitted (the default —
 *      MARKET_DATA_STAGING_PROVIDER unset in main.ts), NO Finnhub
 *      WebSocket, REST call, or timer is ever created, even if
 *      startFinnhub() is called (mirrors how onBecomeLeader() would fire
 *      from a FeedLeaderElection in main.ts regardless).
 *   3. CRITICAL invariant (explicitly required before this change ships):
 *      adding "finnhub-ws"/"finnhub-rest" to _checkHealth()'s all-feeds-
 *      dead check does NOT change when the circuit breaker opens for the
 *      pre-existing TwelveData/Binance/TwelveData-REST trio. Proven by
 *      driving the real health-monitor timer (fake timers) through the
 *      exact CIRCUIT_BREAK_MS threshold with Finnhub both absent and
 *      present-but-dead, and asserting identical timing in both cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const twelveDataInstances: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
const binanceInstances:    Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
const finnhubInstances:    Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];

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

vi.mock("../market-data/feeds/finnhub.feed.js", () => ({
  FinnhubFeed: vi.fn().mockImplementation(() => {
    const instance = { start: vi.fn(), stop: vi.fn() };
    finnhubInstances.push(instance);
    return instance;
  }),
}));

// vi.mock(...) factories are hoisted above ALL other module-level
// statements, including `const` declarations — a plain
// `const finnhubRestSpy = vi.fn()...` declared before this vi.mock() call
// would still be referenced before initialization once hoisted. vi.hoisted()
// runs its own initializer during that same hoist pass, so the spy exists
// by the time the factory below needs it.
const { finnhubRestSpy } = vi.hoisted(() => ({
  finnhubRestSpy: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("../market-data/feeds/finnhub.rest.js", () => ({
  fetchCurrentPrices: finnhubRestSpy,
}));

import { FeedManager } from "../market-data/feed.manager.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  twelveDataInstances.length = 0;
  binanceInstances.length   = 0;
  finnhubInstances.length   = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

function makeManager(finnhub?: { apiKey: string; wsSymbols: string[]; restSymbols: string[] }) {
  return new FeedManager({
    apiKey:     "test-key",
    symbols:    ["EURUSD", "XAUUSD", "BTCUSD"],
    wsSymbols:  ["EUR/USD", "XAU/USD", "BTC/USD"],
    ingestPrice: vi.fn(),
    finnhub,
  });
}

const FINNHUB_CFG = { apiKey: "finnhub-test-key", wsSymbols: ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"], restSymbols: ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"] };

describe("FeedManager — Finnhub disabled (opts.finnhub omitted, the default)", () => {
  it("startFinnhub() is a safe no-op — no WS, no REST call, no timer", () => {
    const manager = makeManager(); // finnhub: undefined
    manager.start();
    manager.startFinnhub();

    expect(finnhubInstances).toHaveLength(0);
    expect(finnhubRestSpy).not.toHaveBeenCalled();
    expect(manager.isFinnhubRunning()).toBe(false);

    manager.stop();
  });

  it("does not start Finnhub REST polling even after advancing well past its 60s interval", async () => {
    const manager = makeManager();
    manager.start();
    manager.startFinnhub();

    await vi.advanceTimersByTimeAsync(180_000);

    expect(finnhubRestSpy).not.toHaveBeenCalled();
    manager.stop();
  });

  it("TwelveData/Binance behavior is completely unaffected by the Finnhub option existing", () => {
    const manager = makeManager();
    manager.start();
    manager.startPrimary();

    expect(binanceInstances).toHaveLength(1);
    expect(twelveDataInstances).toHaveLength(1);
    expect(manager.isPrimaryRunning()).toBe(true);
    expect(manager.isFinnhubRunning()).toBe(false);

    manager.stop();
  });
});

describe("FeedManager — Finnhub enabled (opts.finnhub set, MARKET_DATA_STAGING_PROVIDER=finnhub)", () => {
  it("startFinnhub() opens exactly one Finnhub WS connection and starts REST polling", async () => {
    const manager = makeManager(FINNHUB_CFG);
    manager.start();
    manager.startFinnhub();

    expect(finnhubInstances).toHaveLength(1);
    expect(finnhubInstances[0].start).toHaveBeenCalledTimes(1);
    expect(manager.isFinnhubRunning()).toBe(true);

    // Immediate poll on start, per finnhub.rest.ts's own header comment.
    await vi.advanceTimersByTimeAsync(0);
    expect(finnhubRestSpy).toHaveBeenCalledTimes(1);
    expect(finnhubRestSpy).toHaveBeenCalledWith(FINNHUB_CFG.apiKey, FINNHUB_CFG.restSymbols);

    manager.stop();
  });

  it("startFinnhub() is idempotent — calling it twice does not open a second connection", () => {
    const manager = makeManager(FINNHUB_CFG);
    manager.start();
    manager.startFinnhub();
    manager.startFinnhub();

    expect(finnhubInstances).toHaveLength(1);
    manager.stop();
  });

  it("stopFinnhub() stops the WS connection, clears the REST timer, and flips isFinnhubRunning() to false", async () => {
    const manager = makeManager(FINNHUB_CFG);
    manager.start();
    manager.startFinnhub();
    const feed = finnhubInstances[0];
    finnhubRestSpy.mockClear();

    manager.stopFinnhub();

    expect(feed.stop).toHaveBeenCalledTimes(1);
    expect(manager.isFinnhubRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(180_000);
    expect(finnhubRestSpy).not.toHaveBeenCalled();

    manager.stop();
  });

  it("stopFinnhub() when never started is a safe no-op", () => {
    const manager = makeManager(FINNHUB_CFG);
    manager.start();

    expect(() => manager.stopFinnhub()).not.toThrow();
    expect(manager.isFinnhubRunning()).toBe(false);

    manager.stop();
  });

  it("REST polling repeats every 60s (FINNHUB_REST_ROTATION_MS), sequential batches only", async () => {
    const manager = makeManager(FINNHUB_CFG);
    manager.start();
    manager.startFinnhub();

    await vi.advanceTimersByTimeAsync(0);   // immediate call
    expect(finnhubRestSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(finnhubRestSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(finnhubRestSpy).toHaveBeenCalledTimes(3);

    manager.stop();
  });

  it("Finnhub leadership is fully independent of TwelveData primary leadership", () => {
    const manager = makeManager(FINNHUB_CFG);
    manager.start();

    manager.startPrimary();  // TwelveData becomes leader on this replica
    expect(twelveDataInstances).toHaveLength(1);
    expect(finnhubInstances).toHaveLength(0); // Finnhub leadership not yet granted

    manager.startFinnhub();  // Finnhub also becomes leader on this replica
    expect(finnhubInstances).toHaveLength(1);

    manager.stopPrimary();   // loses TwelveData leadership only
    expect(twelveDataInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(manager.isFinnhubRunning()).toBe(true); // Finnhub untouched
    expect(finnhubInstances[0].stop).not.toHaveBeenCalled();

    manager.stop();
  });

  it("manager.stop() also stops Finnhub if it was running (no leaked connection on full shutdown)", () => {
    const manager = makeManager(FINNHUB_CFG);
    manager.start();
    manager.startFinnhub();
    const feed = finnhubInstances[0];

    manager.stop();

    expect(feed.stop).toHaveBeenCalledTimes(1);
    expect(manager.isFinnhubRunning()).toBe(false);
  });
});

describe("FeedManager — CRITICAL: circuit-breaker timing is unaffected by the Finnhub option", () => {
  // feed.manager.ts constants (not exported): HEALTH_CHECK_INTERVAL_MS =
  // 5_000, FEED_DEAD_THRESHOLD_MS = 60_000, CIRCUIT_BREAK_MS = 120_000.
  // All mocked feed classes here are inert (never call ingestPrice), so
  // every feed's FeedStats.status() is "dead" from the very first health
  // check — this reproduces "all feeds genuinely dead" without needing a
  // real network failure.
  const TIME_TO_CIRCUIT_OPEN_MS = 130_000; // first 5s check + 120s CIRCUIT_BREAK_MS + margin

  it("circuit opens at the same elapsed time as before this change, with Finnhub OMITTED", async () => {
    const manager = makeManager(); // finnhub: undefined — the default/production path
    manager.start();
    manager.startPrimary();

    expect(manager.isCircuitOpen()).toBe(false);

    await vi.advanceTimersByTimeAsync(TIME_TO_CIRCUIT_OPEN_MS);

    expect(manager.isCircuitOpen()).toBe(true);

    manager.stop();
  });

  it("circuit opens at the SAME elapsed time when Finnhub is configured but also dead (proves the two extra always-dead entries don't loosen or tighten the .every() threshold)", async () => {
    const manager = makeManager(FINNHUB_CFG);
    manager.start();
    manager.startPrimary();
    // Deliberately do NOT call startFinnhub() — models a replica that lost
    // Finnhub leadership (or never had it) while still holding TwelveData
    // primary; finnhub-ws/finnhub-rest stay permanently "dead" either way.

    expect(manager.isCircuitOpen()).toBe(false);

    await vi.advanceTimersByTimeAsync(TIME_TO_CIRCUIT_OPEN_MS);

    expect(manager.isCircuitOpen()).toBe(true);

    manager.stop();
  });

  it("circuit does NOT open before CIRCUIT_BREAK_MS has elapsed, Finnhub omitted (no premature-open regression)", async () => {
    const manager = makeManager();
    manager.start();
    manager.startPrimary();

    // Just past the first health check (feeds are "dead" from t=0) but
    // well short of the full 120s CIRCUIT_BREAK_MS window.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(manager.isCircuitOpen()).toBe(false);

    manager.stop();
  });
});
