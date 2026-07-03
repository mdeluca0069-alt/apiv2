/**
 * AutopilotPipeline — connects OLOS signal output to the execution engine.
 *
 * Flow:
 *   OlosSignal → AutopilotConfig validation → Risk Engine pre-check
 *              → Position sizing → orderController.placeOrder()
 *
 * Every decision (execute or skip) is recorded via autopilotService.recordDecision()
 * and written to AuditLog.
 *
 * The pipeline NEVER bypasses the Risk Engine — it is a consumer on top of
 * the same pre-trade path that manual orders use.
 */
import { autopilotService } from "./autopilot.service.js";
import { riskEngine }       from "../risk-service/risk.engine.js";
import { orderController }  from "../trading-service/order.controller.js";
import { marginController } from "../risk-service/margin.controller.js";
import { correlationMatrix } from "../risk-service/correlation.matrix.js";
import { quoteCache }       from "../market-data/quote.cache.js";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }         from "../events-bus/event.bus.js";
import { signalTelemetry }  from "../signals-engine/signal.telemetry.js";
import { economicEventService, currenciesForSymbol } from "../economic-calendar/economic.event.service.js";
import { metrics } from "../gateway/metrics.js";
import { autopilotEligibility } from "./autopilot.eligibility.js";
import { globalRiskSupervisor, SAFE_MODE_MIN_CONFIDENCE } from "../risk-service/global.risk.supervisor.js";
import { executionIntelligence } from "../execution-service/execution.intelligence.js";
import type { BrokerState } from "../shared/state.js";
import type { OrderTriggeredEvent } from "../events-bus/event.bus.js";

export type AutopilotSignalInput = {
  userId:    string;
  symbol:    string;
  signalType: "BUY" | "SELL" | "NEUTRAL";
  confidence: number;        // 0–100
  entryPrice?: number;
  stopLoss?:   number;
  takeProfit?: number;
  timeframe?:  string;
  signalId?:   string;
};

export type AutopilotDecision =
  | { action: "EXECUTED";  orderId: string;  reason: string }
  | { action: "SKIPPED";   reason: string }
  | { action: "REJECTED";  reason: string };

export class AutopilotPipeline {

  /**
   * Evaluate a signal against autopilot config and execute if all gates pass.
   * Returns the decision taken (EXECUTED | SKIPPED | REJECTED).
   */
  async evaluate(input: AutopilotSignalInput, state?: BrokerState): Promise<AutopilotDecision> {

    // ── 1. Skip neutral signals immediately ──────────────────────────────────
    if (input.signalType === "NEUTRAL") {
      return this._skip(input.userId, input.symbol, "NEUTRAL signal — no action");
    }

    // ── 2. Load autopilot config ─────────────────────────────────────────────
    const cfg = await autopilotService.getConfig(input.userId);

    if (!cfg.enabled) {
      return this._skip(input.userId, input.symbol, "Autopilot disabled");
    }

    if (cfg.pausedByAdmin) {
      return this._skip(
        input.userId, input.symbol,
        `Autopilot paused by admin${cfg.pausedReason ? `: ${cfg.pausedReason}` : ""}`,
      );
    }

    // ── 2b. Platform governance: global admin kill switch + master toggle ───
    if (state) {
      const gov = state.getOlosGovernance();
      if (!gov.autopilotEnabled) {
        return this._skip(input.userId, input.symbol, "Autopilot disabled platform-wide by admin");
      }
      if (state.getRiskPolicy().killSwitchEnabled) {
        return this._reject(input.userId, input.symbol, "Trading kill switch active");
      }
    }

    // ── 3. Confidence gate (cheap sync — eliminates most signals before any DB) ─
    const confDecimal = input.confidence / 100;
    if (confDecimal < cfg.minConfidence) {
      return this._skip(
        input.userId,
        input.symbol,
        `Confidence ${(confDecimal * 100).toFixed(1)}% < gate ${(cfg.minConfidence * 100).toFixed(1)}%`,
      );
    }

    // ── 4. Symbol allowlist / blocklist (sync) ────────────────────────────────
    if (cfg.blockedSymbols.includes(input.symbol)) {
      return this._skip(input.userId, input.symbol, `Symbol ${input.symbol} is blocked`);
    }
    if (cfg.allowedSymbols.length > 0 && !cfg.allowedSymbols.includes(input.symbol)) {
      return this._skip(input.userId, input.symbol, `Symbol ${input.symbol} not in allowed list`);
    }

    // ── 2b4. Global Risk Supervisor — platform-wide safety mode (sync) ────────
    {
      const supervisorMode = globalRiskSupervisor.getMode();
      if (supervisorMode === "EMERGENCY_MODE" || supervisorMode === "FULL_AUTOPILOT_STOP") {
        const { reason } = globalRiskSupervisor.getState();
        return this._skip(input.userId, input.symbol, `Risk supervisor ${supervisorMode}: ${reason}`);
      }
      if (supervisorMode === "SAFE_MODE") {
        const requiredConfidence = Math.max(cfg.minConfidence, SAFE_MODE_MIN_CONFIDENCE);
        if (confDecimal < requiredConfidence) {
          const { reason } = globalRiskSupervisor.getState();
          return this._skip(
            input.userId, input.symbol,
            `Risk supervisor SAFE_MODE requires confidence ≥ ${(requiredConfidence * 100).toFixed(0)}% (${reason})`,
          );
        }
      }
    }

    // ── 2b3. Per-client daily loss lock (sync, reads cfg) ─────────────────────
    if (cfg.dailyLossLockedUntil && new Date(cfg.dailyLossLockedUntil) > new Date()) {
      return this._skip(input.userId, input.symbol, "Daily loss limit reached — resumes next trading day");
    }

    // ── PARALLEL FETCH — run all DB-bound gate checks in one round trip ───────
    // Gates 2b2 (eligibility), 2c (event lock), 2d (daily cap), 5 (max open),
    // 6 (drawdown/exposure) all previously ran as sequential await chains.
    // Batching them cuts ~5 serial round-trips to 1 parallel wait.
    // marginState is fetched once here and reused for sizing in step 7.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const currencies = currenciesForSymbol(input.symbol);

    type ParallelResult = [
      Awaited<ReturnType<typeof autopilotEligibility.assertEligible>>,
      Awaited<ReturnType<typeof economicEventService.getUpcoming>>,
      number,
      number,
      import("../shared/contracts.js").MarginState | null,
    ];
    const [elig, eventUpcoming, todayCount, openCount, marginStateFetched]: ParallelResult =
      IS_PERSISTENT
        ? await Promise.all([
            autopilotEligibility.assertEligible(input.userId),
            cfg.eventLockMinutes > 0
              ? economicEventService.getUpcoming(cfg.eventLockMinutes / 60, currencies).catch(() => [])
              : Promise.resolve([]) as Promise<Awaited<ReturnType<typeof economicEventService.getUpcoming>>>,
            prisma.position.count({
              where: { userId: input.userId, openedByAutopilot: true, openedAt: { gte: startOfToday } },
            }),
            prisma.position.count({ where: { userId: input.userId, status: "OPEN" } }),
            marginController.getMarginState(input.userId).catch(() => null),
          ])
        : [{ eligible: true }, [], 0, 0, null];

    // Evaluate in original priority order so rejection reasons are consistent.

    // ── 2b2. Eligibility ──────────────────────────────────────────────────────
    if (!elig.eligible) {
      return this._reject(input.userId, input.symbol, `Not eligible: ${elig.reason}`);
    }

    // ── 2c. Event-lock gate ────────────────────────────────────────────────────
    if (cfg.eventLockMinutes > 0 && eventUpcoming.length > 0) {
      const lockMs = cfg.eventLockMinutes * 60_000;
      const locked = eventUpcoming.some((e) => {
        const eta = new Date(e.eventTime).getTime() - Date.now();
        return eta > 0 && eta < lockMs && (e.impact === "high" || e.impact === "critical");
      });
      if (locked) {
        return this._skip(input.userId, input.symbol, `Event lock active (${cfg.eventLockMinutes}m window)`);
      }
    }

    // ── 2d. Daily trade cap ────────────────────────────────────────────────────
    if (IS_PERSISTENT && todayCount >= cfg.maxDailyTrades) {
      return this._skip(
        input.userId, input.symbol,
        `Daily trade cap reached (${todayCount}/${cfg.maxDailyTrades})`,
      );
    }

    // ── 5. Max open trades guard ──────────────────────────────────────────────
    if (IS_PERSISTENT && openCount >= cfg.maxOpenTrades) {
      return this._skip(
        input.userId, input.symbol,
        `Max open trades reached (${openCount}/${cfg.maxOpenTrades})`,
      );
    }

    // ── 6. Drawdown / exposure guard (uses pre-fetched marginState) ───────────
    if (IS_PERSISTENT) {
      if (!marginStateFetched) {
        return this._skip(input.userId, input.symbol, "Could not read margin state");
      }
      const drawdownPct = marginStateFetched.balance > 0
        ? ((marginStateFetched.balance - marginStateFetched.equity) / marginStateFetched.balance) * 100
        : 0;
      if (drawdownPct >= cfg.stopDrawdownPct) {
        return this._reject(
          input.userId, input.symbol,
          `Drawdown ${drawdownPct.toFixed(1)}% exceeds stop limit ${cfg.stopDrawdownPct}%`,
        );
      }
      if (marginStateFetched.equity > 0) {
        const exposurePct = (marginStateFetched.marginUsed / marginStateFetched.equity) * 100;
        if (exposurePct >= cfg.maxExposurePct) {
          return this._skip(
            input.userId, input.symbol,
            `Exposure ${exposurePct.toFixed(1)}% ≥ max ${cfg.maxExposurePct}%`,
          );
        }
      }
    }

    // ── 7. Resolve live price and compute position size ──────────────────────
    const quote = quoteCache.get(input.symbol);
    if (!quote) {
      return this._skip(input.userId, input.symbol, "No live price available");
    }

    const midPrice = quote.mid;

    // ── 7b0. Spread guard ─────────────────────────────────────────────────────
    const spreadBps = midPrice > 0 ? ((quote.ask - quote.bid) / midPrice) * 10_000 : 0;
    if (spreadBps > cfg.maxSpreadBps) {
      return this._skip(
        input.userId, input.symbol,
        `Spread ${spreadBps.toFixed(1)}bps exceeds max ${cfg.maxSpreadBps}bps`,
      );
    }

    // Mode-based risk fraction
    const riskFraction =
      cfg.mode === "CONSERVATIVE" ? Math.min(cfg.maxRiskPerTrade, 0.02) :
      cfg.mode === "AGGRESSIVE"   ? Math.min(cfg.maxRiskPerTrade, 0.08) :
                                    cfg.maxRiskPerTrade;

    // Capital base: use the pre-fetched margin state (avoids a second DB round-trip).
    let availableCapital = 10_000; // fallback for sandbox
    if (IS_PERSISTENT && marginStateFetched) {
      availableCapital = marginStateFetched.equity * (cfg.capitalPct / 100);
    }

    const riskBudget = availableCapital * riskFraction;

    // Derive leverage from config mode
    const leverage =
      cfg.mode === "CONSERVATIVE" ? 5  :
      cfg.mode === "AGGRESSIVE"   ? 20 :
      10;

    // Notional = riskBudget × leverage; quantity = notional / price
    const notional = riskBudget * leverage;
    let quantity  = Math.max(1, Math.round(notional / midPrice));

    // ── 7b. Correlation-aware sizing ─────────────────────────────────────────
    // Halve size if this symbol is highly correlated (|r| > 0.75) with an
    // already-open position in a way that compounds the same net exposure.
    // Missing/insufficient history must never block a trade — skip silently.
    if (IS_PERSISTENT) {
      try {
        const corrPairs = await correlationMatrix.correlationWithOpenPositions(input.userId, input.symbol);
        if (corrPairs.length > 0) {
          const openPositions = await prisma.position.findMany({
            where:  { userId: input.userId, status: "OPEN", symbol: { in: corrPairs.map((p) => p.symbolB) } },
            select: { symbol: true, side: true },
          });
          const sideBySymbol = new Map(openPositions.map((p) => [p.symbol, p.side]));
          const compounding = corrPairs.some((p) => {
            const otherSide = sideBySymbol.get(p.symbolB);
            if (!otherSide) return false;
            const sameDirection = otherSide === input.signalType;
            return (p.correlation > 0.75 && sameDirection) || (p.correlation < -0.75 && !sameDirection);
          });
          if (compounding) {
            quantity = Math.max(1, Math.round(quantity * 0.5));
          }
        }
      } catch {
        // correlation check is advisory — never block on failure
        metrics.inc("autopilot_correlation_fallback_total");
      }
    }

    // ── 7c. Execution Intelligence — decide HOW to execute ───────────────────
    // Independent of the whether-to-trade gates above. Operates on real,
    // already-available signals (spread/feed-health/regime/platform execution
    // quality) and may resize the order, park it as a resting LIMIT instead of
    // a MARKET fill, or skip this cycle entirely. Every decision is
    // explainable via ei.reasons and folded into the recorded reason string.
    const ei = executionIntelligence.evaluate({
      symbol:       input.symbol,
      side:         input.signalType as "BUY" | "SELL",
      confidence:   confDecimal,
      quantity,
      midPrice,
      spreadBps,
      maxSpreadBps: cfg.maxSpreadBps,
    });

    if (ei.action === "CANCEL" || ei.action === "DELAY") {
      return this._skip(
        input.userId, input.symbol,
        `Execution intelligence ${ei.action} (score=${ei.executionScore}): ${ei.reasons.join("; ")}`,
      );
    }

    if (ei.action === "RESIZE" && ei.adjustedQuantity) {
      quantity = ei.adjustedQuantity;
    }

    // ── 8. Risk Engine pre-trade check ───────────────────────────────────────
    if (IS_PERSISTENT) {
      const riskResult = await riskEngine.preTradeCheck({
        userId:        input.userId,
        symbol:        input.symbol,
        side:          input.signalType as "BUY" | "SELL",
        quantity,
        requestedPrice: input.entryPrice,
        leverage,
        midPrice,
        clientOrderId: input.signalId ? `ap_${input.signalId}` : undefined,
      });

      if (!riskResult.pass) {
        return this._reject(
          input.userId,
          input.symbol,
          `Risk engine: ${riskResult.reason} — ${riskResult.detail}`,
        );
      }
    }

    // ── 9. Place the order ───────────────────────────────────────────────────
    // PROCEED/RESIZE place an immediate MARKET order; SWITCH_TO_LIMIT parks a
    // real resting LIMIT order at the mid price (avoiding the inflated spread
    // that triggered it), bounded by a real expiry handled by the existing
    // pending-order-expiry job.
    const useLimitOrder = ei.action === "SWITCH_TO_LIMIT" && ei.limitPrice != null;
    try {
      const ack = await orderController.placeOrder(
        {
          symbol:        input.symbol,
          side:          input.signalType as "BUY" | "SELL",
          type:          useLimitOrder ? "LIMIT" : "MARKET",
          quantity,
          price:         useLimitOrder ? ei.limitPrice : undefined,
          expiresAt:     useLimitOrder ? ei.limitExpiresAt : undefined,
          stopLoss:      input.stopLoss,
          takeProfit:    input.takeProfit,
          leverage,
          clientOrderId: input.signalId ? `ap_${input.signalId}` : undefined,
        },
        {
          userId:   input.userId,
          tenantId: "tenant_igfxpro",
        },
      );

      const baseReason = `Signal conf=${input.confidence.toFixed(0)}% mode=${cfg.mode} size=${quantity}` +
        (ei.action !== "PROCEED" ? ` exec=${ei.action}(score=${ei.executionScore})` : "");

      if (ack.status === "FILLED") {
        // Tag the resulting position as autopilot-managed and freeze its
        // initial SL as the fixed "1R" reference for the position manager
        // (break-even/trailing math must never use a SL that's already moved).
        // Also link to signal telemetry (MFE/MAE/outcome tracking) when available,
        // and record the actual fill slippage vs. the mid price used for sizing
        // so it's visible in the audit trail.
        const { slippageBps, suffix } = await this._tagFilledPosition(ack.id, midPrice, input.signalId);
        const reason = baseReason + suffix;

        await autopilotService.recordDecision(input.userId, input.symbol, "EXECUTED", reason);
        eventBus.emit("autopilot.executed", {
          userId:  input.userId,
          orderId: ack.id,
          symbol:  input.symbol,
          side:    input.signalType,
          reason,
          slippageBps,
          executionAction: ei.action,
          executionScore:  ei.executionScore,
          timestamp: new Date().toISOString(),
        });

        return { action: "EXECUTED", orderId: ack.id, reason };
      }

      if (ack.status === "ACCEPTED") {
        // Resting LIMIT order genuinely placed — not yet filled, so there is
        // no position to tag. It will be tagged later via handleOrderTriggered()
        // when order.trigger.watcher.ts fills it, or auto-cancelled by
        // pending.order.expiry.ts if it never fills within ei.limitExpiresAt.
        const reason = `${baseReason} — resting LIMIT @ ${ei.limitPrice} expires ${ei.limitExpiresAt}`;

        await autopilotService.recordDecision(input.userId, input.symbol, "EXECUTED", reason);
        eventBus.emit("autopilot.executed", {
          userId:  input.userId,
          orderId: ack.id,
          symbol:  input.symbol,
          side:    input.signalType,
          reason,
          executionAction: ei.action,
          executionScore:  ei.executionScore,
          timestamp: new Date().toISOString(),
        });

        return { action: "EXECUTED", orderId: ack.id, reason };
      }

      return this._reject(
        input.userId,
        input.symbol,
        `Order rejected: ${ack.rejectionReason ?? "unknown"}`,
      );
    } catch (err) {
      return this._reject(
        input.userId,
        input.symbol,
        `Execution error: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Tag a filled position as autopilot-managed, freeze its initial SL, and
   * link it to signal telemetry. Shared by the immediate-MARKET-fill path
   * (step 9) and handleOrderTriggered() for SWITCH_TO_LIMIT orders that fill
   * later via order.trigger.watcher.ts.
   */
  private async _tagFilledPosition(
    orderId: string,
    midPriceAtDecision: number,
    signalId?: string,
  ): Promise<{ slippageBps?: number; suffix: string }> {
    if (!IS_PERSISTENT || !prisma) return { suffix: "" };

    const db = prisma as NonNullable<typeof prisma>;
    const pos = await db.position.findFirst({
      where:  { orderId },
      select: { id: true, entryPrice: true, stopLoss: true },
    }).catch(() => null);

    if (!pos) return { suffix: "" };

    const fillPrice = pos.entryPrice.toNumber();
    const slippageBps = midPriceAtDecision > 0
      ? ((fillPrice - midPriceAtDecision) / midPriceAtDecision) * 10_000
      : 0;

    await db.position.update({
      where: { id: pos.id },
      data: {
        openedByAutopilot: true,
        initialStopLoss:   pos.stopLoss,
      },
    }).catch(() => { /* non-fatal — position manager will skip if untagged */ });

    if (signalId) {
      void signalTelemetry.linkPosition(signalId, pos.id, orderId, fillPrice);
    }

    return { slippageBps, suffix: ` slippage=${slippageBps.toFixed(1)}bps` };
  }

  /**
   * Handles a deferred fill for an autopilot-originated resting order (placed
   * via SWITCH_TO_LIMIT). Only acts on orders whose clientOrderId carries the
   * "ap_" autopilot tagging convention — manually-placed triggered orders are
   * ignored.
   */
  async handleOrderTriggered(evt: OrderTriggeredEvent): Promise<void> {
    if (!evt.clientOrderId?.startsWith("ap_")) return;
    const signalId = evt.clientOrderId.slice(3);
    const quote = quoteCache.get(evt.symbol);
    await this._tagFilledPosition(evt.orderId, quote?.mid ?? evt.execPrice, signalId);
  }

  private async _skip(userId: string, symbol: string, reason: string): Promise<AutopilotDecision> {
    await autopilotService.recordDecision(userId, symbol, "WAIT", reason);
    return { action: "SKIPPED", reason };
  }

  private async _reject(userId: string, symbol: string, reason: string): Promise<AutopilotDecision> {
    await autopilotService.recordDecision(userId, symbol, "REJECTED", reason);
    eventBus.emit("autopilot.rejected", { userId, symbol, reason, timestamp: new Date().toISOString() });
    return { action: "REJECTED", reason };
  }
}

export const autopilotPipeline = new AutopilotPipeline();

// Tag positions opened via a delayed SWITCH_TO_LIMIT fill — mirrors the
// top-level eventBus.on(...) wiring style used in main.ts for order.filled/
// order.rejected.
eventBus.on("order.triggered", (evt) => {
  void autopilotPipeline.handleOrderTriggered(evt);
});
