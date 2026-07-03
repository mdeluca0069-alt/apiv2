/**
 * CorrelationGraph — a general-purpose weighted correlation graph over an
 * arbitrary symbol universe.
 *
 * Distinct from the two correlation engines that already exist:
 *   - signals-engine/correlation.engine.ts: signal-time confirmation against
 *     a fixed 5-peer instrument list (+ a synthesized DXY leg) for ONE
 *     candidate symbol/side. Untouched by this file.
 *   - risk-service/correlation.matrix.ts: portfolio-time NxN matrix over a
 *     user's currently OPEN positions, DB-backed (TradeAudit exit prices).
 *     Untouched by this file.
 *
 * This module instead builds a graph for ANY symbol list the caller supplies
 * (e.g. the full Portfolio Intelligence universe), reusing the exact same
 * pearson()/returns() math helpers rather than reimplementing correlation —
 * and reading live candles the same way signals-engine/correlation.engine.ts
 * does, rather than going through the DB.
 */
import { pearson, returns } from "./correlation.matrix.js";
import { getCandles, type Timeframe } from "../market-data/candle.aggregator.js";

export type CorrelationNode = {
  symbol: string;
};

export type CorrelationEdge = {
  a: string;
  b: string;
  correlation: number;   // [-1, 1], signed
  weight: number;        // |correlation| — edge "strength" for graph queries
  sign: 1 | -1;
  dataPoints: number;
};

export type CorrelationGraph = {
  nodes: CorrelationNode[];
  edges: CorrelationEdge[];
  generatedAt: string;
};

export type CorrelationGraphOptions = {
  timeframe?: Timeframe;
  lookback?:  number;
};

const DEFAULT_TIMEFRAME: Timeframe = "1H";
const DEFAULT_LOOKBACK = 60;
const MIN_DATA_POINTS = 10; // same threshold CorrelationEngine uses before trusting a reading

/** Builds a weighted correlation graph over `symbols`. Duplicate symbols are deduplicated; self-pairs are never edges. */
export function buildCorrelationGraph(symbols: string[], options: CorrelationGraphOptions = {}): CorrelationGraph {
  const timeframe = options.timeframe ?? DEFAULT_TIMEFRAME;
  const lookback   = options.lookback   ?? DEFAULT_LOOKBACK;

  const uniqueSymbols = [...new Set(symbols)];
  const nodes: CorrelationNode[] = uniqueSymbols.map((symbol) => ({ symbol }));

  const returnsCache = new Map<string, number[]>();
  const returnsOf = (symbol: string): number[] => {
    let r = returnsCache.get(symbol);
    if (!r) {
      const closes = getCandles(symbol, timeframe, lookback).map((c) => c.close);
      r = returns(closes);
      returnsCache.set(symbol, r);
    }
    return r;
  };

  const edges: CorrelationEdge[] = [];
  for (let i = 0; i < uniqueSymbols.length; i++) {
    for (let j = i + 1; j < uniqueSymbols.length; j++) {
      const a = uniqueSymbols[i]!;
      const b = uniqueSymbols[j]!;
      const ra = returnsOf(a);
      const rb = returnsOf(b);
      const len = Math.min(ra.length, rb.length);
      if (len < MIN_DATA_POINTS) continue;

      const r = Math.round(pearson(ra.slice(-len), rb.slice(-len)) * 1000) / 1000;
      if (r === 0) continue; // keeps the graph sparse — a genuinely zero edge carries no information
      edges.push({ a, b, correlation: r, weight: Math.abs(r), sign: r >= 0 ? 1 : -1, dataPoints: len });
    }
  }

  return { nodes, edges, generatedAt: new Date().toISOString() };
}

/**
 * Connected components of symbols joined by an edge whose |correlation|
 * meets `threshold` — a simple union-find query, not a general graph-
 * algorithm library. Used by Portfolio Intelligence to flag "correlated
 * clusters" that concentrate risk beyond what a single pairwise check shows.
 * Singletons (no qualifying edge) are excluded from the result.
 */
export function correlatedClusters(graph: CorrelationGraph, threshold = 0.75): string[][] {
  const parent = new Map<string, string>();
  for (const node of graph.nodes) parent.set(node.symbol, node.symbol);

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  for (const edge of graph.edges) {
    if (edge.weight >= threshold) union(edge.a, edge.b);
  }

  const groups = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const root = find(node.symbol);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(node.symbol);
  }

  return [...groups.values()].filter((g) => g.length > 1);
}
