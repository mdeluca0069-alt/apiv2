/**
 * correlation.graph.test.ts
 *
 * Unit tests for buildCorrelationGraph()/correlatedClusters() — the new
 * general-purpose weighted correlation graph (Task 13, Phase 3), distinct
 * from both signals-engine/correlation.engine.ts (fixed 5-peer, signal-time)
 * and risk-service/correlation.matrix.ts (open-positions-only, DB-backed).
 *
 * Strategy: same technique as correlation.engine.test.ts — seed every test
 * symbol from ONE shared driver return sequence at a fixed scale, so
 * pearson(returns_A, returns_B) is exactly +-1 by construction, giving exact
 * (not approximate) assertions.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { buildCorrelationGraph, correlatedClusters } from "../risk-service/correlation.graph.js";
import { pearson, returns } from "../risk-service/correlation.matrix.js";
import { seedCandles, type Candle } from "../market-data/candle.aggregator.js";

const INTERVAL_SEC = 3600; // "1H"
const BASE_TIME = INTERVAL_SEC * 2_000_000; // offset from correlation.engine.test.ts's base to avoid any overlap

const DRIVER_RETURNS = [
  0.004, -0.002, 0.006, 0.001, -0.003, 0.005, 0.002, -0.001, 0.007, -0.004,
  0.003, 0.0015, -0.002, 0.004, 0.0025, -0.0015, 0.005, -0.003, 0.002, 0.001,
];

function buildCandles(scale: number, basePrice: number): Candle[] {
  const closes: number[] = [basePrice];
  for (const r of DRIVER_RETURNS) closes.push(closes[closes.length - 1]! * (1 + scale * r));
  return closes.map((price, i) => ({
    time: BASE_TIME + i * INTERVAL_SEC,
    open: price, high: price + 0.01, low: price - 0.01, close: price, volume: 1000,
  }));
}

beforeAll(() => {
  seedCandles("GRAPH_A", "1H", buildCandles(1, 100));    // +1 scale
  seedCandles("GRAPH_B", "1H", buildCandles(1, 200));    // +1 scale — perfectly correlated with A
  seedCandles("GRAPH_C", "1H", buildCandles(-1, 50));    // -1 scale — perfectly anti-correlated with A/B
  seedCandles("GRAPH_THIN", "1H", buildCandles(1, 10).slice(0, 5)); // too few candles for MIN_DATA_POINTS
});

describe("buildCorrelationGraph — nodes", () => {
  it("creates one node per unique symbol, deduplicating repeats", () => {
    const graph = buildCorrelationGraph(["GRAPH_A", "GRAPH_B", "GRAPH_A"]);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.map((n) => n.symbol).sort()).toEqual(["GRAPH_A", "GRAPH_B"]);
  });

  it("stamps a valid ISO generatedAt timestamp", () => {
    const graph = buildCorrelationGraph(["GRAPH_A", "GRAPH_B"]);
    expect(() => new Date(graph.generatedAt).toISOString()).not.toThrow();
  });
});

describe("buildCorrelationGraph — edges", () => {
  it("builds a positive-sign edge with weight 1 for perfectly correlated symbols", () => {
    const graph = buildCorrelationGraph(["GRAPH_A", "GRAPH_B"]);
    expect(graph.edges).toHaveLength(1);
    const edge = graph.edges[0]!;
    expect(edge.correlation).toBe(1);
    expect(edge.weight).toBe(1);
    expect(edge.sign).toBe(1);
  });

  it("builds a negative-sign edge for inversely correlated symbols, with weight as the absolute value", () => {
    const graph = buildCorrelationGraph(["GRAPH_A", "GRAPH_C"]);
    const edge = graph.edges.find((e) => (e.a === "GRAPH_C" || e.b === "GRAPH_C"));
    expect(edge!.correlation).toBe(-1);
    expect(edge!.weight).toBe(1);
    expect(edge!.sign).toBe(-1);
  });

  it("never duplicates a pair as both (a,b) and (b,a)", () => {
    const graph = buildCorrelationGraph(["GRAPH_A", "GRAPH_B", "GRAPH_C"]);
    expect(graph.edges).toHaveLength(3); // A-B, A-C, B-C — each exactly once
  });

  it("skips an edge when either symbol has fewer than the minimum data points", () => {
    const graph = buildCorrelationGraph(["GRAPH_A", "GRAPH_THIN"]);
    expect(graph.edges).toHaveLength(0);
  });

  it("reuses the existing pearson()/returns() helpers rather than reimplementing the math", () => {
    const graph = buildCorrelationGraph(["GRAPH_A", "GRAPH_C"]);
    const edge = graph.edges[0]!;
    const expected = Math.round(pearson(returns(buildCandles(1, 100).map((c) => c.close)), returns(buildCandles(-1, 50).map((c) => c.close))) * 1000) / 1000;
    expect(edge.correlation).toBe(expected);
  });
});

describe("correlatedClusters", () => {
  it("groups symbols connected by an edge meeting the threshold into one cluster", () => {
    const graph = buildCorrelationGraph(["GRAPH_A", "GRAPH_B", "GRAPH_C"]);
    const clusters = correlatedClusters(graph, 0.75);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.sort()).toEqual(["GRAPH_A", "GRAPH_B", "GRAPH_C"]);
  });

  it("excludes singleton symbols with no qualifying edge from the result", () => {
    const graph = buildCorrelationGraph(["GRAPH_A", "GRAPH_B", "GRAPH_THIN"]);
    const clusters = correlatedClusters(graph, 0.75);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.sort()).toEqual(["GRAPH_A", "GRAPH_B"]);
    expect(clusters.flat()).not.toContain("GRAPH_THIN");
  });

  it("produces no clusters when no edge meets a stricter threshold than any observed correlation", () => {
    const graph = buildCorrelationGraph(["GRAPH_A", "GRAPH_B"]);
    const clusters = correlatedClusters(graph, 1.5); // above the maximum possible |correlation|
    expect(clusters).toHaveLength(0);
  });
});
