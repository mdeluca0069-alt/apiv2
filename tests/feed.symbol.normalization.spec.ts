/**
 * feed.symbol.normalization.spec.ts
 *
 * MARKET_DATA_FREEZE.md §0.2 — main.ts's ingestPrice callback used to pass
 * the RAW feed-format symbol (e.g. "EUR/USD" from TwelveData's WS feed)
 * straight to feedHealthMonitor.recordQuote(), while
 * liquidityCore.ingestExternalPrice() normalized internally via
 * normaliseSymbol() ("EUR/USD" -> "EURUSD"). feedHealthMonitor.start()
 * seeds its watched-symbol set from the already-clean SYMBOLS list
 * ("EURUSD"), so a quote recorded under "EUR/USD" was never found by any
 * isQuoteFresh()/quoteAgeMs() lookup for "EURUSD" -- a 100%-reproducible,
 * permanent false-stale report for exactly the WS-covered symbols (the
 * freshest, best-covered ones), feeding execution-scoring and the
 * platform-wide risk supervisor with wrong data.
 *
 * Fix: main.ts now calls normaliseSymbol(symbol) once, before handing the
 * key to EITHER feedHealthMonitor or liquidityCore. This test proves the
 * transformation itself is correct for the exact WS-format symbols
 * configured in production (TWELVEDATA_WS_SYMBOLS), and that a
 * FeedHealthMonitor instance seeded with the clean SYMBOLS list correctly
 * recognizes a quote recorded under the normalized key as fresh -- the
 * exact failure mode described above.
 */
import { describe, it, expect, afterEach } from "vitest";
import { normaliseSymbol } from "../liquidity-engine/internal.liquidity.core.js";
import { FeedHealthMonitor } from "../market-data/feed.health.monitor.js";

let activeMonitor: FeedHealthMonitor | null = null;
afterEach(() => {
  activeMonitor?.stop();
  activeMonitor = null;
});

describe("normaliseSymbol() — WS feed format matches the clean SYMBOLS format", () => {
  it.each([
    ["EUR/USD", "EURUSD"],
    ["XAU/USD", "XAUUSD"],
    ["BTC/USD", "BTCUSD"],
  ])("normalizes the production WS symbol %s to %s", (raw, expected) => {
    expect(normaliseSymbol(raw)).toBe(expected);
  });
});

describe("FeedHealthMonitor — symbol key consistency (MARKET_DATA_FREEZE.md §0.2)", () => {
  it("reports a WS-fed symbol as fresh when recordQuote() receives the normalized key (the fix)", () => {
    const monitor = activeMonitor = new FeedHealthMonitor();
    monitor.start(["EURUSD", "XAUUSD", "BTCUSD"]); // clean format, same as main.ts's SYMBOLS list

    // Simulate main.ts's fixed ingestPrice callback: normalize before recording.
    const rawWsSymbol = "EUR/USD";
    monitor.recordQuote(normaliseSymbol(rawWsSymbol), 1.0999, 1.1001, "feed-manager");

    expect(monitor.isQuoteFresh("EURUSD")).toBe(true);
    expect(monitor.quoteAgeMs("EURUSD")).toBeLessThan(1_000);
  });

  it("reproduces the pre-fix bug: recording under the RAW un-normalized key leaves the clean key permanently stale", () => {
    const monitor = activeMonitor = new FeedHealthMonitor();
    monitor.start(["EURUSD"]);

    // This is what main.ts used to do before the fix -- pass the raw symbol through unchanged.
    monitor.recordQuote("EUR/USD", 1.0999, 1.1001, "feed-manager");

    expect(monitor.isQuoteFresh("EURUSD")).toBe(false);
    expect(monitor.quoteAgeMs("EURUSD")).toBe(Infinity);
    // The stale-looking snapshot lists EURUSD even though a fresh tick just arrived --
    // under the wrong key. This is exactly the false "19 stale symbols" class of report.
    const snapshot = monitor.getSnapshot();
    expect(snapshot.staleSymbols).toContain("EURUSD");
    expect(snapshot.freshSymbols).not.toContain("EURUSD");
  });
});
