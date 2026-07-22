/**
 * tick.source.priority.spec.ts
 *
 * MARKET_DATA_FREEZE.md §0.6 — ingestExternalPrice() had no timestamp or
 * source-priority guard on cache writes: despite feed.manager.ts's own
 * documented priority (TwelveData-WS PRIMARY, Binance-WS SECONDARY,
 * TwelveData-REST TERTIARY), the last tick to arrive at the server always
 * won, regardless of which feed produced it or how stale that feed's own
 * data was by the time it was fetched. A slower TwelveData-REST batch
 * response (reflecting data fetched up to REST_ROTATION_MS earlier) could
 * silently overwrite a fresher TwelveData-WS tick that landed moments
 * before it.
 *
 * Proves a lower-priority source's tick is discarded when a higher-
 * priority source ticked for the same symbol within SOURCE_PROTECTION_MS,
 * that priority protection expires after that window, that a
 * same-priority source is never blocked by itself, and that omitting
 * `source` entirely (every pre-existing call site/test) is treated as
 * top priority for full backward compatibility.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InternalLiquidityCore } from "../liquidity-engine/internal.liquidity.core.js";

function makeCore(symbols: string[] = ["EURUSD"]) {
  return new InternalLiquidityCore({ symbols, tickMs: 60_000 });
}

describe("InternalLiquidityCore.ingestExternalPrice() — source-priority ordering guard (MARKET_DATA_FREEZE.md §0.6)", () => {
  let core: InternalLiquidityCore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
  });

  afterEach(() => {
    core?.stop();
    vi.useRealTimers();
  });

  it("discards a twelvedata-rest tick that arrives moments after a twelvedata-ws tick for the same symbol", () => {
    core = makeCore(["EURUSD"]);
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001, "twelvedata-ws");

    vi.advanceTimersByTime(50); // REST response for older data lands 50ms later
    core.ingestExternalPrice("EURUSD", 1.0950, 1.0949, 1.0951, "twelvedata-rest");

    expect(core.tickSymbol("EURUSD")!.mid).toBeCloseTo(1.1000, 4); // WS price wins, REST discarded
  });

  it("accepts the REST tick once the WS protection window has expired", () => {
    core = makeCore(["EURUSD"]);
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001, "twelvedata-ws");

    vi.advanceTimersByTime(10_001); // past SOURCE_PROTECTION_MS -- WS feed may genuinely be gone
    core.ingestExternalPrice("EURUSD", 1.1020, 1.1019, 1.1021, "twelvedata-rest");

    expect(core.tickSymbol("EURUSD")!.mid).toBeCloseTo(1.1020, 4);
  });

  it("a same-priority source is never blocked by its own prior tick (binance-ws does not self-block)", () => {
    core = makeCore(["BTCUSD"]);
    core.ingestExternalPrice("BTCUSD", 60_000, 59_990, 60_010, "binance-ws");
    vi.advanceTimersByTime(50);
    core.ingestExternalPrice("BTCUSD", 60_050, 60_040, 60_060, "binance-ws");

    expect(core.tickSymbol("BTCUSD")!.mid).toBeCloseTo(60_050, 0);
  });

  it("twelvedata-ws and binance-ws are equal priority -- neither blocks the other", () => {
    core = makeCore(["BTCUSD"]);
    core.ingestExternalPrice("BTCUSD", 60_000, 59_990, 60_010, "twelvedata-ws");
    vi.advanceTimersByTime(50);
    core.ingestExternalPrice("BTCUSD", 60_100, 60_090, 60_110, "binance-ws");

    expect(core.tickSymbol("BTCUSD")!.mid).toBeCloseTo(60_100, 0);
  });

  it("omitting `source` entirely (every pre-existing call site) is treated as top priority, never self-blocked", () => {
    core = makeCore(["EURUSD"]);
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    vi.advanceTimersByTime(50);
    core.ingestExternalPrice("EURUSD", 1.1010, 1.1009, 1.1011);

    expect(core.tickSymbol("EURUSD")!.mid).toBeCloseTo(1.1010, 4);
  });

  it("a rejected outlier tick (sanity-bound §0.5) does not itself gain source-priority protection", () => {
    core = makeCore(["EURUSD"]);
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001, "twelvedata-rest");
    vi.advanceTimersByTime(50);
    // This WS tick is itself a 900% move -- rejected by the §0.5 sanity bound,
    // so it must not "protect" EURUSD at ws-priority for the next 10s.
    core.ingestExternalPrice("EURUSD", 11.0, 10.9, 11.1, "twelvedata-ws");
    vi.advanceTimersByTime(50);
    // A legitimate REST tick right after must still be accepted.
    core.ingestExternalPrice("EURUSD", 1.1010, 1.1009, 1.1011, "twelvedata-rest");

    expect(core.tickSymbol("EURUSD")!.mid).toBeCloseTo(1.1010, 4);
  });

  it("MARKET_DATA_FREEZE.md §0.10: a redis-relay tick is the lowest priority -- discarded when any local feed ticked recently", () => {
    core = makeCore(["EURUSD"]);
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001, "twelvedata-rest"); // even the lowest LOCAL priority...
    vi.advanceTimersByTime(50);
    core.ingestExternalPrice("EURUSD", 1.0500, 1.0499, 1.0501, "redis-relay"); // ...still beats a relayed tick

    expect(core.tickSymbol("EURUSD")!.mid).toBeCloseTo(1.1000, 4);
  });

  it("a redis-relay tick fills in data once no local feed has ticked recently", () => {
    core = makeCore(["EURUSD"]);
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001, "twelvedata-ws");
    vi.advanceTimersByTime(10_001); // past SOURCE_PROTECTION_MS -- local feed may be degraded

    core.ingestExternalPrice("EURUSD", 1.1020, 1.1019, 1.1021, "redis-relay");

    expect(core.tickSymbol("EURUSD")!.mid).toBeCloseTo(1.1020, 4);
  });

  it("a local feed tick always overrides a relayed one, even moments later", () => {
    core = makeCore(["EURUSD"]);
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001, "redis-relay");
    vi.advanceTimersByTime(50);
    core.ingestExternalPrice("EURUSD", 1.1030, 1.1029, 1.1031, "twelvedata-ws");

    expect(core.tickSymbol("EURUSD")!.mid).toBeCloseTo(1.1030, 4);
  });
});
