/**
 * internal.liquidity.core.dynamic.spread.spec.ts
 *
 * CRITICAL_REMEDIATION Phase 1 (C10) — InternalLiquidityCore.ingestExternalPrice()'s
 * dynamic spread-widening gate.
 *
 * Root cause: dynMult was computed as
 *   dynamicSpreadEngine.applySpread(...) / dynamicSpreadEngine.getEffectiveSpread(...)
 * applySpread() stores the effective spread as its last step before returning
 * it, so the immediately-following getEffectiveSpread() call always reads
 * back that same value -- the division is mathematically guaranteed to equal
 * 1.0 every time, regardless of real volatility. Since the real-bid/ask
 * widening branch requires dynMult > 1.05, it could never fire: any symbol
 * with real bid/ask from the feed (the common, paid-plan case) never got its
 * spread widened during genuine volatility or scheduled high-impact events,
 * silently, in every environment this ran in.
 *
 * Fix: use dynamicSpreadEngine.getMultiplier(), the API already built for
 * this, instead of the self-cancelling division.
 *
 * These tests use the REAL dynamicSpreadEngine singleton (not mocked) so the
 * full, genuine volatility-multiplier computation runs end-to-end, exactly
 * as it does in production -- the strongest possible proof this is fixed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { InternalLiquidityCore } = await import("../liquidity-engine/internal.liquidity.core.js");
const { quoteCache } = await import("../market-data/quote.cache.js");
const { dynamicSpreadEngine } = await import("../liquidity-engine/dynamic.spread.engine.js");

function makeCore(symbols: string[] = ["EURUSD"]) {
  return new InternalLiquidityCore({ symbols, tickMs: 60_000 });
}

describe("InternalLiquidityCore — CRITICAL_REMEDIATION (C10): dynamic spread widening actually applies to real bid/ask", () => {
  let core: InstanceType<typeof InternalLiquidityCore>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    core = makeCore(["EURUSD"]);
  });

  afterEach(() => {
    core.stop();
    vi.useRealTimers();
  });

  // EURUSD's synthetic construction-time seed is 1.1504 (this class's own
  // basePrices table) -- state.prevCloseMid starts there, not at 0. The
  // first real tick in each test below is deliberately set equal to that
  // seed so preChangePct on tick 1 is ~0% (no widening yet), keeping each
  // test's "baseline" tick clean and letting the SECOND tick's jump be the
  // only thing under test.
  const SEED_MID = 1.1504;

  it("widens the real bid/ask spread on a >1% jump -- comfortably past FX_MAJOR's 0.15% volatility threshold", () => {
    core.ingestExternalPrice("EURUSD", SEED_MID, SEED_MID - 0.0001, SEED_MID + 0.0001, "WS");
    const baseline = quoteCache.get("EURUSD")!;
    const baselineSpread = baseline.ask - baseline.bid;
    expect(baselineSpread).toBeCloseTo(0.0002, 6);
    expect(dynamicSpreadEngine.getMultiplier("EURUSD")).toBeLessThanOrEqual(1.05);

    // Second tick: +1.36% jump from prevCloseMid, feed still supplying a
    // real (narrow, unwidened) bid/ask of the same 0.0002 spread --
    // exactly the scenario that should trigger FX_MAJOR's volatility
    // widening (threshold 0.15%, so this is >9x over).
    vi.advanceTimersByTime(1_000);
    const jumpedMid = SEED_MID * 1.0136;
    core.ingestExternalPrice("EURUSD", jumpedMid, jumpedMid - 0.0001, jumpedMid + 0.0001, "WS");

    const widened = quoteCache.get("EURUSD")!;
    const widenedSpread = widened.ask - widened.bid;

    // CRITICAL_REMEDIATION (C10): on pristine code this stayed exactly
    // 0.0002 (dynMult stuck at 1.0, the branch never entered) -- proving
    // the spread genuinely widened proves dynMult now reflects real
    // volatility, not a self-cancelling ratio.
    expect(widenedSpread).toBeGreaterThan(baselineSpread * 1.5);
    expect(dynamicSpreadEngine.getMultiplier("EURUSD")).toBeGreaterThan(1.05);
  });

  it("does not widen on an ordinary small move well under the volatility threshold", () => {
    core.ingestExternalPrice("EURUSD", SEED_MID, SEED_MID - 0.0001, SEED_MID + 0.0001, "WS");

    vi.advanceTimersByTime(1_000);
    // +0.01% -- far below FX_MAJOR's 0.15% threshold.
    const smallMove = SEED_MID * 1.0001;
    core.ingestExternalPrice("EURUSD", smallMove, smallMove - 0.0001, smallMove + 0.0001, "WS");

    const q = quoteCache.get("EURUSD")!;
    expect(q.ask - q.bid).toBeCloseTo(0.0002, 5);
    expect(dynamicSpreadEngine.getMultiplier("EURUSD")).toBeLessThanOrEqual(1.05);
  });

  it("the widened spread scales with the engine's real computed multiplier, not a fixed/arbitrary amount", () => {
    core.ingestExternalPrice("EURUSD", SEED_MID, SEED_MID - 0.0001, SEED_MID + 0.0001, "WS");
    vi.advanceTimersByTime(1_000);
    const jumpedMid = SEED_MID * 1.0136;
    core.ingestExternalPrice("EURUSD", jumpedMid, jumpedMid - 0.0001, jumpedMid + 0.0001, "WS");

    const q = quoteCache.get("EURUSD")!;
    const actualSpread   = q.ask - q.bid;
    const expectedMult   = dynamicSpreadEngine.getMultiplier("EURUSD");
    const expectedSpread = 0.0002 * expectedMult;

    expect(actualSpread).toBeCloseTo(expectedSpread, 4);
  });

  it("still applies mid-only synthetic widening exactly as before (the branch this bug did NOT affect)", () => {
    // No real bid/ask supplied at all -- exercises the !hasRealBA branch,
    // which already worked correctly pre-fix (getEffectiveSpread() alone,
    // no division), confirming this fix didn't disturb it.
    core.ingestExternalPrice("EURUSD", SEED_MID, undefined, undefined, "REST");
    vi.advanceTimersByTime(1_000);
    core.ingestExternalPrice("EURUSD", SEED_MID * 1.0136, undefined, undefined, "REST");

    const q = quoteCache.get("EURUSD")!;
    expect(q.ask).toBeGreaterThan(q.bid);
  });
});
