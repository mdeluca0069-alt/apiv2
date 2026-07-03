import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { EMAEngine } from "../indicator-engine/ema.engine.js";
import { RSIEngine } from "../indicator-engine/rsi.engine.js";
import { MACDEngine } from "../indicator-engine/macd.engine.js";
import { BollingerEngine } from "../indicator-engine/bollinger.engine.js";
import { VolatilityEngine, type OHLCV } from "../ai-core/volatility.engine.js";
import { RegimeEngine } from "../ai-core/regime.engine.js";
import { ConfidenceEngine } from "../ai-core/confidence.engine.js";
import type { ConfluenceFactors } from "../ai-core/confidence.engine.js";
import { MarketStructureEngine } from "./market.structure.js";
import type { StructureResult } from "./market.structure.js";
import { multiTimeframeEngine } from "./multi.timeframe.engine.js";
import { correlationEngine } from "./correlation.engine.js";
import { dynamicRiskEngine } from "./dynamic.risk.engine.js";
import { eventBus } from "../events-bus/event.bus.js";
import { signalTelemetry } from "./signal.telemetry.js";
import { adaptiveWeights } from "./adaptive.weights.js";
import { economicEventService } from "../economic-calendar/economic.event.service.js";
import type { RegimeContext } from "../ai-core/regime.engine.js";

/** All OLOS-engine-generated signals are platform-wide (not user-personal) and persisted under this system identity. */
export const PLATFORM_SIGNAL_USER_ID = "sys_olos_engine";

export type GeneratedSignal = {
  id: string;
  symbol: string;
  timeframe: string;
  signalType: "BUY" | "SELL";
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  targetLevels: number[];
  riskRewardRatio: number;
  marketRegime: string;
  volatilityLevel: string;
  confluenceFactors: string[];
  confidenceBreakdown: Record<string, number>;
  entryRationale: string;
  slRationale: string;
  setupPattern: string;
  generatedAt: string;
};

type SymbolEngines = {
  ema50: EMAEngine;
  ema200: EMAEngine;
  rsi: RSIEngine;
  macd: MACDEngine;
  bollinger: BollingerEngine;
  volatility: VolatilityEngine;
  regime: RegimeEngine;
  structure: MarketStructureEngine;
  volumeHistory: number[];
};

export class SignalGenerator {
  private readonly engines = new Map<string, SymbolEngines>();
  private readonly confidence = new ConfidenceEngine();
  private readonly db?: PrismaClient;
  /** In-memory cache — seeded from DB on startup via loadCooldownsFromDB() */
  private readonly cooldowns = new Map<string, number>();

  private readonly COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
  private readonly MIN_CONFIDENCE = 60;

  constructor(db?: PrismaClient) {
    this.db = db;
    if (db) {
      void this.loadCooldownsFromDB();
    }
  }

  /** Restore cooldowns from the most recent signal per symbol in DB. */
  private async loadCooldownsFromDB(): Promise<void> {
    if (!this.db) return;
    try {
      const recent = await this.db.olosSignal.findMany({
        where: { userId: "sys_olos_engine", status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        distinct: ["symbol"],
        select: { symbol: true, createdAt: true },
      });
      for (const row of recent) {
        this.cooldowns.set(row.symbol, row.createdAt.getTime());
      }
    } catch (err) {
      console.warn("[signal-generator] could not load cooldowns from DB:", err);
    }
  }

  private getEngines(symbol: string): SymbolEngines {
    if (!this.engines.has(symbol)) {
      this.engines.set(symbol, {
        ema50:      new EMAEngine(50),
        ema200:     new EMAEngine(200),
        rsi:        new RSIEngine(14),
        macd:       new MACDEngine(12, 26, 9),
        bollinger:  new BollingerEngine(20, 2),
        volatility: new VolatilityEngine(14, 21),
        regime:     new RegimeEngine(),
        structure:  new MarketStructureEngine(),
        volumeHistory: [],
      });
    }
    return this.engines.get(symbol)!;
  }

  async evaluate(symbol: string, candle: OHLCV, timeframe = "1H"): Promise<GeneratedSignal | null> {
    const eng = this.getEngines(symbol);

    // Feed all engines
    eng.ema50.next(candle.close);
    eng.ema200.next(candle.close);
    const rsi       = eng.rsi.next(candle.close);
    const macd      = eng.macd.next(candle.close);
    const bollinger = eng.bollinger.next(candle.close);
    const vol       = eng.volatility.next(candle);
    // structureRaw is side-agnostic (computed before signalType is known below) —
    // structureScoreFor(signalType) is applied once the candidate side exists.
    const structureRaw = eng.structure.next(candle, { atrExpanding: vol?.expanding });

    // Build regime context from live indicator readings
    const regimeContext: RegimeContext = {
      atrNormalized:      vol?.atrNormalized,
      atrExpanding:       vol?.expanding,
      bollingerBandwidth: bollinger?.bandwidth  ?? undefined,
      bollingerSqueeze:   bollinger?.squeeze    ?? undefined,
      recentNewsEvent:    economicEventService.hasRecentHighImpactEvent(symbol, 60),
      structurePhase:     structureRaw.phase,
    };

    const regime    = eng.regime.next(candle, regimeContext);

    // Track volume
    if (candle.volume !== undefined) {
      eng.volumeHistory.push(candle.volume);
      if (eng.volumeHistory.length > 20) eng.volumeHistory.shift();
    }

    // All engines must be warm
    if (!eng.ema200.ready || !rsi || !macd || !vol || !regime) return null;

    // Cooldown check
    const lastSignal = this.cooldowns.get(symbol) ?? 0;
    if (Date.now() - lastSignal < this.COOLDOWN_MS) return null;

    const priceVsEma200 = candle.close > (eng.ema200.value ?? 0) ? "above" : "below";
    const ema50VsEma200 = (eng.ema50.value ?? 0) > (eng.ema200.value ?? 0) ? "above" : "below";

    const avgVol = eng.volumeHistory.length > 0
      ? eng.volumeHistory.reduce((a, b) => a + b, 0) / eng.volumeHistory.length
      : 0;
    const volumeAboveAverage = candle.volume !== undefined && avgVol > 0
      ? candle.volume > avgVol * 1.2
      : false;

    // Real economic calendar check — uses in-memory cache, no DB call
    const macroEventIn4h = economicEventService.macroEventInNext4Hours(symbol, 4);

    // Evaluate BUY signal conditions
    const bullishSignal =
      rsi.zone === "oversold" &&
      macd.crossover === "bullish_cross" &&
      priceVsEma200 === "above" &&
      regime.regime !== "BEARISH_TREND" &&
      regime.regime !== "RISK_OFF";

    // Evaluate SELL signal conditions
    const bearishSignal =
      rsi.zone === "overbought" &&
      macd.crossover === "bearish_cross" &&
      priceVsEma200 === "below" &&
      regime.regime !== "BULLISH_TREND" &&
      regime.regime !== "RISK_OFF";

    if (!bullishSignal && !bearishSignal) return null;

    const signalType: "BUY" | "SELL" = bullishSignal ? "BUY" : "SELL";

    // "Never signal from one timeframe alone" — hard gate, before any confidence
    // scoring happens. Independently pulls its own 1D/4H/1H/15M/5M candle history;
    // does not change this method's (symbol, candle, timeframe) signature.
    const mtf = multiTimeframeEngine.evaluate(symbol, signalType);
    if (!mtf.sufficientAlignment) return null;

    // Cross-asset correlation confirmation — additive confidence sub-score only
    // (not a gate); reuses the platform's existing live candle store, so it
    // never blocks a signal on missing data, only shapes confidence magnitude.
    const correlation = correlationEngine.evaluate(symbol, signalType);

    // structureRaw is never null (the engine reports ready:false + neutral score
    // instead of null while cold) — re-score it now that signalType is known.
    const structure: StructureResult = {
      ...structureRaw,
      structureScore: eng.structure.structureScoreFor(signalType),
    };

    const factors: ConfluenceFactors = {
      signalSide:         signalType,
      regime:             regime.regime,
      priceVsEma200,
      ema50VsEma200,
      rsi,
      macd,
      bollinger,
      volatilityLevel:    vol.level,
      volumeAboveAverage,
      sessionHour:        new Date().getUTCHours(),
      macroEventIn4h,
      structure,
      multiTimeframe: mtf,
      correlation,
    };

    // Load adaptive weights (cached in memory — non-blocking on first call)
    const activeWeights = await adaptiveWeights.getWeights();

    // Check symbol governance — skip if the optimizer has disabled this symbol
    const symConf = activeWeights.symbolConfig[symbol];
    if (symConf && !symConf.enabled) {
      return null; // symbol blacklisted by optimizer
    }

    const { confidence, breakdown, reliable, suppressReason } =
      this.confidence.score(factors, activeWeights.weights);

    if (!reliable || suppressReason) return null;
    if (confidence < this.MIN_CONFIDENCE) return null;

    // Adaptive regime gate check — optimizer may raise per-regime min confidence
    const regimeGate = activeWeights.regimeGates[regime.regime] ?? this.MIN_CONFIDENCE;
    if (confidence < regimeGate) return null;

    // Price levels — deterministic dynamic sizing (volatility/trend/conviction-aware),
    // replacing the previous fixed atr*2/atr*3/atr*5 multiples.
    const atr = vol.atr;
    const direction = signalType === "BUY" ? 1 : -1;
    const entryPrice = candle.close;
    const risk = dynamicRiskEngine.compute({
      entryPrice,
      atr,
      direction,
      trendStrength: regime.adx,
      volatilityLevel: vol.level,
      confidence,
      marketRegime: regime.regime,
      mtfConfidenceMultiplier: mtf.mtfConfidenceMultiplier,
    });
    const { stopLoss, target1, target2, riskRewardRatio } = risk;

    // Confluence factors list
    const confluenceList: string[] = [];
    if (rsi.zone === "oversold" || rsi.zone === "overbought") confluenceList.push(`RSI_${rsi.zone.toUpperCase()}_${rsi.value.toFixed(1)}`);
    if (macd.crossover !== "none") confluenceList.push(`MACD_${macd.crossover.toUpperCase()}`);
    if (priceVsEma200 === "above" && signalType === "BUY") confluenceList.push("PRICE_ABOVE_EMA200");
    if (priceVsEma200 === "below" && signalType === "SELL") confluenceList.push("PRICE_BELOW_EMA200");
    if (ema50VsEma200 === "above" && signalType === "BUY") confluenceList.push("EMA50_ABOVE_EMA200");
    if (volumeAboveAverage) confluenceList.push("VOLUME_SPIKE");
    if (regime.trending) confluenceList.push(`ADX_TRENDING_${regime.adx.toFixed(1)}`);
    if (!macroEventIn4h) confluenceList.push("MACRO_CLEAR");
    confluenceList.push(`MTF_ALIGNED_${mtf.alignmentCount}_OF_${mtf.timeframes.length - mtf.degradedTimeframes.length}`);
    if (mtf.degradedTimeframes.length) confluenceList.push(`MTF_DEGRADED_${mtf.degradedTimeframes.join("_")}`);
    if (correlation.usableCount > 0) confluenceList.push(`CORR_CONSISTENT_${correlation.consistentCount}_OF_${correlation.usableCount}`);

    const setupPattern = signalType === "BUY"
      ? `RSI_OVERSOLD_MACD_BULLISH_CROSS`
      : `RSI_OVERBOUGHT_MACD_BEARISH_CROSS`;

    const signal: GeneratedSignal = {
      id: randomUUID(),
      symbol,
      timeframe,
      signalType,
      confidence,
      entryPrice:    Number(entryPrice.toFixed(6)),
      stopLoss:      Number(stopLoss.toFixed(6)),
      targetLevels:  [Number(target1.toFixed(6)), Number(target2.toFixed(6))],
      riskRewardRatio,
      marketRegime:  regime.regime,
      volatilityLevel: vol.level,
      confluenceFactors: confluenceList,
      confidenceBreakdown: breakdown,
      entryRationale: `RSI ${rsi.value.toFixed(1)} (${rsi.zone}), MACD ${macd.crossover.replace("_", " ")}, price ${priceVsEma200} EMA200, regime: ${regime.regime}.`,
      slRationale:   risk.rationale,
      setupPattern,
      generatedAt:   new Date().toISOString(),
    };

    this.cooldowns.set(symbol, Date.now());

    // Persist first — only emit to clients if the DB write succeeds.
    const persisted = await this.persist(signal);
    if (!persisted) {
      this.cooldowns.delete(symbol);
      return null;
    }

    eventBus.emit("signal.generated", {
      signalId:        signal.id,
      userId:          "PLATFORM",
      symbol:          signal.symbol,
      signalType:      signal.signalType,
      confidence:      signal.confidence,
      marketRegime:    signal.marketRegime,
      entryPrice:      signal.entryPrice,
      stopLoss:        signal.stopLoss,
      riskRewardRatio: signal.riskRewardRatio,
      timestamp:       signal.generatedAt,
    });

    // Record full telemetry — include confidence breakdown so the optimizer
    // can read sub-scores without re-running the indicator stack.
    void signalTelemetry.recordSignal(signal, {
      ema50:         eng.ema50.value   ?? null,
      ema200:        eng.ema200.value  ?? null,
      rsi:           rsi?.value        ?? null,
      rsiZone:       rsi?.zone         ?? null,
      macdLine:      macd?.macd        ?? null,
      macdSignal:    macd?.signal      ?? null,
      macdHistogram: macd?.histogram   ?? null,
      macdCrossover: macd?.crossover   ?? null,
      macdBias:      macd?.bias        ?? null,
      atr:           vol.atr,
      adx:           regime.adx,
      marketRegime:  regime.regime,
      bbUpper:       bollinger?.upper     ?? null,
      bbLower:       bollinger?.lower     ?? null,
      bbMiddle:      bollinger?.middle    ?? null,
      bbBandwidth:   bollinger?.bandwidth ?? null,
      bbPercentB:    bollinger?.percentB  ?? null,
      macroEventIn4h,
      weightsVersion: activeWeights.version,
      // Full sub-score breakdown — consumed by CalibrationService + SelfOptimizer
      breakdown: {
        trendAlignment:     breakdown.trendAlignment,
        momentumStrength:   breakdown.momentumStrength,
        volatilityContext:  breakdown.volatilityContext,
        volumeConfirmation: breakdown.volumeConfirmation,
        macroAlignment:     breakdown.macroAlignment,
        sessionTiming:      breakdown.sessionTiming,
        structureAlignment: breakdown.structureAlignment,
        multiTimeframeAlignment: breakdown.multiTimeframeAlignment,
        correlationContext: breakdown.correlationContext,
      },
      structurePhase:  structure?.phase ?? null,
      structureEvents: structure?.recentEvents ?? [],
      multiTimeframe: {
        alignmentCount:      mtf.alignmentCount,
        dominantDirection:   mtf.dominantDirection,
        degradedTimeframes:  mtf.degradedTimeframes,
        perTimeframeScores:  mtf.timeframes,
      },
      correlation: {
        pairs:            correlation.pairs,
        dxyCorrelation:   correlation.dxyCorrelation,
        consistentCount:  correlation.consistentCount,
        usableCount:      correlation.usableCount,
        dataQuality:      correlation.dataQuality,
      },
    });

    return signal;
  }

  /** Returns true if persisted successfully, false on failure. */
  private async persist(signal: GeneratedSignal): Promise<boolean> {
    if (!this.db) return true;
    try {
      await this.db.olosSignal.create({
        data: {
          id:                  signal.id,
          userId:              PLATFORM_SIGNAL_USER_ID,
          symbol:              signal.symbol,
          timeframe:           signal.timeframe,
          signalType:          signal.signalType,
          confidence:          signal.confidence,
          setupPattern:        signal.setupPattern,
          setupDescription:    signal.entryRationale,
          confluenceFactors:   signal.confluenceFactors,
          confidenceBreakdown: signal.confidenceBreakdown,
          entryPrice:          signal.entryPrice,
          entryRationale:      signal.entryRationale,
          targetLevels:        signal.targetLevels,
          stopLoss:            signal.stopLoss,
          slRationale:         signal.slRationale,
          riskRewardRatio:     signal.riskRewardRatio,
          macroEvents:         [],
          marketRegime:        signal.marketRegime,
          volatilityLevel:     signal.volatilityLevel,
          expectedRiskPips:    0,
          marginRequirement:   0,
          liquidityProfile:    "balanced",
          status:              "ACTIVE",
        },
      });
      return true;
    } catch (err) {
      console.error("[signal-generator] DB persist failed — signal NOT dispatched:", err);
      return false;
    }
  }

  /**
   * Warm up all internal indicator engines for a symbol by replaying historical
   * candles. Must be called before the live tick loop starts. Without this,
   * EMA200 (which needs 200 bars) won't be ready for ~16 hours at 60s/tick.
   */
  seedEngines(symbol: string, candles: OHLCV[]): void {
    if (!candles.length) return;
    const eng = this.getEngines(symbol);

    for (const c of candles) {
      eng.ema50.next(c.close);
      eng.ema200.next(c.close);
      eng.rsi.next(c.close);
      eng.macd.next(c.close);
      eng.bollinger.next(c.close);
      eng.volatility.next(c);
      eng.regime.next(c, {});
      eng.structure.next(c);
      if (c.volume !== undefined) {
        eng.volumeHistory.push(c.volume);
        if (eng.volumeHistory.length > 20) eng.volumeHistory.shift();
      }
    }

    console.log(
      `[signal-generator] seeded ${symbol} with ${candles.length} historical candles — ` +
      `ema200.ready=${eng.ema200.ready}`,
    );
  }

  clearCooldown(symbol: string): void {
    this.cooldowns.delete(symbol);
  }
}

export default SignalGenerator;
