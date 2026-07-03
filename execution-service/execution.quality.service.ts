/**
 * ExecutionQualityService — MiFID II best execution reporting and analytics.
 *
 * MiFID II Article 27 requires investment firms to:
 *   1. Execute orders on terms most favorable to clients.
 *   2. Publish annual execution quality reports.
 *   3. Monitor execution quality on an ongoing basis.
 *
 * This service computes:
 *   fillRate         — % of orders that filled vs rejected/cancelled
 *   avgFillMs        — average order-to-fill latency
 *   p50/p95/p99Ms    — latency percentiles
 *   avgSlippagePips  — average slippage across all fills
 *   avgQualityScore  — average 0-100 execution quality score
 *   rejectionRate    — % of orders rejected by risk engine
 *   bySymbol         — per-symbol execution breakdown
 *   bestFill/worstFill — best and worst single-order slippage
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { slippageController }    from "./slippage.controller.js";
import { assetClassOf }          from "../liquidity-engine/liquidity.provider.js";

export type ExecutionQualityStats = {
  windowDays:      number;
  totalOrders:     number;
  filledOrders:    number;
  rejectedOrders:  number;
  cancelledOrders: number;
  fillRate:        number;      // 0-100 %
  rejectionRate:   number;      // 0-100 %
  avgFillMs:       number;      // milliseconds
  p50Ms:           number;
  p95Ms:           number;
  p99Ms:           number;
  avgSlippagePips: number;
  avgQualityScore: number;
  bestFillMs:      number;
  worstFillMs:     number;
  bySymbol:        SymbolStats[];
  byAssetClass:    AssetClassStats[];
  generatedAt:     string;
};

export type SymbolStats = {
  symbol:      string;
  fills:       number;
  avgFillMs:   number;
  avgSlippage: number;
  fillRate:    number;
};

export type AssetClassStats = {
  assetClass:  string;
  fills:       number;
  avgFillMs:   number;
  avgSlippage: number;
};

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.max(0, Math.ceil(sorted.length * (p / 100)) - 1);
  return sorted[idx]!;
}

function emptyStats(windowDays: number): ExecutionQualityStats {
  return {
    windowDays, totalOrders: 0, filledOrders: 0, rejectedOrders: 0,
    cancelledOrders: 0, fillRate: 0, rejectionRate: 0,
    avgFillMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0,
    avgSlippagePips: 0, avgQualityScore: 0,
    bestFillMs: 0, worstFillMs: 0,
    bySymbol: [], byAssetClass: [],
    generatedAt: new Date().toISOString(),
  };
}

export class ExecutionQualityService {

  async getStats(windowDays = 30, userId?: string): Promise<ExecutionQualityStats> {
    if (!IS_PERSISTENT) return emptyStats(windowDays);

    const db    = prisma as NonNullable<typeof prisma>;
    const since = new Date(Date.now() - windowDays * 86_400_000);

    const orders = await db.order.findMany({
      where: {
        createdAt: { gte: since },
        ...(userId ? { userId } : {}),
      },
      select: {
        status:           true,
        symbol:           true,
        slippage:         true,
        averageFillPrice: true,
        requestedPrice:   true,
        createdAt:        true,
        filledAt:         true,
      },
    });

    if (!orders.length) return emptyStats(windowDays);

    const filled    = orders.filter((o) => o.status === "FILLED");
    const rejected  = orders.filter((o) => o.status === "REJECTED");
    const cancelled = orders.filter((o) => o.status === "CANCELLED");

    // ── Latency computation ────────────────────────────────────────────────────
    const latencies = filled
      .filter((o) => o.filledAt !== null)
      .map((o) => o.filledAt!.getTime() - o.createdAt.getTime())
      .filter((ms) => ms >= 0 && ms < 30_000)
      .sort((a, b) => a - b);

    const avgFillMs  = latencies.length ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0;
    const p50Ms      = percentile(latencies, 50);
    const p95Ms      = percentile(latencies, 95);
    const p99Ms      = percentile(latencies, 99);
    const bestFillMs = latencies[0] ?? 0;
    const worstFillMs = latencies[latencies.length - 1] ?? 0;

    // ── Slippage computation ───────────────────────────────────────────────────
    const slippages = filled
      .map((o) => Number(o.slippage ?? 0))
      .filter((s) => s >= 0);

    const avgSlippagePips = slippages.length
      ? slippages.reduce((s, v) => s + v, 0) / slippages.length
      : 0;

    // Quality scores from fill validator
    const qualityScores = filled
      .filter((o) => o.averageFillPrice && o.requestedPrice)
      .map((o) => {
        const fillPrice     = Number(o.averageFillPrice!);
        const expectedPrice = Number(o.requestedPrice!);
        // Get spread from slippage proxy
        const spread = Number(o.slippage ?? 0) * 2;
        return slippageController.qualityScore(o.symbol, expectedPrice, fillPrice, spread);
      });

    const avgQualityScore = qualityScores.length
      ? qualityScores.reduce((s, v) => s + v, 0) / qualityScores.length
      : 100;

    // ── Per-symbol breakdown ───────────────────────────────────────────────────
    const symMap = new Map<string, { fills: number; totalMs: number; totalSlip: number; rejects: number; total: number }>();
    for (const o of orders) {
      const cur = symMap.get(o.symbol) ?? { fills: 0, totalMs: 0, totalSlip: 0, rejects: 0, total: 0 };
      cur.total++;
      if (o.status === "FILLED") {
        cur.fills++;
        if (o.filledAt) cur.totalMs += o.filledAt.getTime() - o.createdAt.getTime();
        cur.totalSlip += Number(o.slippage ?? 0);
      }
      if (o.status === "REJECTED") cur.rejects++;
      symMap.set(o.symbol, cur);
    }

    const bySymbol: SymbolStats[] = Array.from(symMap.entries())
      .map(([symbol, v]) => ({
        symbol,
        fills:       v.fills,
        avgFillMs:   v.fills > 0 ? Math.round(v.totalMs / v.fills) : 0,
        avgSlippage: v.fills > 0 ? Math.round((v.totalSlip / v.fills) * 10) / 10 : 0,
        fillRate:    v.total > 0 ? Math.round((v.fills / v.total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.fills - a.fills)
      .slice(0, 20);

    // ── Per-asset-class breakdown ──────────────────────────────────────────────
    const acMap = new Map<string, { fills: number; totalMs: number; totalSlip: number }>();
    for (const o of orders.filter((o) => o.status === "FILLED")) {
      const ac  = assetClassOf(o.symbol);
      const cur = acMap.get(ac) ?? { fills: 0, totalMs: 0, totalSlip: 0 };
      cur.fills++;
      if (o.filledAt) cur.totalMs += o.filledAt.getTime() - o.createdAt.getTime();
      cur.totalSlip += Number(o.slippage ?? 0);
      acMap.set(ac, cur);
    }

    const byAssetClass: AssetClassStats[] = Array.from(acMap.entries())
      .map(([assetClass, v]) => ({
        assetClass,
        fills:       v.fills,
        avgFillMs:   v.fills > 0 ? Math.round(v.totalMs / v.fills) : 0,
        avgSlippage: v.fills > 0 ? Math.round((v.totalSlip / v.fills) * 10) / 10 : 0,
      }))
      .sort((a, b) => b.fills - a.fills);

    const totalOrders = orders.length;
    return {
      windowDays,
      totalOrders,
      filledOrders:    filled.length,
      rejectedOrders:  rejected.length,
      cancelledOrders: cancelled.length,
      fillRate:        totalOrders > 0 ? Math.round((filled.length  / totalOrders) * 1000) / 10 : 0,
      rejectionRate:   totalOrders > 0 ? Math.round((rejected.length / totalOrders) * 1000) / 10 : 0,
      avgFillMs:       Math.round(avgFillMs),
      p50Ms,
      p95Ms,
      p99Ms,
      avgSlippagePips: Math.round(avgSlippagePips * 10) / 10,
      avgQualityScore: Math.round(avgQualityScore),
      bestFillMs,
      worstFillMs,
      bySymbol,
      byAssetClass,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const executionQualityService = new ExecutionQualityService();
