import type { OHLCV } from "../ai-core/volatility.engine.js";

export type SwingType = "HH" | "HL" | "LH" | "LL";

export type SwingPoint = {
  index: number;
  time: number;
  price: number;
  type: SwingType;
};

export type StructureEventType = "BOS_BULLISH" | "BOS_BEARISH" | "CHOCH_BULLISH" | "CHOCH_BEARISH";

export type StructureEvent = {
  type: StructureEventType;
  time: number;
  brokenLevel: number;
  brokenSwing: SwingPoint;
  confidence: number;
};

export type StructurePhase =
  | "ACCUMULATION" | "DISTRIBUTION" | "EXPANSION" | "RANGE"
  | "TRENDING_UP" | "TRENDING_DOWN" | "UNDEFINED";

export type StructureContext = {
  /** True when ATR is expanding (from VolatilityEngine.expanding) — used to tell EXPANSION apart from a plain trend. */
  atrExpanding?: boolean;
};

// ── Smart Money Concepts (SMC / ICT methodology) — standard textbook definitions ──

export type LiquiditySweep = {
  type: "SWEEP_HIGH" | "SWEEP_LOW";
  time: number;
  sweptLevel: number;
  sweptSwing: SwingPoint;
  reversalConfirmed: boolean;
};

export type EqualLevel = {
  type: "EQH" | "EQL";
  time: number;
  price: number;
  touches: number[];
  tolerancePct: number;
};

export type OrderBlock = {
  type: "BULLISH_OB" | "BEARISH_OB";
  time: number;
  high: number;
  low: number;
  originIndex: number;
  mitigated: boolean;
  breaker: boolean;
};

export type MitigationBlock = {
  time: number;
  high: number;
  low: number;
  originIndex: number;
  side: "BULLISH" | "BEARISH";
};

export type FairValueGap = {
  type: "BULLISH_FVG" | "BEARISH_FVG";
  time: number;
  gapHigh: number;
  gapLow: number;
  filledPct: number;
  filled: boolean;
};

export type PremiumDiscountZone = {
  rangeHigh: number;
  rangeLow: number;
  equilibrium: number;
  currentZone: "PREMIUM" | "DISCOUNT" | "EQUILIBRIUM";
  pricePositionPct: number;
};

export type SmcContext = {
  sweeps: LiquiditySweep[];
  equalHighs: EqualLevel[];
  equalLows: EqualLevel[];
  orderBlocks: OrderBlock[];
  mitigationBlocks: MitigationBlock[];
  fairValueGaps: FairValueGap[];
  premiumDiscount: PremiumDiscountZone | null;
};

export type StructureResult = {
  phase: StructurePhase;
  lastSwings: SwingPoint[];
  recentEvents: StructureEvent[];
  structureScore: number;
  bullishStructure: boolean;
  bearishStructure: boolean;
  rangeBoundPct: number;
  ready: boolean;
  /** Additive — Smart Money Concepts detail. Optional so existing destructuring callers are unaffected. */
  smc?: SmcContext;
};

const MAX_SWING_TYPE_HISTORY = 4;
const RECENT_EVENT_WINDOW    = 3;
const EQUAL_LEVEL_TOLERANCE_PCT = 0.05; // 0.05% — standard SMC "near-equal" tolerance
const SWEEP_REVERSAL_WINDOW = 3;        // bars within which a sweep's reversal must confirm

export class MarketStructureEngine {
  private buffer: OHLCV[] = [];
  private candleIndex = -1;

  private swings: SwingPoint[] = [];
  private recentHighTypes: ("HH" | "LH")[] = [];
  private recentLowTypes:  ("HL" | "LL")[] = [];

  private lastSwingHigh: SwingPoint | null = null;
  private lastSwingLow:  SwingPoint | null = null;
  private highBrokenAt: number | null = null;
  private lowBrokenAt:  number | null = null;

  private trendBias: "UP" | "DOWN" | "NONE" = "NONE";
  private events: StructureEvent[] = [];

  private lastClose: number | null = null;
  private sweepsInternal: (LiquiditySweep & { originIndex: number })[] = [];
  private orderBlocks: OrderBlock[] = [];
  private mitigationBlocks: MitigationBlock[] = [];
  private fvgList: FairValueGap[] = [];

  constructor(
    private readonly swingLookback = 5,
    private readonly maxSwingHistory = 50,
  ) {}

  /**
   * Feed one candle. Swing highs/lows are fractal-confirmed with a lag of
   * `swingLookback` bars — a swing at index i is only known once i+swingLookback
   * bars have printed, so the most recent `swingLookback` candles never produce
   * a swing yet. Returns a not-ready result (never throws) until at least one
   * swing (high or low) has been confirmed.
   */
  next(candle: OHLCV, context: StructureContext = {}): StructureResult {
    this.candleIndex++;
    this.buffer.push(candle);
    const bufferCap = this.swingLookback * 2 + 2;
    if (this.buffer.length > bufferCap) this.buffer.shift();

    this._detectSwing();
    this._detectSweep(candle);
    this._detectBreak(candle);
    this._detectFairValueGap();
    this._updateOrderBlockMitigation(candle);
    this.lastClose = candle.close;

    if (this.swings.length === 0) {
      return { ...this._neutralResult(), ready: false };
    }

    return this._buildResult(context);
  }

  get ready(): boolean {
    return this.swings.length > 0;
  }

  reset(): void {
    this.buffer = [];
    this.candleIndex = -1;
    this.swings = [];
    this.recentHighTypes = [];
    this.recentLowTypes  = [];
    this.lastSwingHigh = null;
    this.lastSwingLow  = null;
    this.highBrokenAt = null;
    this.lowBrokenAt  = null;
    this.trendBias = "NONE";
    this.events = [];

    this.lastClose = null;
    this.sweepsInternal = [];
    this.orderBlocks = [];
    this.mitigationBlocks = [];
    this.fvgList = [];
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private _detectSwing(): void {
    const len = this.buffer.length;
    const candidateOffset = len - 1 - this.swingLookback;
    if (candidateOffset < this.swingLookback) return; // not enough left-side bars yet

    const windowStart = candidateOffset - this.swingLookback;
    const window = this.buffer.slice(windowStart, len);
    const candidate = this.buffer[candidateOffset];
    const candidateAbsIndex = this.candleIndex - (len - 1 - candidateOffset);

    const isSwingHigh = window.every((c) => c.high <= candidate.high);
    const isSwingLow  = window.every((c) => c.low  >= candidate.low);

    if (isSwingHigh) {
      const type: "HH" | "LH" = !this.lastSwingHigh || candidate.high > this.lastSwingHigh.price ? "HH" : "LH";
      const swing: SwingPoint = { index: candidateAbsIndex, time: candidate.timestamp ? Date.parse(candidate.timestamp) / 1000 : candidateAbsIndex, price: candidate.high, type };
      this._pushSwing(swing);
      this.lastSwingHigh = swing;
      this.highBrokenAt = null;
      this._pushTypeHistory(this.recentHighTypes, type);
    }

    if (isSwingLow) {
      const type: "HL" | "LL" = !this.lastSwingLow || candidate.low < this.lastSwingLow.price ? "LL" : "HL";
      const swing: SwingPoint = { index: candidateAbsIndex, time: candidate.timestamp ? Date.parse(candidate.timestamp) / 1000 : candidateAbsIndex, price: candidate.low, type };
      this._pushSwing(swing);
      this.lastSwingLow = swing;
      this.lowBrokenAt = null;
      this._pushTypeHistory(this.recentLowTypes, type);
    }

    this._updateTrendBias();
  }

  private _pushSwing(swing: SwingPoint): void {
    this.swings.push(swing);
    if (this.swings.length > this.maxSwingHistory) this.swings.shift();
  }

  private _pushTypeHistory<T>(arr: T[], type: T): void {
    arr.push(type);
    if (arr.length > MAX_SWING_TYPE_HISTORY) arr.shift();
  }

  private _updateTrendBias(): void {
    const lastHigh = this.recentHighTypes[this.recentHighTypes.length - 1];
    const lastLow  = this.recentLowTypes[this.recentLowTypes.length - 1];
    if (lastHigh === "HH" && lastLow === "HL") this.trendBias = "UP";
    else if (lastHigh === "LH" && lastLow === "LL") this.trendBias = "DOWN";
  }

  private _detectBreak(candle: OHLCV): void {
    const time = candle.timestamp ? Date.parse(candle.timestamp) / 1000 : this.candleIndex;

    if (this.lastSwingHigh && candle.close > this.lastSwingHigh.price && this.highBrokenAt !== this.lastSwingHigh.price) {
      const bullish = this.trendBias !== "DOWN";
      const type: StructureEventType = bullish ? "BOS_BULLISH" : "CHOCH_BULLISH";
      this._emitEvent(type, time, this.lastSwingHigh, candle.close);
      this._recordBlockOnBreak(type, time);
      this.highBrokenAt = this.lastSwingHigh.price;
      this.trendBias = "UP";
    }

    if (this.lastSwingLow && candle.close < this.lastSwingLow.price && this.lowBrokenAt !== this.lastSwingLow.price) {
      const bearish = this.trendBias !== "UP";
      const type: StructureEventType = bearish ? "BOS_BEARISH" : "CHOCH_BEARISH";
      this._emitEvent(type, time, this.lastSwingLow, candle.close);
      this._recordBlockOnBreak(type, time);
      this.lowBrokenAt = this.lastSwingLow.price;
      this.trendBias = "DOWN";
    }
  }

  /**
   * Liquidity Sweep — a wick pierces beyond the last swing high/low but the
   * close stays back inside it (a genuine BOS/CHoCH instead requires the
   * *close* to clear the level). Tracked separately from `_detectBreak`,
   * which only fires on close-confirmed breaks.
   */
  private _detectSweep(candle: OHLCV): void {
    const time = candle.timestamp ? Date.parse(candle.timestamp) / 1000 : this.candleIndex;

    if (this.lastSwingHigh && candle.high > this.lastSwingHigh.price && candle.close <= this.lastSwingHigh.price) {
      this._pushSweep({
        type: "SWEEP_HIGH", time, sweptLevel: this.lastSwingHigh.price,
        sweptSwing: this.lastSwingHigh, reversalConfirmed: false, originIndex: this.candleIndex,
      });
    }

    if (this.lastSwingLow && candle.low < this.lastSwingLow.price && candle.close >= this.lastSwingLow.price) {
      this._pushSweep({
        type: "SWEEP_LOW", time, sweptLevel: this.lastSwingLow.price,
        sweptSwing: this.lastSwingLow, reversalConfirmed: false, originIndex: this.candleIndex,
      });
    }

    // Confirm reversal on a *later* candle than the sweep itself (a sweep's
    // own close already sits back inside the level by definition — that
    // alone isn't confirmation; a subsequent candle continuing the reversal is).
    for (const sweep of this.sweepsInternal) {
      if (sweep.reversalConfirmed) continue;
      if (this.candleIndex <= sweep.originIndex) continue;
      if (this.candleIndex - sweep.originIndex > SWEEP_REVERSAL_WINDOW) continue;
      if (sweep.type === "SWEEP_HIGH" && candle.close < sweep.sweptLevel) sweep.reversalConfirmed = true;
      if (sweep.type === "SWEEP_LOW" && candle.close > sweep.sweptLevel) sweep.reversalConfirmed = true;
    }
  }

  private _pushSweep(sweep: LiquiditySweep & { originIndex: number }): void {
    this.sweepsInternal.push(sweep);
    if (this.sweepsInternal.length > this.maxSwingHistory) this.sweepsInternal.shift();
  }

  /**
   * Order Block (before a BOS — continuation) / Mitigation Block (before a
   * CHoCH — reversal): the last opposite-colored candle in the buffer right
   * before the breakout candle, per the standard SMC/ICT definition.
   */
  private _recordBlockOnBreak(type: StructureEventType, time: number): void {
    const bullishBreak = type === "BOS_BULLISH" || type === "CHOCH_BULLISH";
    // buffer's last entry is the breakout candle itself; search backwards from before it.
    for (let i = this.buffer.length - 2; i >= 0; i--) {
      const c = this.buffer[i];
      const isBearishCandle = c.close < c.open;
      const isBullishCandle = c.close > c.open;
      const opposes = bullishBreak ? isBearishCandle : isBullishCandle;
      if (!opposes) continue;

      const originIndex = this.candleIndex - (this.buffer.length - 1 - i);
      if (type === "BOS_BULLISH" || type === "BOS_BEARISH") {
        this._pushOrderBlock({
          type: bullishBreak ? "BULLISH_OB" : "BEARISH_OB",
          time, high: c.high, low: c.low, originIndex, mitigated: false, breaker: false,
        });
      } else {
        this._pushMitigationBlock({
          time, high: c.high, low: c.low, originIndex, side: bullishBreak ? "BULLISH" : "BEARISH",
        });
      }
      return;
    }
  }

  private _pushOrderBlock(ob: OrderBlock): void {
    this.orderBlocks.push(ob);
    if (this.orderBlocks.length > this.maxSwingHistory) this.orderBlocks.shift();
  }

  private _pushMitigationBlock(mb: MitigationBlock): void {
    this.mitigationBlocks.push(mb);
    if (this.mitigationBlocks.length > this.maxSwingHistory) this.mitigationBlocks.shift();
  }

  /** Marks Order Blocks mitigated once price returns into them, and flags Breaker Blocks once a mitigated OB is fully broken through in the original breakout direction. */
  private _updateOrderBlockMitigation(candle: OHLCV): void {
    for (const ob of this.orderBlocks) {
      if (!ob.mitigated && candle.low <= ob.high && candle.high >= ob.low) {
        ob.mitigated = true;
      }
      if (ob.mitigated && !ob.breaker) {
        if (ob.type === "BULLISH_OB" && candle.close < ob.low) ob.breaker = true;
        if (ob.type === "BEARISH_OB" && candle.close > ob.high) ob.breaker = true;
      }
    }
  }

  /**
   * Fair Value Gap — classic 3-candle imbalance: the high of candle[i-1] sits
   * below the low of candle[i+1] (bullish FVG), or the mirror (bearish FVG).
   */
  private _detectFairValueGap(): void {
    const len = this.buffer.length;
    if (len >= 3) {
      const left = this.buffer[len - 3];
      const right = this.buffer[len - 1];
      const time = right.timestamp ? Date.parse(right.timestamp) / 1000 : this.candleIndex;

      if (left.high < right.low) {
        this._pushFvg({ type: "BULLISH_FVG", time, gapHigh: right.low, gapLow: left.high, filledPct: 0, filled: false });
      } else if (left.low > right.high) {
        this._pushFvg({ type: "BEARISH_FVG", time, gapHigh: left.low, gapLow: right.high, filledPct: 0, filled: false });
      }
    }

    // Update fill progress on existing unfilled gaps using the latest candle.
    const latest = this.buffer[len - 1];
    for (const gap of this.fvgList) {
      if (gap.filled) continue;
      const overlapHigh = Math.min(gap.gapHigh, latest.high);
      const overlapLow = Math.max(gap.gapLow, latest.low);
      const overlap = Math.max(0, overlapHigh - overlapLow);
      const gapSize = gap.gapHigh - gap.gapLow;
      const pct = gapSize > 0 ? Math.min(100, Math.round((overlap / gapSize) * 100)) : 100;
      gap.filledPct = Math.max(gap.filledPct, pct);
      if (gap.filledPct >= 100) gap.filled = true;
    }
  }

  private _pushFvg(fvg: FairValueGap): void {
    this.fvgList.push(fvg);
    if (this.fvgList.length > this.maxSwingHistory) this.fvgList.shift();
  }

  /** Equal High/Low — two or more swing points of the same kind within a small tolerance. */
  private _computeEqualLevels(kind: "HIGH" | "LOW"): EqualLevel[] {
    const wantTypes: SwingType[] = kind === "HIGH" ? ["HH", "LH"] : ["HL", "LL"];
    const candidates = this.swings
      .map((s, idx) => ({ s, idx }))
      .filter(({ s }) => wantTypes.includes(s.type));

    const levels: EqualLevel[] = [];
    const used = new Set<number>();
    for (let i = 0; i < candidates.length; i++) {
      if (used.has(i)) continue;
      const group = [candidates[i]];
      for (let j = i + 1; j < candidates.length; j++) {
        if (used.has(j)) continue;
        const pctDiff = Math.abs(candidates[j].s.price - candidates[i].s.price) / candidates[i].s.price * 100;
        if (pctDiff <= EQUAL_LEVEL_TOLERANCE_PCT) group.push(candidates[j]);
      }
      if (group.length >= 2) {
        group.forEach(({ idx }) => used.add(idx));
        const avgPrice = group.reduce((sum, g) => sum + g.s.price, 0) / group.length;
        levels.push({
          type: kind === "HIGH" ? "EQH" : "EQL",
          time: group[group.length - 1].s.time,
          price: avgPrice,
          touches: group.map((g) => g.s.index),
          tolerancePct: EQUAL_LEVEL_TOLERANCE_PCT,
        });
      }
    }
    return levels;
  }

  /** Premium/Discount zone — pure derived split of the current swing range at its midpoint. */
  private _premiumDiscountZone(): PremiumDiscountZone | null {
    if (!this.lastSwingHigh || !this.lastSwingLow || this.lastClose === null) return null;
    const rangeHigh = this.lastSwingHigh.price;
    const rangeLow = this.lastSwingLow.price;
    if (rangeHigh <= rangeLow) return null;

    const equilibrium = (rangeHigh + rangeLow) / 2;
    const pricePositionPct = Math.max(0, Math.min(100, ((this.lastClose - rangeLow) / (rangeHigh - rangeLow)) * 100));
    const currentZone: PremiumDiscountZone["currentZone"] =
      this.lastClose > equilibrium ? "PREMIUM" : this.lastClose < equilibrium ? "DISCOUNT" : "EQUILIBRIUM";

    return { rangeHigh, rangeLow, equilibrium, currentZone, pricePositionPct };
  }

  private _buildSmcContext(): SmcContext {
    return {
      sweeps: this.sweepsInternal.map(({ originIndex, ...rest }) => rest),
      equalHighs: this._computeEqualLevels("HIGH"),
      equalLows: this._computeEqualLevels("LOW"),
      orderBlocks: [...this.orderBlocks],
      mitigationBlocks: [...this.mitigationBlocks],
      fairValueGaps: [...this.fvgList],
      premiumDiscount: this._premiumDiscountZone(),
    };
  }

  private _emitEvent(type: StructureEventType, time: number, brokenSwing: SwingPoint, closePrice: number): void {
    const confidence = Math.min(100, Math.round((Math.abs(closePrice - brokenSwing.price) / brokenSwing.price) * 10_000));
    this.events.push({ type, time, brokenLevel: brokenSwing.price, brokenSwing, confidence });
    if (this.events.length > this.maxSwingHistory) this.events.shift();
  }

  /**
   * Looks only at the last 2 swings of each kind — the very first swing high/low
   * ever seen has no prior reference and is bootstrapped as HH/LL by convention,
   * which would otherwise permanently poison a longer staircase check.
   */
  private _isStaircase(direction: "UP" | "DOWN"): boolean {
    const wantHigh: SwingType = direction === "UP" ? "HH" : "LH";
    const wantLow:  SwingType = direction === "UP" ? "HL" : "LL";
    const highs = this.recentHighTypes.slice(-2);
    const lows  = this.recentLowTypes.slice(-2);
    if (highs.length < 2 || lows.length < 2) return false;
    return highs.every((t) => t === wantHigh) && lows.every((t) => t === wantLow);
  }

  private _rangeBoundPct(): number {
    if (this.recentHighTypes.length < 2 || this.recentLowTypes.length < 2) return 50;
    if (this._isStaircase("UP") || this._isStaircase("DOWN")) return 10;
    return 75;
  }

  private _phase(context: StructureContext): StructurePhase {
    if (this.recentHighTypes.length < 2 || this.recentLowTypes.length < 2) return "UNDEFINED";

    if (this._isStaircase("UP")) return context.atrExpanding ? "EXPANSION" : "TRENDING_UP";
    if (this._isStaircase("DOWN")) return context.atrExpanding ? "EXPANSION" : "TRENDING_DOWN";

    const lastEvent = this.events[this.events.length - 1];
    if (lastEvent?.type === "BOS_BULLISH") return "ACCUMULATION";
    if (lastEvent?.type === "BOS_BEARISH") return "DISTRIBUTION";
    return "RANGE";
  }

  private _recentEvents(): StructureEvent[] {
    return this.events.slice(-RECENT_EVENT_WINDOW);
  }

  /** Probabilistic contribution of structure to a candidate signal's confidence — 0-100, 50 = neutral. */
  structureScoreFor(signalSide: "BUY" | "SELL"): number {
    const bullish = this.trendBias === "UP";
    const bearish = this.trendBias === "DOWN";
    const recent = this._recentEvents();

    let score = 50;
    const aligned = (signalSide === "BUY" && bullish) || (signalSide === "SELL" && bearish);
    if (aligned) score += 25;

    const sameDirBOS = recent.some((e) => e.type === (signalSide === "BUY" ? "BOS_BULLISH" : "BOS_BEARISH"));
    if (sameDirBOS) score += 15;

    const contradictingCHoCH = recent.some((e) => e.type === (signalSide === "BUY" ? "CHOCH_BEARISH" : "CHOCH_BULLISH"));
    if (contradictingCHoCH) score -= 30;

    // SMC contribution — small and additive, never enough alone to push the
    // score out of the [0,100] range this method already guarantees.
    if (this._sweepFavorsSide(signalSide)) score += 8;
    if (signalSide === "BUY" && this._inDiscountZone()) score += 5;
    if (signalSide === "SELL" && this._inPremiumZone()) score += 5;
    if (this._unfilledFvgFavorsSide(signalSide)) score += 4;

    return Math.max(0, Math.min(100, score));
  }

  private _sweepFavorsSide(signalSide: "BUY" | "SELL"): boolean {
    const recentSweep = this.sweepsInternal[this.sweepsInternal.length - 1];
    if (!recentSweep || this.candleIndex - recentSweep.originIndex > SWEEP_REVERSAL_WINDOW) return false;
    if (signalSide === "BUY") return recentSweep.type === "SWEEP_LOW";
    return recentSweep.type === "SWEEP_HIGH";
  }

  private _inDiscountZone(): boolean {
    return this._premiumDiscountZone()?.currentZone === "DISCOUNT";
  }

  private _inPremiumZone(): boolean {
    return this._premiumDiscountZone()?.currentZone === "PREMIUM";
  }

  private _unfilledFvgFavorsSide(signalSide: "BUY" | "SELL"): boolean {
    const wantType = signalSide === "BUY" ? "BULLISH_FVG" : "BEARISH_FVG";
    return this.fvgList.some((g) => !g.filled && g.type === wantType);
  }

  private _neutralResult(): Omit<StructureResult, "ready"> {
    return {
      phase: "UNDEFINED",
      lastSwings: [],
      recentEvents: [],
      structureScore: 50,
      bullishStructure: false,
      bearishStructure: false,
      rangeBoundPct: 50,
      // Sweep/FVG detection runs independently of swing confirmation, so the
      // neutral (pre-first-swing) result still surfaces real SMC data instead
      // of discarding it behind a hardcoded empty placeholder.
      smc: this._buildSmcContext(),
    };
  }

  private _buildResult(context: StructureContext): StructureResult {
    return {
      phase: this._phase(context),
      lastSwings: this.swings.slice(-MAX_SWING_TYPE_HISTORY * 2),
      recentEvents: this._recentEvents(),
      structureScore: 50,
      bullishStructure: this.trendBias === "UP",
      bearishStructure: this.trendBias === "DOWN",
      rangeBoundPct: this._rangeBoundPct(),
      ready: true,
      smc: this._buildSmcContext(),
    };
  }
}

export default MarketStructureEngine;
