/**
 * tick.sanity.bound.spec.ts
 *
 * MARKET_DATA_FREEZE.md §0.5 — before this fix, the only validation any
 * tick received anywhere in the ingestion chain was `isFinite && > 0`. A
 * wild print (a decimal-point error, a corrupted feed message, "999999"
 * for EURUSD) would be written into quoteCache immediately and
 * unconditionally, visible to every downstream consumer, before
 * symbol.circuit.breaker.ts's async, order-blocking-only halt could ever
 * react.
 *
 * Proves InternalLiquidityCore.ingestExternalPrice() now rejects a tick
 * outright (state unchanged, quoteCache unchanged) when it deviates from
 * the last known real price beyond what's physically plausible for a
 * single tick, per asset class -- while never blocking a symbol's
 * legitimate first-ever tick (nothing real to compare against yet) or a
 * large-but-still-real move under the bound.
 */
import { describe, it, expect, afterEach } from "vitest";
import { InternalLiquidityCore } from "../liquidity-engine/internal.liquidity.core.js";
import { quoteCache } from "../market-data/quote.cache.js";

function makeCore(symbols: string[] = ["EURUSD"]) {
  return new InternalLiquidityCore({ symbols, tickMs: 60_000 });
}

describe("InternalLiquidityCore.ingestExternalPrice() — outlier sanity bound (MARKET_DATA_FREEZE.md §0.5)", () => {
  let core: InternalLiquidityCore;

  afterEach(() => {
    core?.stop();
  });

  it("rejects a wildly out-of-range print (the audit's exact EURUSD=999999 scenario)", () => {
    core = makeCore(["EURUSD"]);
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);

    core.ingestExternalPrice("EURUSD", 999999, 999998, 999999);

    const quote = core.tickSymbol("EURUSD");
    expect(quote!.mid).toBeCloseTo(1.1000, 4); // unchanged -- bad tick never applied
    expect(quoteCache.get("EURUSD")!.mid).toBeCloseTo(1.1000, 4);
  });

  it("rejects a single-tick move beyond the FX_MAJOR bound (5%)", () => {
    core = makeCore(["EURUSD"]);
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);

    core.ingestExternalPrice("EURUSD", 1.1000 * 1.08, 1.1000 * 1.08 - 0.0001, 1.1000 * 1.08 + 0.0001); // 8% move

    expect(core.tickSymbol("EURUSD")!.mid).toBeCloseTo(1.1000, 4);
  });

  it("accepts a large but under-the-bound move (4% for FX_MAJOR)", () => {
    core = makeCore(["EURUSD"]);
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);

    const newMid = 1.1000 * 1.04;
    core.ingestExternalPrice("EURUSD", newMid, newMid - 0.0001, newMid + 0.0001);

    expect(core.tickSymbol("EURUSD")!.mid).toBeCloseTo(newMid, 3);
  });

  it("never blocks a symbol's very first-ever tick, however far from the synthetic seed", () => {
    core = makeCore(["EURUSD"]);
    // BASE_PRICES seed for EURUSD is nowhere near this -- must still be accepted,
    // since hadExternal is false and there's no real previous price to compare to.
    core.ingestExternalPrice("EURUSD", 50.0, 49.99, 50.01);

    expect(core.tickSymbol("EURUSD")!.mid).toBeCloseTo(50.0, 1);
  });

  it("uses a much wider bound for CRYPTO than FX_MAJOR (30% vs 5%)", () => {
    core = makeCore(["BTCUSD"]);
    core.ingestExternalPrice("BTCUSD", 60_000, 59_990, 60_010);

    // 20% move -- would be rejected for FX_MAJOR (5% bound) but accepted for CRYPTO (30%).
    const newMid = 60_000 * 1.20;
    core.ingestExternalPrice("BTCUSD", newMid, newMid - 10, newMid + 10);

    expect(core.tickSymbol("BTCUSD")!.mid).toBeCloseTo(newMid, 0);
  });

  it("a rejected tick does not reach quoteCache, state.mid, or get treated as a reopen/recovery", () => {
    core = makeCore(["EURUSD"]);
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    const before = quoteCache.get("EURUSD");

    core.ingestExternalPrice("EURUSD", 1.1000 * 2, 1.1000 * 2 - 0.001, 1.1000 * 2 + 0.001); // 100% move

    const after = quoteCache.get("EURUSD");
    expect(after!.mid).toBe(before!.mid);
    expect(after!.ts).toBe(before!.ts); // no write at all -- not even a timestamp bump
  });
});
