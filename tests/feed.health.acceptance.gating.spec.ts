/**
 * feed.health.acceptance.gating.spec.ts
 *
 * MARKET_DATA_FREEZE.md §0.8 — main.ts's ingestPrice callback used to call
 * feedHealthMonitor.recordQuote() BEFORE liquidityCore.ingestExternalPrice()
 * had validated the tick at all. A tick ingestExternalPrice went on to
 * reject (invalid input, a §0.5 sanity-bound outlier, a §0.6 lower-priority
 * source) could still be recorded as a fresh, healthy quote by the health
 * monitor -- with garbage bid=0/ask=0 whenever bid/ask were undefined.
 * Freshness and spread-quality metrics could diverge from quoteCache's
 * actual content.
 *
 * ingestExternalPrice() now returns true/false (accepted/rejected). This
 * test reproduces main.ts's ingestPrice closure pattern directly --
 * feedHealthMonitor.recordQuote() called only when ingestExternalPrice()
 * returns true -- using real (non-mocked) InternalLiquidityCore and
 * FeedHealthMonitor instances, and proves a rejected tick is never
 * recorded as fresh.
 */
import { describe, it, expect, afterEach } from "vitest";
import { InternalLiquidityCore } from "../liquidity-engine/internal.liquidity.core.js";
import { FeedHealthMonitor } from "../market-data/feed.health.monitor.js";

/** Mirrors main.ts's ingestPrice closure: only record health on acceptance. */
function ingest(
  core: InternalLiquidityCore,
  monitor: FeedHealthMonitor,
  symbol: string,
  mid: number,
  bid?: number,
  ask?: number,
  source?: string,
): boolean {
  const accepted = core.ingestExternalPrice(symbol, mid, bid, ask, source);
  if (accepted) monitor.recordQuote(symbol, bid ?? 0, ask ?? 0, "feed-manager");
  return accepted;
}

describe("feedHealthMonitor only records a tick ingestExternalPrice actually accepted (MARKET_DATA_FREEZE.md §0.8)", () => {
  let core: InternalLiquidityCore;
  let monitor: FeedHealthMonitor;

  afterEach(() => {
    core?.stop();
    monitor?.stop();
  });

  it("does not record a sanity-bound-rejected outlier tick as fresh", () => {
    core    = new InternalLiquidityCore({ symbols: ["EURUSD"], tickMs: 60_000 });
    monitor = new FeedHealthMonitor();
    monitor.start(["EURUSD"]);

    expect(ingest(core, monitor, "EURUSD", 1.1000, 1.0999, 1.1001)).toBe(true);
    expect(monitor.isQuoteFresh("EURUSD")).toBe(true);

    monitor.getSnapshot(); // establish baseline, no assertion needed here

    // A 900% move -- rejected by ingestExternalPrice()'s §0.5 sanity bound.
    const accepted = ingest(core, monitor, "EURUSD", 11.0, 10.9, 11.1);
    expect(accepted).toBe(false);

    // The health monitor's recorded quote must still be the ORIGINAL
    // 1.1000-area tick, not the rejected 11.0 print -- recordQuote() was
    // never called for the rejected tick.
    const snapshot = monitor.getSnapshot();
    const eurusd = snapshot.qualityMetrics.find((q) => q.symbol === "EURUSD");
    expect(eurusd?.lastBid).toBeCloseTo(1.0999, 4);
  });

  it("does not record a source-priority-rejected tick as fresh", () => {
    core    = new InternalLiquidityCore({ symbols: ["EURUSD"], tickMs: 60_000 });
    monitor = new FeedHealthMonitor();
    monitor.start(["EURUSD"]);

    expect(ingest(core, monitor, "EURUSD", 1.1000, 1.0999, 1.1001, "twelvedata-ws")).toBe(true);

    // A lower-priority REST tick moments later -- rejected by §0.6's ordering guard.
    const accepted = ingest(core, monitor, "EURUSD", 1.0500, 1.0499, 1.0501, "twelvedata-rest");
    expect(accepted).toBe(false);

    const snapshot = monitor.getSnapshot();
    const eurusd = snapshot.qualityMetrics.find((q) => q.symbol === "EURUSD");
    expect(eurusd?.lastBid).toBeCloseTo(1.0999, 4); // still the WS tick, not the discarded REST one
  });

  it("still records a genuinely accepted tick as fresh (control case)", () => {
    core    = new InternalLiquidityCore({ symbols: ["EURUSD"], tickMs: 60_000 });
    monitor = new FeedHealthMonitor();
    monitor.start(["EURUSD"]);

    expect(ingest(core, monitor, "EURUSD", 1.1000, 1.0999, 1.1001)).toBe(true);
    expect(monitor.isQuoteFresh("EURUSD")).toBe(true);
    expect(monitor.quoteAgeMs("EURUSD")).toBeLessThan(1_000);
  });
});
