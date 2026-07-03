import { prisma } from "../shared/db.js";
import type { OlosSignal } from "../shared/contracts.js";

export class OlosSignalService {
  // Crea un nuovo segnale OLOS AI con dettagli completi
  async createSignal(data: {
    userId: string;
    symbol: string;
    timeframe: "1M" | "5M" | "15M" | "1H" | "4H" | "1D";
    signalType: "BUY" | "SELL" | "NEUTRAL";
    confidence: number;
    setupPattern: string;
    setupDescription: string;
    supportLevel?: number;
    resistanceLevel?: number;
    confluenceFactors: string[];
    confidenceBreakdown: {
      momentum: number;
      regime: number;
      macro: number;
      volume?: number;
    };
    entryPrice: number;
    entryRationale: string;
    targetLevels: Array<{
      level: number;
      pips: number;
      type: "target1" | "target2" | "final";
    }>;
    stopLoss: number;
    slRationale: string;
    riskRewardRatio: number;
    macroEvents: Array<{
      eventName: string;
      impact: string;
      timeToEvent: string;
    }>;
    marketRegime: "bullish" | "bearish" | "sideways";
    volatilityLevel: "low" | "medium" | "high";
    expectedRiskPips: number;
    marginRequirement: number;
    liquidityProfile: "tight" | "balanced" | "broad";
  }) {
    return await prisma.olosSignal.create({
      data: {
        userId: data.userId,
        symbol: data.symbol,
        timeframe: data.timeframe,
        signalType: data.signalType,
        confidence: new Decimal(data.confidence),
        setupPattern: data.setupPattern,
        setupDescription: data.setupDescription,
        supportLevel: data.supportLevel ? new Decimal(data.supportLevel) : null,
        resistanceLevel: data.resistanceLevel
          ? new Decimal(data.resistanceLevel)
          : null,
        confluenceFactors: JSON.stringify(data.confluenceFactors),
        confidenceBreakdown: JSON.stringify(data.confidenceBreakdown),
        entryPrice: new Decimal(data.entryPrice),
        entryRationale: data.entryRationale,
        targetLevels: JSON.stringify(data.targetLevels),
        stopLoss: new Decimal(data.stopLoss),
        slRationale: data.slRationale,
        riskRewardRatio: new Decimal(data.riskRewardRatio),
        macroEvents: JSON.stringify(data.macroEvents),
        marketRegime: data.marketRegime,
        volatilityLevel: data.volatilityLevel,
        expectedRiskPips: new Decimal(data.expectedRiskPips),
        marginRequirement: new Decimal(data.marginRequirement),
        liquidityProfile: data.liquidityProfile,
      },
    });
  }

  // Ottiene i segnali OLOS attivi per un utente
  async getActiveSignals(userId: string, filters?: { symbol?: string }) {
    const where: any = {
      userId,
      status: "ACTIVE",
    };

    if (filters?.symbol) where.symbol = filters.symbol;

    const signals = await prisma.olosSignal.findMany({
      where,
      orderBy: { confidence: "desc" },
    });

    return signals.map((s) => this.formatSignal(s));
  }

  // Ottiene lo storico di tutti i segnali
  async getSignalHistory(userId: string, filters?: {
    symbol?: string;
    status?: string;
    startDate?: Date;
    limit?: number;
    offset?: number;
  }) {
    const where: any = { userId };

    if (filters?.symbol) where.symbol = filters.symbol;
    if (filters?.status) where.status = filters.status;
    if (filters?.startDate) {
      where.createdAt = { gte: filters.startDate };
    }

    const [signals, total] = await Promise.all([
      prisma.olosSignal.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: filters?.limit || 50,
        skip: filters?.offset || 0,
      }),
      prisma.olosSignal.count({ where }),
    ]);

    return {
      signals: signals.map((s) => this.formatSignal(s)),
      total,
      limit: filters?.limit || 50,
      offset: filters?.offset || 0,
    };
  }

  // Trigger di un segnale (da ACTIVE a TRIGGERED)
  async triggerSignal(signalId: string) {
    return await prisma.olosSignal.update({
      where: { id: signalId },
      data: {
        status: "TRIGGERED",
        triggeredAt: new Date(),
      },
    });
  }

  // Chiude un segnale
  async closeSignal(signalId: string) {
    return await prisma.olosSignal.update({
      where: { id: signalId },
      data: {
        status: "CLOSED",
      },
    });
  }

  // Calcola statistiche dei segnali OLOS
  async getSignalStatistics(userId: string) {
    const signals = await prisma.olosSignal.findMany({
      where: { userId },
    });

    const totalSignals = signals.length;
    const activeSignals = signals.filter((s) => s.status === "ACTIVE").length;
    const triggeredSignals = signals.filter(
      (s) => s.status === "TRIGGERED"
    ).length;
    const closedSignals = signals.filter((s) => s.status === "CLOSED").length;

    // Segnali per timeframe
    const byTimeframe: Record<string, number> = {};
    signals.forEach((s) => {
      byTimeframe[s.timeframe] = (byTimeframe[s.timeframe] || 0) + 1;
    });

    // Segnali per tipo
    const byType: Record<string, number> = {};
    signals.forEach((s) => {
      byType[s.signalType] = (byType[s.signalType] || 0) + 1;
    });

    // Confidence media
    const avgConfidence =
      totalSignals > 0
        ? parseFloat(
            (
              signals.reduce(
                (sum: number, s) => sum + s.confidence.toNumber(),
                0
              ) / totalSignals
            ).toFixed(2)
          )
        : 0;

    return {
      totalSignals,
      activeSignals,
      triggeredSignals,
      closedSignals,
      avgConfidence,
      byTimeframe,
      byType,
    };
  }

  private formatSignal(signal: any): OlosSignal {
    return {
      id: signal.id,
      userId: signal.userId,
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      signalType: signal.signalType,
      confidence: signal.confidence.toNumber(),
      setupPattern: signal.setupPattern,
      setupDescription: signal.setupDescription,
      supportLevel: signal.supportLevel?.toNumber(),
      resistanceLevel: signal.resistanceLevel?.toNumber(),
      // confluenceFactors/confidenceBreakdown/targetLevels/macroEvents are
      // native Prisma Json columns — already deserialized by Prisma, never
      // JSON-encoded strings. Calling JSON.parse() on them crashes.
      confluenceFactors: signal.confluenceFactors,
      confidenceBreakdown: signal.confidenceBreakdown,
      entryPrice: signal.entryPrice.toNumber(),
      entryRationale: signal.entryRationale,
      targetLevels: signal.targetLevels,
      stopLoss: signal.stopLoss.toNumber(),
      slRationale: signal.slRationale,
      riskRewardRatio: signal.riskRewardRatio.toNumber(),
      macroEvents: signal.macroEvents,
      marketRegime: signal.marketRegime,
      volatilityLevel: signal.volatilityLevel,
      expectedRiskPips: signal.expectedRiskPips.toNumber(),
      marginRequirement: signal.marginRequirement.toNumber(),
      liquidityProfile: signal.liquidityProfile,
      status: signal.status,
      triggeredAt: signal.triggeredAt?.toISOString(),
      createdAt: signal.createdAt.toISOString(),
      updatedAt: signal.updatedAt.toISOString(),
      generatedAt: signal.createdAt.toISOString(),
    };
  }

  /**
   * Mark ACTIVE signals older than the TTL as EXPIRED.
   * TTL matches SignalGenerator's per-symbol cooldown (4h) so an expired
   * signal never overlaps with the next one generated for the same symbol —
   * otherwise both stay "ACTIVE" at once and look like the same setup
   * showing two different confidence percentages.
   */
  async expireStaleActiveSignals(ttlHours = 4): Promise<number> {
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000);
    const result = await prisma.olosSignal.updateMany({
      where: { status: "ACTIVE", createdAt: { lt: cutoff } },
      data: { status: "EXPIRED" },
    });
    return result.count;
  }
}

import { Decimal } from "@prisma/client/runtime/library";

export const olosSignalService = new OlosSignalService();
