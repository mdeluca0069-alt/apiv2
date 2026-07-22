/**
 * quote.ts.reflects.last.tick.spec.ts
 *
 * MARKET_DATA_FREEZE.md §0.9 — _buildQuoteFromState() (called by the
 * periodic WS broadcast tick, _tick()/_tickAll(), roughly once per second
 * regardless of real tick activity) stamped `ts: now.toISOString()`
 * unconditionally -- even on the stale path, after state.isStale had
 * already been set. A client watching the WS broadcast saw a
 * fresh-looking timestamp every cycle for a symbol whose feed had been
 * dead for any length of time, right up until (and past) the point
 * quoteCache.isStale() started rejecting orders on it.
 *
 * Proves tickSymbol() (which calls _buildQuoteFromState() internally, the
 * same path the periodic broadcast uses) now returns a `ts` that reflects
 * the real last external tick time once one has happened -- not the
 * moment tickSymbol() itself was called -- so a consumer computing "age"
 * from ts directly (instead of only trusting the separate isStale field)
 * sees the truth too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InternalLiquidityCore } from "../liquidity-engine/internal.liquidity.core.js";

function makeCore(symbols: string[] = ["EURUSD"]) {
  return new InternalLiquidityCore({ symbols, tickMs: 60_000 });
}

describe("Quote.ts reflects the real last-tick time, not periodic-broadcast call time (MARKET_DATA_FREEZE.md §0.9)", () => {
  let core: InternalLiquidityCore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T00:00:00.000Z"));
    core = makeCore(["EURUSD"]);
  });

  afterEach(() => {
    core.stop();
    vi.useRealTimers();
  });

  it("ts matches the real tick time immediately after a real tick", () => {
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    const quote = core.tickSymbol("EURUSD");
    expect(quote!.ts).toBe(new Date("2026-07-22T00:00:00.000Z").toISOString());
  });

  it("ts does NOT advance on a periodic broadcast tick with no new real data -- stays pinned to the last real tick", () => {
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    const realTickTs = core.tickSymbol("EURUSD")!.ts;

    // Simulate 5 periodic broadcast cycles (main.ts's onBatch/_tickAll,
    // ~1/sec) passing with the feed silent -- this is exactly the call
    // pattern that used to regenerate a fresh-looking ts every time.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1_000);
      const quote = core.tickSymbol("EURUSD");
      expect(quote!.ts).toBe(realTickTs); // pinned -- never "now"
    }
  });

  it("ts stays pinned to the last real tick even once the symbol has gone stale", () => {
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    const realTickTs = core.tickSymbol("EURUSD")!.ts;

    vi.advanceTimersByTime(360_000 + 1_000); // past STALE_THRESHOLD_MS
    const staleQuote = core.tickSymbol("EURUSD");

    expect(staleQuote!.isStale).toBe(true);
    expect(staleQuote!.ts).toBe(realTickTs); // still the true last-tick time, not "now"
  });

  it("ts advances again the instant a new real tick arrives", () => {
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    vi.advanceTimersByTime(5_000);
    core.ingestExternalPrice("EURUSD", 1.1010, 1.1009, 1.1011);

    const quote = core.tickSymbol("EURUSD");
    expect(quote!.ts).toBe(new Date("2026-07-22T00:00:05.000Z").toISOString());
  });
});
