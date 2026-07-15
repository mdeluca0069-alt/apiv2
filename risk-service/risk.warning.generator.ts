/**
 * risk.warning.generator.ts — periodically persists each user's REAL current
 * risk state into the RiskWarning table that risk.warning.service.ts reads.
 *
 * Milestone 1 / Fix #9. Before this fix, shared/state.ts's risk-dashboard
 * methods were hardcoded stubs (always "STABLE"/"IDLE"/null) — every user
 * saw a permanently green risk dashboard regardless of real account risk.
 * risk.warning.service.ts already existed, complete, but nothing ever
 * called createOrUpdateWarning() to populate the table it reads from.
 *
 * This generator does not invent new risk methodology — every field it
 * writes is derived directly from data other, already-correct services in
 * this codebase already compute: margin.controller.ts's real margin state,
 * the user's real open positions, risk-service/leverage.guard.ts's real
 * ESMA asset-class lookup, kill.switch.ts's real cluster-synced state, and
 * shared/trading.suspension.ts's real suspension flag. Fields that would
 * require genuinely new forecasting logic (scenario stress-tests, a margin
 * time-series forecast, event-calendar correlation) are left as empty
 * arrays rather than fabricated — an honest "not computed by this
 * milestone," not a second kind of fake data replacing the first.
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { marginController } from "./margin.controller.js";
import { killSwitch } from "./kill.switch.js";
import { tradingSuspension } from "../shared/trading.suspension.js";
import { riskWarningService } from "./risk.warning.service.js";
import { riskSnapshotService } from "./risk.snapshot.service.js";
import { ESMA_LEVERAGE_CAPS } from "../shared/contracts.js";

const STOP_OUT_LEVEL_PCT    = 50;
const MARGIN_CALL_LEVEL_PCT = 100;
const CAUTION_LEVEL_PCT     = 150;

type HeatmapClass = "FX_MAJOR" | "INDEX" | "COMMODITY" | "EQUITY" | "CRYPTO";

function toHeatmapClass(assetClass: string): HeatmapClass | null {
  switch (assetClass) {
    case "FX_MAJOR":
    case "FX_MINOR": return "FX_MAJOR"; // exposureHeatmap has no FX_MINOR bucket — folded in
    case "INDEX":     return "INDEX";
    case "COMMODITY": return "COMMODITY";
    case "EQUITY":    return "EQUITY";
    case "CRYPTO":    return "CRYPTO";
    default:          return null;
  }
}

export class RiskWarningGenerator {
  /**
   * Computes and persists the real current risk warning for one user.
   * Safe to call frequently — createOrUpdateWarning() updates the same row
   * rather than growing the table unboundedly.
   */
  async generateForUser(userId: string): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;

    const [marginState, openPositions, wallet] = await Promise.all([
      marginController.getMarginState(userId).catch(() => null),
      prisma.position.findMany({
        where:  { userId, status: "OPEN" },
        select: { symbol: true, side: true, marginUsed: true, leverage: true },
      }),
      prisma.walletAccount.findUnique({ where: { userId }, select: { balance: true } }),
    ]);

    if (!marginState) return; // no wallet — nothing to report

    const marginLevel = Number.isFinite(marginState.marginLevelPct) ? marginState.marginLevelPct : 999;

    // ── Portfolio aggregate + exposure heatmap — real, from real open positions ──
    const byAsset: Record<string, number> = {};
    let longExposure = 0, shortExposure = 0;
    const heatmap: Record<HeatmapClass, number> = { FX_MAJOR: 0, INDEX: 0, COMMODITY: 0, EQUITY: 0, CRYPTO: 0 };
    let esmaLeverageActive = false;

    if (openPositions.length > 0) {
      const symbols = [...new Set(openPositions.map((p) => p.symbol))];
      const instruments = await prisma.instrument.findMany({
        where:  { symbol: { in: symbols } },
        select: { symbol: true, assetClass: true },
      });
      const assetClassBySymbol = new Map(instruments.map((i) => [i.symbol, i.assetClass]));

      for (const pos of openPositions) {
        const margin = pos.marginUsed.toNumber();
        byAsset[pos.symbol] = (byAsset[pos.symbol] ?? 0) + margin;
        if (pos.side === "BUY") longExposure += margin; else shortExposure += margin;

        const assetClass = assetClassBySymbol.get(pos.symbol);
        if (assetClass) {
          const bucket = toHeatmapClass(assetClass);
          if (bucket) heatmap[bucket] += margin;
          if (pos.leverage >= (ESMA_LEVERAGE_CAPS[assetClass] ?? Infinity)) esmaLeverageActive = true;
        }
      }
    }
    const totalExposure = longExposure + shortExposure;

    const negativeBalanceActive = (wallet?.balance.toNumber() ?? 0) < 0;
    const liveTradeDisabled     = killSwitch.isActive() || tradingSuspension.isSuspended(userId);

    // ── Risk score / severity / regulatory level ──────────────────────────
    // FASE 4.3 (RISK_ENGINE_FREEZE.md Bug #8): this used to compute its own
    // second, independent riskScore formula (a pure linear function of
    // marginLevelPct alone) -- risk.snapshot.service.ts's getSnapshot()
    // already computes the real composite score (margin level, drawdown,
    // concentration, margin utilisation), and the two could disagree for
    // the same user at the same time depending on which endpoint was
    // queried. riskSnapshotService is the canonical source now; this
    // generator reuses its riskScore instead of a second formula, matching
    // this file's own stated design philosophy (see header) of deriving
    // fields from already-correct services rather than reinventing them.
    // severity/regulatoryLevel below stay their own direct, monotonic
    // function of marginLevelPct -- that's a genuinely distinct concept
    // (ESMA's three named thresholds), not a second riskScore.
    const snapshot  = await riskSnapshotService.getSnapshot(userId);
    const riskScore = snapshot.riskScore;
    const regulatoryLevel: "none" | "caution" | "high_risk" =
      marginLevel <= MARGIN_CALL_LEVEL_PCT ? "high_risk" :
      marginLevel <= CAUTION_LEVEL_PCT     ? "caution"   : "none";
    const severity: "INFO" | "WARNING" | "CRITICAL" =
      marginLevel <= STOP_OUT_LEVEL_PCT    ? "CRITICAL" :
      marginLevel <= MARGIN_CALL_LEVEL_PCT ? "WARNING"  : "INFO";

    const killSwitchTriggers = killSwitch.isActive()
      ? [{
          trigger:  "PLATFORM_KILL_SWITCH",
          threshold: 0,
          action:    "TRADING_HALTED",
          reason:    killSwitch.getState().reason,
        }]
      : [];

    await riskWarningService.createOrUpdateWarning({
      userId,
      riskScore,
      marginLevel,
      portfolioAggregate: {
        byAsset,
        byDirection: { long: longExposure, short: shortExposure },
        totalExposure,
      },
      esmaLeverageActive,
      negativeBalanceActive,
      liveTradeDisabled,
      scenarios: [],           // not computed by this milestone — see file header
      upcomingEvents: [],      // not computed by this milestone — see file header
      marginForecast: [],      // not computed by this milestone — see file header
      exposureHeatmap: heatmap,
      killSwitchTriggers,
      regulatoryLevel,
      eventCalendarItems: [],  // not computed by this milestone — see file header
      severity,
    });
  }

  /** Runs generateForUser() for every user with at least one open position. */
  async generateForAllActiveUsers(): Promise<{ processed: number; errors: number }> {
    if (!IS_PERSISTENT || !prisma) return { processed: 0, errors: 0 };

    const activeUserIds = await prisma.position.findMany({
      where:    { status: "OPEN" },
      select:   { userId: true },
      distinct: ["userId"],
    });

    let processed = 0, errors = 0;
    for (const { userId } of activeUserIds) {
      try {
        await this.generateForUser(userId);
        processed++;
      } catch (err) {
        errors++;
        console.error(`[risk-warning-generator] failed for userId=${userId}:`, (err as Error).message);
      }
    }
    return { processed, errors };
  }
}

export const riskWarningGenerator = new RiskWarningGenerator();
