/**
 * correlation.guard.spec.ts
 *
 * RISK_ENGINE_FREEZE.md §3.3 — the real Pearson correlation engine
 * (correlation.matrix.ts) was only ever consulted by the autopilot pipeline
 * (soft size halving); manual/API orders had zero correlation awareness.
 * Proves CorrelationGuard.check() blocks a manual order that would compound
 * net directional exposure with an existing correlated position, using the
 * same direction-aware "compounding" semantics autopilot already
 * established, and that it fails open (never blocks) on missing data or a
 * correlation-subsystem failure.
 */
import { describe, it, expect, vi } from "vitest";

const { mockDb, mockCorrelationWithOpenPositions } = vi.hoisted(() => ({
  mockDb: { position: { findMany: vi.fn() } },
  mockCorrelationWithOpenPositions: vi.fn(),
}));
vi.mock("../shared/db.js", () => ({ prisma: mockDb, IS_PERSISTENT: true }));
vi.mock("../risk-service/correlation.matrix.js", () => ({
  correlationMatrix: { correlationWithOpenPositions: mockCorrelationWithOpenPositions },
}));

const { correlationGuard } = await import("../risk-service/correlation.guard.js");

describe("CorrelationGuard.check()", () => {
  it("accepts when there are no correlated open positions", async () => {
    mockCorrelationWithOpenPositions.mockResolvedValue([]);

    const result = await correlationGuard.check("user-1", "EURUSD", "BUY");
    expect(result.ok).toBe(true);
  });

  it("rejects a same-direction order against a strongly positively-correlated open position", async () => {
    mockCorrelationWithOpenPositions.mockResolvedValue([{ symbolB: "GBPUSD", correlation: 0.9, dataPoints: 50 }]);
    mockDb.position.findMany.mockResolvedValue([{ symbol: "GBPUSD", side: "BUY" }]);

    const result = await correlationGuard.check("user-1", "EURUSD", "BUY");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CORRELATION_RISK_LIMIT_EXCEEDED");
      expect(result.detail).toMatch(/GBPUSD/);
    }
  });

  it("rejects an opposite-direction order against a strongly negatively-correlated open position", async () => {
    mockCorrelationWithOpenPositions.mockResolvedValue([{ symbolB: "XAUUSD", correlation: -0.85, dataPoints: 40 }]);
    mockDb.position.findMany.mockResolvedValue([{ symbol: "XAUUSD", side: "BUY" }]);

    const result = await correlationGuard.check("user-1", "USDJPY", "SELL");
    expect(result.ok).toBe(false);
  });

  it("accepts a same-direction order against a negatively-correlated position (natural hedge, not compounding)", async () => {
    mockCorrelationWithOpenPositions.mockResolvedValue([{ symbolB: "XAUUSD", correlation: -0.85, dataPoints: 40 }]);
    mockDb.position.findMany.mockResolvedValue([{ symbol: "XAUUSD", side: "BUY" }]);

    const result = await correlationGuard.check("user-1", "USDJPY", "BUY");
    expect(result.ok).toBe(true);
  });

  it("accepts when correlation is positive but below the compounding threshold", async () => {
    mockCorrelationWithOpenPositions.mockResolvedValue([{ symbolB: "GBPUSD", correlation: 0.6, dataPoints: 50 }]);
    mockDb.position.findMany.mockResolvedValue([{ symbol: "GBPUSD", side: "BUY" }]);

    const result = await correlationGuard.check("user-1", "EURUSD", "BUY");
    expect(result.ok).toBe(true);
  });

  it("fails open (never blocks) when the correlation lookup throws", async () => {
    mockCorrelationWithOpenPositions.mockRejectedValue(new Error("matrix unavailable"));

    const result = await correlationGuard.check("user-1", "EURUSD", "BUY");
    expect(result.ok).toBe(true);
  });

  it("fails open when the correlated symbol has no matching open position row (stale/edge data)", async () => {
    mockCorrelationWithOpenPositions.mockResolvedValue([{ symbolB: "GBPUSD", correlation: 0.9, dataPoints: 50 }]);
    mockDb.position.findMany.mockResolvedValue([]); // position closed between the two lookups

    const result = await correlationGuard.check("user-1", "EURUSD", "BUY");
    expect(result.ok).toBe(true);
  });
});
