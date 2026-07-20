/**
 * internal.liquidity.core.reopen.spec.ts
 *
 * RISK_ENGINE_FREEZE.md §5.4 — proves InternalLiquidityCore.ingestExternalPrice()
 * calls symbolCircuitBreaker.recordReopen() exactly on a genuine stale->fresh
 * reopen transition (comparing the last real price before the gap against the
 * first real price after), and never on the very first tick a symbol ever
 * receives (whose "previous" price would just be the synthetic seed, not a
 * real market price) or on an ordinary tick that was never stale.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockRecordTick, mockRecordReopen } = vi.hoisted(() => ({
  mockRecordTick:   vi.fn(),
  mockRecordReopen: vi.fn(),
}));
vi.mock("../risk-service/symbol.circuit.breaker.js", () => ({
  symbolCircuitBreaker: { recordTick: mockRecordTick, recordReopen: mockRecordReopen },
}));

const { InternalLiquidityCore } = await import("../liquidity-engine/internal.liquidity.core.js");
const STALE_THRESHOLD_MS = 360_000;

function makeCore(symbols: string[] = ["EURUSD"]) {
  return new InternalLiquidityCore({ symbols, tickMs: 60_000 });
}

describe("InternalLiquidityCore — reopen-gap wiring", () => {
  let core: InstanceType<typeof InternalLiquidityCore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
    core = makeCore(["EURUSD"]);
  });

  afterEach(() => {
    core.stop();
    vi.useRealTimers();
  });

  it("does not call recordReopen on a symbol's very first real tick", () => {
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    expect(mockRecordReopen).not.toHaveBeenCalled();
    expect(mockRecordTick).toHaveBeenCalledWith("EURUSD", 1.1000, "FX_MAJOR");
  });

  it("does not call recordReopen on a normal consecutive tick (never went stale)", () => {
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    mockRecordReopen.mockClear();

    vi.advanceTimersByTime(1_000);
    core.ingestExternalPrice("EURUSD", 1.1001, 1.1000, 1.1002);

    expect(mockRecordReopen).not.toHaveBeenCalled();
  });

  it("calls recordReopen with the last pre-gap price and the first post-gap price after a real staleness gap", () => {
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    mockRecordReopen.mockClear();

    // Advance well past the staleness threshold and let the periodic tick
    // observe it — this is what production's setInterval-driven _tickAll
    // does; tickSymbol() here drives the same private _tick() path.
    vi.advanceTimersByTime(STALE_THRESHOLD_MS + 1_000);
    core.tickSymbol("EURUSD");
    expect(core.isStale("EURUSD")).toBe(true);

    core.ingestExternalPrice("EURUSD", 1.1500, 1.1499, 1.1501);

    expect(mockRecordReopen).toHaveBeenCalledWith("EURUSD", 1.1000, 1.1500, "FX_MAJOR");
    expect(core.isStale("EURUSD")).toBe(false);
  });

  it("does not call recordReopen again on the tick right after a reopen (isStale already cleared)", () => {
    core.ingestExternalPrice("EURUSD", 1.1000, 1.0999, 1.1001);
    vi.advanceTimersByTime(STALE_THRESHOLD_MS + 1_000);
    core.tickSymbol("EURUSD");
    core.ingestExternalPrice("EURUSD", 1.1500, 1.1499, 1.1501);
    mockRecordReopen.mockClear();

    vi.advanceTimersByTime(1_000);
    core.ingestExternalPrice("EURUSD", 1.1501, 1.1500, 1.1502);

    expect(mockRecordReopen).not.toHaveBeenCalled();
  });
});
