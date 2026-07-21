/**
 * quote.isstale.propagation.spec.ts
 *
 * MARKET_DATA_FREEZE.md §0.7 — the shared Quote schema had no field
 * telling a consumer whether a price was actually live. The backend
 * already tracked staleness internally (InstrumentState.isStale,
 * quoteCache.isStale()) and used it to reject orders, but the WS
 * broadcast (main.ts's onBatch, fed by InternalLiquidityCore._tick() ->
 * _buildQuoteFromState()) and REST snapshots never surfaced it -- a
 * frontend client had no way to distinguish a live tick from a frozen
 * price with a freshly-regenerated timestamp.
 *
 * Proves Quote.isStale is populated correctly at every point a Quote
 * object is constructed: false on a real tick, false while ticks keep
 * arriving, and true once a symbol crosses the staleness threshold with
 * no new tick -- exactly the transition a WS client now receives on the
 * very next periodic broadcast.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InternalLiquidityCore } from "../liquidity-engine/internal.liquidity.core.js";

const STALE_THRESHOLD_MS = 360_000;

function makeCore(symbols: string[] = ["EURUSD"]) {
  return new InternalLiquidityCore({ symbols, tickMs: 60_000 });
}

describe("Quote.isStale propagation (MARKET_DATA_FREEZE.md §0.7)", () => {
  let core: InternalLiquidityCore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
    core = makeCore(["EURUSD"]);
  });

  afterEach(() => {
    core.stop();
    vi.useRealTimers();
  });

  it("a real tick produces isStale: false", () => {
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    const quote = core.tickSymbol("EURUSD");
    expect(quote).not.toBeNull();
    expect(quote!.isStale).toBe(false);
  });

  it("stays isStale: false across consecutive real ticks", () => {
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    vi.advanceTimersByTime(1_000);
    core.ingestExternalPrice("EURUSD", 1.1005, 1.1004, 1.1006);
    const quote = core.tickSymbol("EURUSD");
    expect(quote!.isStale).toBe(false);
  });

  it("flips to isStale: true once the feed goes silent past the threshold, on the very next broadcast tick", () => {
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    expect(core.tickSymbol("EURUSD")!.isStale).toBe(false);

    // No further real ticks -- simulate the periodic broadcast tick
    // (main.ts's onBatch/_tickAll -> _tick()) running well past the
    // staleness threshold with the feed silent.
    vi.advanceTimersByTime(STALE_THRESHOLD_MS + 1_000);
    const quote = core.tickSymbol("EURUSD");

    expect(quote).not.toBeNull();
    expect(quote!.isStale).toBe(true);
    expect(core.isStale("EURUSD")).toBe(true);
    // The price itself is still the last known value -- isStale is what
    // must warn the consumer, not a missing/null price.
    expect(quote!.mid).toBeGreaterThan(0);
  });

  it("flips back to isStale: false the instant a real tick resumes", () => {
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    vi.advanceTimersByTime(STALE_THRESHOLD_MS + 1_000);
    expect(core.tickSymbol("EURUSD")!.isStale).toBe(true);

    core.ingestExternalPrice("EURUSD", 1.1050, 1.1049, 1.1051);
    expect(core.tickSymbol("EURUSD")!.isStale).toBe(false);
  });
});
