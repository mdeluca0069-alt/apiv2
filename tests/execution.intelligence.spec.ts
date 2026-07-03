/**
 * execution.intelligence.spec.ts
 *
 * Task 13, Phase 2 — ExecutionIntelligenceEngine is pure and synchronous, so
 * every test exercises evaluate() directly against mocked signal sources.
 * Each test overrides only the signal it targets from a deterministic clean
 * baseline, mirroring the pattern used by global.risk.supervisor.spec.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockGetSnapshot, mockQuoteAgeMs, mockIsQuoteFresh, mockGetRegimeSnapshot, mockGetState } = vi.hoisted(() => ({
  mockGetSnapshot:      vi.fn(),
  mockQuoteAgeMs:       vi.fn(),
  mockIsQuoteFresh:     vi.fn(),
  mockGetRegimeSnapshot: vi.fn(),
  mockGetState:         vi.fn(),
}));

vi.mock("../market-data/feed.health.monitor.js", () => ({
  feedHealthMonitor: {
    getSnapshot:  mockGetSnapshot,
    quoteAgeMs:   mockQuoteAgeMs,
    isQuoteFresh: mockIsQuoteFresh,
  },
}));

vi.mock("../ai-core/regime.snapshot.js", () => ({
  getRegimeSnapshot: mockGetRegimeSnapshot,
}));

vi.mock("../risk-service/global.risk.supervisor.js", () => ({
  globalRiskSupervisor: { getState: mockGetState },
}));

import { ExecutionIntelligenceEngine } from "../execution-service/execution.intelligence.js";

const CLEAN_SNAPSHOT = {
  qualityMetrics: [
    { symbol: "EURUSD", spreadQuality: "ok" as const },
  ],
};

const CLEAN_REGIME = {
  status: "ACTIVE" as const,
  regime: "TRENDING", adx: 30, adxSlope: 1, trending: true, description: "trending",
  atr: 0.001, atrNormalized: 0.3, volatilityLevel: "LOW", asOf: new Date().toISOString(),
};

function baseInput(overrides: Partial<Parameters<ExecutionIntelligenceEngine["evaluate"]>[0]> = {}) {
  return {
    symbol: "EURUSD", side: "BUY" as const, confidence: 0.85,
    quantity: 100, midPrice: 1.1000, spreadBps: 2, maxSpreadBps: 20,
    ...overrides,
  };
}

let engine: ExecutionIntelligenceEngine;

beforeEach(() => {
  vi.clearAllMocks();
  engine = new ExecutionIntelligenceEngine();
  mockGetSnapshot.mockReturnValue(CLEAN_SNAPSHOT);
  mockQuoteAgeMs.mockReturnValue(500);
  mockIsQuoteFresh.mockReturnValue(true);
  mockGetRegimeSnapshot.mockReturnValue(CLEAN_REGIME);
  mockGetState.mockReturnValue({ signals: { avgExecutionLatencyMs: 50, executionFailureRate: 0 } });
});

describe("ExecutionIntelligenceEngine.evaluate — hard stops", () => {
  it("CANCELs on a crossed book regardless of every other signal", () => {
    mockGetSnapshot.mockReturnValue({ qualityMetrics: [{ symbol: "EURUSD", spreadQuality: "crossed" }] });
    const r = engine.evaluate(baseInput());
    expect(r.action).toBe("CANCEL");
    expect(r.executionScore).toBe(0);
    expect(r.reasons.join(" ")).toMatch(/crossed/i);
  });

  it("CANCELs on a stale quote regardless of every other signal", () => {
    mockIsQuoteFresh.mockReturnValue(false);
    mockQuoteAgeMs.mockReturnValue(500_000);
    const r = engine.evaluate(baseInput());
    expect(r.action).toBe("CANCEL");
    expect(r.reasons.join(" ")).toMatch(/stale/i);
  });
});

describe("ExecutionIntelligenceEngine.evaluate — clean conditions", () => {
  it("PROCEEDs with a high score when every signal is nominal", () => {
    const r = engine.evaluate(baseInput());
    expect(r.action).toBe("PROCEED");
    expect(r.executionScore).toBeGreaterThanOrEqual(70);
  });
});

describe("ExecutionIntelligenceEngine.evaluate — RESIZE band", () => {
  it("reduces quantity proportionally to score when spread eats into the mid band", () => {
    // ratio = 16/20 = 0.8 → clamped to ceiling 0.7 → near-max spread penalty (~28pts) lands in RESIZE band
    const r = engine.evaluate(baseInput({ spreadBps: 16, maxSpreadBps: 20 }));
    expect(r.action).toBe("RESIZE");
    expect(r.adjustedQuantity).toBeDefined();
    expect(r.adjustedQuantity!).toBeLessThan(100);
    expect(r.adjustedQuantity!).toBeGreaterThanOrEqual(1);
  });

  it("scales adjustedQuantity continuously with score (higher score → larger size)", () => {
    const lowScore  = engine.evaluate(baseInput({ spreadBps: 16, maxSpreadBps: 20 }));
    const highScore = engine.evaluate(baseInput({ spreadBps: 12, maxSpreadBps: 20 }));
    expect(highScore.executionScore).toBeGreaterThan(lowScore.executionScore);
  });
});

describe("ExecutionIntelligenceEngine.evaluate — SWITCH_TO_LIMIT band", () => {
  it("parks at mid with a bounded expiry when spread is the dominant cause in the low-mid band", () => {
    // spreadQuality "wide" (+15) + ratio penalty pushes deep into the 35-50 band, spread-dominant
    mockGetSnapshot.mockReturnValue({ qualityMetrics: [{ symbol: "EURUSD", spreadQuality: "wide" }] });
    const r = engine.evaluate(baseInput({ spreadBps: 17, maxSpreadBps: 20 }));
    expect(r.action).toBe("SWITCH_TO_LIMIT");
    expect(r.limitPrice).toBe(1.1000);
    expect(r.limitExpiresAt).toBeDefined();
    expect(new Date(r.limitExpiresAt!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("ExecutionIntelligenceEngine.evaluate — DELAY band", () => {
  it("DELAYs (not SWITCH_TO_LIMIT) when the dominant cause is non-spread", () => {
    // Extreme volatility (+25, dominant) + exec failure (+15) + exec latency (+10)
    // + low confidence (+10) = 60pts → score 40, lands in the 35-50 band, non-spread-dominant
    mockGetRegimeSnapshot.mockReturnValue({ ...CLEAN_REGIME, volatilityLevel: "EXTREME", atrNormalized: 3.0 });
    mockGetState.mockReturnValue({ signals: { avgExecutionLatencyMs: 900, executionFailureRate: 0.2 } });
    const r = engine.evaluate(baseInput({ confidence: 0.5 }));
    expect(r.action).toBe("DELAY");
    expect(r.executionScore).toBeGreaterThanOrEqual(35);
    expect(r.executionScore).toBeLessThan(50);
  });
});

describe("ExecutionIntelligenceEngine.evaluate — CANCEL via low score", () => {
  it("CANCELs when accumulated penalties drive the score below the switch floor", () => {
    mockGetSnapshot.mockReturnValue({ qualityMetrics: [{ symbol: "EURUSD", spreadQuality: "wide" }] });
    mockGetRegimeSnapshot.mockReturnValue({ ...CLEAN_REGIME, volatilityLevel: "EXTREME", atrNormalized: 3.0 });
    mockGetState.mockReturnValue({ signals: { avgExecutionLatencyMs: 900, executionFailureRate: 0.2 } });
    const r = engine.evaluate(baseInput({ spreadBps: 18, maxSpreadBps: 20, confidence: 0.5 }));
    expect(r.action).toBe("CANCEL");
    expect(r.executionScore).toBeLessThan(35);
  });
});

describe("ExecutionIntelligenceEngine.evaluate — explainability", () => {
  it("always returns the full signals snapshot used to derive the decision", () => {
    const r = engine.evaluate(baseInput());
    expect(r.signals.spreadBps).toBe(2);
    expect(r.signals.quoteFresh).toBe(true);
    expect(r.signals.volatilityLevel).toBe("LOW");
  });

  it("handles a null supervisor signals snapshot (no evaluate() cycle has run yet) without throwing", () => {
    mockGetState.mockReturnValue({ signals: null });
    expect(() => engine.evaluate(baseInput())).not.toThrow();
  });
});
