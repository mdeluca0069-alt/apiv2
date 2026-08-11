import { prisma } from "../shared/db.js";
import { type RiskWarning } from "../shared/contracts.js";
import { Decimal } from "@prisma/client/runtime/library";

export class RiskWarningService {
  // Crea o aggiorna un warning di rischio
  async createOrUpdateWarning(data: {
    userId: string;
    riskScore: number;
    marginLevel: number;
    portfolioAggregate: {
      byAsset: Record<string, number>;
      byDirection: { long: number; short: number };
      totalExposure: number;
    };
    esmaLeverageActive: boolean;
    negativeBalanceActive: boolean;
    liveTradeDisabled: boolean;
    scenarios: Array<{
      name: string;
      impact: string;
      probability: number;
      maxLoss: number;
    }>;
    upcomingEvents: Array<{
      eventName: string;
      time: string;
      assetClass: string;
      impact: string;
      mitigationAction?: string;
    }>;
    marginForecast: Array<{
      timepoint: string;
      forecastedMarginLevel: number;
      riskZone: string;
    }>;
    exposureHeatmap: {
      FX_MAJOR: number;
      INDEX: number;
      COMMODITY: number;
      EQUITY: number;
      CRYPTO: number;
    };
    killSwitchTriggers: Array<{
      trigger: string;
      threshold: number;
      action: string;
      reason: string;
    }>;
    regulatoryLevel: "none" | "caution" | "high_risk";
    regulatoryText?: string;
    eventCalendarItems: Array<{
      eventTime: string;
      symbol: string;
      eventType: string;
      forecast: string;
      actual?: string;
    }>;
    severity: "INFO" | "WARNING" | "CRITICAL";
  }) {
    // Find existing warning per l'utente (usa il più recente)
    const existing = await prisma.riskWarning.findFirst({
      where: { userId: data.userId },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      return await prisma.riskWarning.update({
        where: { id: existing.id },
        data: {
          riskScore: data.riskScore,
          marginLevel: new Decimal(data.marginLevel),
          portfolioAggregate: JSON.stringify(data.portfolioAggregate),
          esmaLeverageActive: data.esmaLeverageActive,
          negativeBalanceActive: data.negativeBalanceActive,
          liveTradeDisabled: data.liveTradeDisabled,
          scenarios: JSON.stringify(data.scenarios),
          upcomingEvents: JSON.stringify(data.upcomingEvents),
          marginForecast: JSON.stringify(data.marginForecast),
          exposureHeatmap: JSON.stringify(data.exposureHeatmap),
          killSwitchTriggers: JSON.stringify(data.killSwitchTriggers),
          regulatoryLevel: data.regulatoryLevel,
          regulatoryText: data.regulatoryText,
          eventCalendarItems: JSON.stringify(data.eventCalendarItems),
          severity: data.severity,
        },
      });
    }

    return await prisma.riskWarning.create({
      data: {
        userId: data.userId,
        riskScore: data.riskScore,
        marginLevel: new Decimal(data.marginLevel),
        portfolioAggregate: JSON.stringify(data.portfolioAggregate),
        esmaLeverageActive: data.esmaLeverageActive,
        negativeBalanceActive: data.negativeBalanceActive,
        liveTradeDisabled: data.liveTradeDisabled,
        scenarios: JSON.stringify(data.scenarios),
        upcomingEvents: JSON.stringify(data.upcomingEvents),
        marginForecast: JSON.stringify(data.marginForecast),
        exposureHeatmap: JSON.stringify(data.exposureHeatmap),
        killSwitchTriggers: JSON.stringify(data.killSwitchTriggers),
        regulatoryLevel: data.regulatoryLevel,
        regulatoryText: data.regulatoryText,
        eventCalendarItems: JSON.stringify(data.eventCalendarItems),
        severity: data.severity,
      },
    });
  }

  // Ottiene il warning attuale per un utente
  async getCurrentWarning(userId: string) {
    const warning = await prisma.riskWarning.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    return warning ? this.formatWarning(warning) : null;
  }

  // Ottiene gli ultimi N warning (storico)
  async getWarningHistory(userId: string, limit: number = 20) {
    const warnings = await prisma.riskWarning.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return warnings.map((w: any) => this.formatWarning(w));
  }

  // Ottiene i warning critici
  async getCriticalWarnings(userId?: string) {
    const where: any = { severity: "CRITICAL" };
    if (userId) where.userId = userId;

    const warnings = await prisma.riskWarning.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    return warnings.map((w: any) => this.formatWarning(w));
  }

  // Riconosce un warning
  // FRONTEND_MOBILE_HARDENING Phase 4 (KYC/compliance audit): this used to
  // do an unconditional prisma.riskWarning.update({ where: { id: warningId } })
  // with no userId check anywhere in the call chain (route handler didn't
  // even resolve a principal). Any authenticated user could acknowledge
  // ANY other user's RiskWarning by id -- including the mandatory MiFID II
  // ESMA CFD risk disclosure surfaced via RiskWarningOverlay.tsx/
  // CompliancePage.tsx -- silently marking it acknowledged (with a real
  // server-recorded acknowledgedAt) without that account holder's consent,
  // corrupting the regulatory evidentiary record. Now scoped to the caller
  // via updateMany({ where: { id, userId } }) + count check, the same
  // conditional-update idiom kyc.service.ts already uses for terminal-state
  // protection -- a warning that doesn't belong to the caller (or doesn't
  // exist) is indistinguishable (count === 0), avoiding resource enumeration.
  async acknowledgeWarning(warningId: string, userId: string) {
    const result = await prisma.riskWarning.updateMany({
      where: { id: warningId, userId },
      data: {
        acknowledged: true,
        acknowledgedAt: new Date(),
      },
    });
    if (result.count === 0) {
      throw Object.assign(
        new Error(`Risk warning ${warningId} not found`),
        { statusCode: 404 },
      );
    }
    return result;
  }

  // Analisi scenario - calcola il worst case
  async analyzeScenarios(userId: string) {
    const warning = await this.getCurrentWarning(userId);
    if (!warning) return null;

    // Calcola scenario peggiore
    const scenarios = warning.scenarios;
    const worstCase = scenarios.reduce(
      (max: number, scenario: any) =>
        Math.max(max, scenario.maxLoss * (scenario.probability / 100)),
      0
    );

    // Calcola probabilità di margin call
    const marginLevel = warning.marginLevel;
    const stopOutLevel = 50; // ESMA standard
    const marginToStopOut = Math.max(0, marginLevel - stopOutLevel);
    const marginCallProbability =
      marginToStopOut > 0 ? Math.min(100, (marginToStopOut / marginLevel) * 50) : 0;

    return {
      worstCaseScenario: parseFloat(worstCase.toFixed(2)),
      marginCallProbability: parseFloat(marginCallProbability.toFixed(2)),
      recommendedAction:
        marginCallProbability > 50
          ? "Close some positions or deposit funds"
          : "Monitor closely",
      urgency:
        marginCallProbability > 75
          ? "URGENT"
          : marginCallProbability > 50
            ? "HIGH"
            : "NORMAL",
    };
  }

  // Dashboard di rischio
  async getRiskDashboard(userId: string) {
    const warning = await this.getCurrentWarning(userId);
    if (!warning) return null;

    const analysis = await this.analyzeScenarios(userId);
    const history = await this.getWarningHistory(userId, 10);

    return {
      current: warning,
      analysis,
      trend: this.calculateRiskTrend(history),
      heatmap: warning.exposureHeatmap,
      upcomingEvents: warning.upcomingEvents.slice(0, 5),
      killSwitchStatus: warning.killSwitchTriggers.length > 0 ? "ACTIVE" : "IDLE",
    };
  }

  private calculateRiskTrend(
    history: ReturnType<typeof this.formatWarning>[]
  ) {
    if (history.length < 2) return "STABLE";

    const current = history[0].riskScore;
    const previous = history[1].riskScore;

    if (current > previous + 10) return "INCREASING";
    if (current < previous - 10) return "DECREASING";
    return "STABLE";
  }

  private formatWarning(warning: any): RiskWarning {
    return {
      id: warning.id,
      userId: warning.userId,
      riskScore: warning.riskScore,
      marginLevel: warning.marginLevel.toNumber(),
      portfolioAggregate: JSON.parse(warning.portfolioAggregate),
      esmaLeverageActive: warning.esmaLeverageActive,
      negativeBalanceActive: warning.negativeBalanceActive,
      liveTradeDisabled: warning.liveTradeDisabled,
      scenarios: JSON.parse(warning.scenarios),
      upcomingEvents: JSON.parse(warning.upcomingEvents),
      marginForecast: JSON.parse(warning.marginForecast),
      exposureHeatmap: JSON.parse(warning.exposureHeatmap),
      killSwitchTriggers: JSON.parse(warning.killSwitchTriggers),
      regulatoryLevel: warning.regulatoryLevel,
      regulatoryText: warning.regulatoryText,
      eventCalendarItems: JSON.parse(warning.eventCalendarItems),
      severity: warning.severity,
      acknowledged: warning.acknowledged,
      acknowledgedAt: warning.acknowledgedAt?.toISOString(),
      createdAt: warning.createdAt.toISOString(),
      updatedAt: warning.updatedAt.toISOString(),
    };
  }
}

export const riskWarningService = new RiskWarningService();
