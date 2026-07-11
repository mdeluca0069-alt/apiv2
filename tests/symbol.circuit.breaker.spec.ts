/**
 * symbol.circuit.breaker.spec.ts
 *
 * FASE 3.2 — Internal Liquidity Engine.
 *
 * Proves SymbolCircuitBreaker halts a symbol when its price moves more than
 * the asset class's threshold within the rolling window, never takes
 * ownership of a symbol already disabled by someone else (so the recovery
 * sweep can't override a deliberate admin disable), extends an existing
 * halt instead of re-tripping/re-alerting when the move persists, and only
 * auto-recovers a symbol once its own cooldown has actually elapsed.
 *
 * Each test uses its own symbol name — symbolCircuitBreaker is a module
 * singleton, so reusing a symbol across tests would leak halt state between
 * them (a halt this file itself caused two tests ago is real state, not a
 * mock to reset).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockIsEnabled, mockSetEnabled } = vi.hoisted(() => ({
  mockIsEnabled:  vi.fn().mockReturnValue(true),
  mockSetEnabled: vi.fn().mockResolvedValue({}),
}));
vi.mock("../liquidity-engine/broker.spread.config.js", () => ({
  brokerSpreadConfig: { isEnabled: mockIsEnabled, setEnabled: mockSetEnabled },
}));

const { mockTripped } = vi.hoisted(() => ({ mockTripped: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { symbolCircuitBreakerTripped: mockTripped },
}));

vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn(), observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

const { symbolCircuitBreaker } = await import("../risk-service/symbol.circuit.breaker.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockIsEnabled.mockReturnValue(true);
  mockSetEnabled.mockResolvedValue({});
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// _trip()'s call to setEnabled() happens synchronously (before its first
// await), so mock.calls reflects it immediately — this only needs to drain
// the microtask queue for what happens AFTER that await (recording the
// halt, alerting). vi.advanceTimersByTimeAsync(0) is fake-timer-safe,
// unlike vi.waitFor()'s polling, which hangs under fake timers.
async function flushMicrotasks() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("SymbolCircuitBreaker.recordTick()", () => {
  it("does not trip when the move stays under the asset class's threshold", async () => {
    symbolCircuitBreaker.recordTick("TICK_EURUSD_A", 1.1000, "FX_MAJOR");
    vi.advanceTimersByTime(1_000);
    symbolCircuitBreaker.recordTick("TICK_EURUSD_A", 1.1010, "FX_MAJOR"); // ~0.09%, under 0.5% threshold
    await flushMicrotasks();

    expect(mockSetEnabled).not.toHaveBeenCalled();
    expect(symbolCircuitBreaker.isHaltedByBreaker("TICK_EURUSD_A")).toBe(false);
  });

  it("halts the symbol when the move exceeds the threshold within the window", async () => {
    symbolCircuitBreaker.recordTick("TICK_EURUSD_B", 1.1000, "FX_MAJOR");
    vi.advanceTimersByTime(1_000);
    symbolCircuitBreaker.recordTick("TICK_EURUSD_B", 1.1100, "FX_MAJOR"); // ~0.91%, over 0.5% threshold
    await flushMicrotasks();

    expect(mockSetEnabled).toHaveBeenCalledWith("TICK_EURUSD_B", false, "system:circuit-breaker");
    expect(mockTripped).toHaveBeenCalledWith("TICK_EURUSD_B", expect.any(Number), 10);
    expect(symbolCircuitBreaker.isHaltedByBreaker("TICK_EURUSD_B")).toBe(true);
  });

  it("ignores ticks older than the rolling window when measuring the move", async () => {
    symbolCircuitBreaker.recordTick("TICK_EURUSD_C", 1.1000, "FX_MAJOR");
    vi.advanceTimersByTime(11_000); // past the 10s window — old tick should be pruned
    symbolCircuitBreaker.recordTick("TICK_EURUSD_C", 1.1100, "FX_MAJOR");
    await flushMicrotasks();

    // Only one tick left in the window after pruning — can't measure a move yet.
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it("never takes ownership of a symbol already disabled by someone else (e.g. an admin)", async () => {
    mockIsEnabled.mockReturnValue(false); // already disabled, not by the breaker

    symbolCircuitBreaker.recordTick("TICK_EURUSD_D", 1.1000, "FX_MAJOR");
    vi.advanceTimersByTime(1_000);
    symbolCircuitBreaker.recordTick("TICK_EURUSD_D", 1.1100, "FX_MAJOR");
    await flushMicrotasks();

    expect(mockSetEnabled).not.toHaveBeenCalled();
    expect(symbolCircuitBreaker.isHaltedByBreaker("TICK_EURUSD_D")).toBe(false);
  });

  it("extends an existing halt without re-alerting when the move persists", async () => {
    symbolCircuitBreaker.recordTick("TICK_EURUSD_E", 1.1000, "FX_MAJOR");
    vi.advanceTimersByTime(1_000);
    symbolCircuitBreaker.recordTick("TICK_EURUSD_E", 1.1100, "FX_MAJOR");
    await flushMicrotasks();
    expect(mockTripped).toHaveBeenCalledTimes(1);

    mockSetEnabled.mockClear();
    mockTripped.mockClear();

    vi.advanceTimersByTime(1_000);
    symbolCircuitBreaker.recordTick("TICK_EURUSD_E", 1.1150, "FX_MAJOR"); // still moving, still halted
    await flushMicrotasks();

    expect(mockSetEnabled).not.toHaveBeenCalled(); // already disabled — no redundant call
    expect(mockTripped).not.toHaveBeenCalled();     // no duplicate alert
    expect(symbolCircuitBreaker.isHaltedByBreaker("TICK_EURUSD_E")).toBe(true);
  });

  it("uses the default threshold for an unrecognized asset class", async () => {
    symbolCircuitBreaker.recordTick("TICK_WEIRD_A", 100, "UNKNOWN_CLASS");
    vi.advanceTimersByTime(1_000);
    symbolCircuitBreaker.recordTick("TICK_WEIRD_A", 101, "UNKNOWN_CLASS"); // 1%, under the 1.5% default
    await flushMicrotasks();
    expect(mockSetEnabled).not.toHaveBeenCalled();

    symbolCircuitBreaker.recordTick("TICK_WEIRD_A", 102, "UNKNOWN_CLASS"); // ~2% vs oldest — over 1.5%
    await flushMicrotasks();
    expect(mockSetEnabled).toHaveBeenCalledWith("TICK_WEIRD_A", false, "system:circuit-breaker");
  });
});

describe("SymbolCircuitBreaker.runRecoverySweep()", () => {
  it("does not recover before the cooldown has elapsed", async () => {
    symbolCircuitBreaker.recordTick("TICK_EURUSD_F", 1.1000, "FX_MAJOR");
    vi.advanceTimersByTime(1_000);
    symbolCircuitBreaker.recordTick("TICK_EURUSD_F", 1.1100, "FX_MAJOR");
    await flushMicrotasks();
    mockSetEnabled.mockClear();

    vi.advanceTimersByTime(60_000); // 1 minute — well under the 5-minute cooldown
    const result = await symbolCircuitBreaker.runRecoverySweep();

    expect(result.recovered).not.toContain("TICK_EURUSD_F");
    expect(mockSetEnabled).not.toHaveBeenCalledWith("TICK_EURUSD_F", true, "system:circuit-breaker");
    expect(symbolCircuitBreaker.isHaltedByBreaker("TICK_EURUSD_F")).toBe(true);
  });

  it("re-enables the symbol once the cooldown has elapsed", async () => {
    symbolCircuitBreaker.recordTick("TICK_EURUSD_G", 1.1000, "FX_MAJOR");
    vi.advanceTimersByTime(1_000);
    symbolCircuitBreaker.recordTick("TICK_EURUSD_G", 1.1100, "FX_MAJOR");
    await flushMicrotasks();
    mockSetEnabled.mockClear();

    vi.advanceTimersByTime(5 * 60_000 + 1); // just past the 5-minute cooldown
    const result = await symbolCircuitBreaker.runRecoverySweep();

    expect(result.recovered).toContain("TICK_EURUSD_G");
    expect(mockSetEnabled).toHaveBeenCalledWith("TICK_EURUSD_G", true, "system:circuit-breaker");
    expect(symbolCircuitBreaker.isHaltedByBreaker("TICK_EURUSD_G")).toBe(false);
  });
});

describe("SymbolCircuitBreaker.clear()", () => {
  it("manually re-enables and stops tracking the symbol, attributing the actor", async () => {
    symbolCircuitBreaker.recordTick("TICK_EURUSD_H", 1.1000, "FX_MAJOR");
    vi.advanceTimersByTime(1_000);
    symbolCircuitBreaker.recordTick("TICK_EURUSD_H", 1.1100, "FX_MAJOR");
    await flushMicrotasks();
    mockSetEnabled.mockClear();

    await symbolCircuitBreaker.clear("TICK_EURUSD_H", "admin-1");

    expect(mockSetEnabled).toHaveBeenCalledWith("TICK_EURUSD_H", true, "admin-1");
    expect(symbolCircuitBreaker.isHaltedByBreaker("TICK_EURUSD_H")).toBe(false);
  });
});

describe("SymbolCircuitBreaker.getHaltedSymbols()", () => {
  it("reports the halted symbol with move% and cooldown end time", async () => {
    symbolCircuitBreaker.recordTick("TICK_EURUSD_I", 1.1000, "FX_MAJOR");
    vi.advanceTimersByTime(1_000);
    symbolCircuitBreaker.recordTick("TICK_EURUSD_I", 1.1100, "FX_MAJOR");
    await flushMicrotasks();

    const halted = symbolCircuitBreaker.getHaltedSymbols().find((h) => h.symbol === "TICK_EURUSD_I");
    expect(halted).toBeDefined();
    expect(halted!.movePct).toBeGreaterThan(0.5);
    expect(new Date(halted!.cooldownEndsAt).getTime() - new Date(halted!.haltedAt).getTime()).toBe(5 * 60_000);
  });
});
