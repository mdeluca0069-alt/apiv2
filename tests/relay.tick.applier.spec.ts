/**
 * relay.tick.applier.spec.ts
 *
 * MULTI-REPLICA TWELVEDATA REMEDIATION — proves scenarios 4 and 6:
 *   4. market-data events are propagated correctly through Redis
 *      (applyRelayedTick() is exactly what main.ts's onTickEvent() —
 *      the receiving side of realtime-infra/redis.pubsub.ts's CH_TICK
 *      relay — now calls).
 *   6. stale-data/health behavior remains correct — specifically the
 *      regression this extraction exists to prevent: a relayed tick must
 *      update FeedHealthMonitor (via recordQuote()), not just
 *      LiquidityCore's quoteCache, or a non-leader replica's own
 *      /api/health would report every TwelveData-sourced symbol as
 *      permanently stale even though quoteCache is genuinely fresh.
 */
import { describe, it, expect, vi } from "vitest";
import { applyRelayedTick } from "../market-data/relay.tick.applier.js";
import type { LiquidityCoreLike, FeedHealthMonitorLike } from "../market-data/relay.tick.applier.js";

function makeMocks(accepted: boolean) {
  const liquidityCore: LiquidityCoreLike = {
    ingestExternalPrice: vi.fn().mockReturnValue(accepted),
  };
  const feedHealthMonitor: FeedHealthMonitorLike = {
    recordQuote: vi.fn(),
  };
  return { liquidityCore, feedHealthMonitor };
}

describe("applyRelayedTick() — accepted tick", () => {
  it("calls ingestExternalPrice with source tagged 'redis-relay' (lowest priority — never overwrites a fresher local tick)", () => {
    const { liquidityCore, feedHealthMonitor } = makeMocks(true);

    applyRelayedTick(liquidityCore, feedHealthMonitor, "EURUSD", 1.085, 1.0849, 1.0851);

    expect(liquidityCore.ingestExternalPrice).toHaveBeenCalledWith(
      "EURUSD", 1.085, 1.0849, 1.0851, "redis-relay",
    );
  });

  it("REGRESSION GUARD: also calls feedHealthMonitor.recordQuote() when the tick is accepted — the gap this extraction closes", () => {
    const { liquidityCore, feedHealthMonitor } = makeMocks(true);

    applyRelayedTick(liquidityCore, feedHealthMonitor, "EURUSD", 1.085, 1.0849, 1.0851);

    expect(feedHealthMonitor.recordQuote).toHaveBeenCalledWith("EURUSD", 1.0849, 1.0851, "redis-relay");
  });

  it("falls back to 0/0 for recordQuote's bid/ask when the relayed tick had no real spread", () => {
    const { liquidityCore, feedHealthMonitor } = makeMocks(true);

    applyRelayedTick(liquidityCore, feedHealthMonitor, "BTCUSD", 65000, undefined, undefined);

    expect(feedHealthMonitor.recordQuote).toHaveBeenCalledWith("BTCUSD", 0, 0, "redis-relay");
  });

  it("returns true when the tick was accepted", () => {
    const { liquidityCore, feedHealthMonitor } = makeMocks(true);

    const result = applyRelayedTick(liquidityCore, feedHealthMonitor, "EURUSD", 1.085);

    expect(result).toBe(true);
  });
});

describe("applyRelayedTick() — rejected tick (stale-data / health-integrity guard)", () => {
  it("does NOT call feedHealthMonitor.recordQuote() when ingestExternalPrice rejects the tick", () => {
    const { liquidityCore, feedHealthMonitor } = makeMocks(false);

    applyRelayedTick(liquidityCore, feedHealthMonitor, "EURUSD", -1);

    expect(liquidityCore.ingestExternalPrice).toHaveBeenCalled();
    expect(feedHealthMonitor.recordQuote).not.toHaveBeenCalled();
  });

  it("returns false when the tick was rejected — a rejected relayed tick must never be mistaken for a fresh, healthy quote (MARKET_DATA_FREEZE.md §0.8's own invariant, preserved here for the relay path too)", () => {
    const { liquidityCore, feedHealthMonitor } = makeMocks(false);

    const result = applyRelayedTick(liquidityCore, feedHealthMonitor, "EURUSD", 0);

    expect(result).toBe(false);
  });
});
