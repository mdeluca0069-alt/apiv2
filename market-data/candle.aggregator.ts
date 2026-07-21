import { eventBus } from "../events-bus/event.bus.js";

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * MARKET_DATA_FREEZE.md §0.4: true only for candles fabricated by
   * synthetic.seeder.ts's Box-Muller GBM placeholder generator at boot.
   * false/omitted for every real candle (live ticks via onTick(), or real
   * TwelveData history via historical.seeder.ts) -- so a consumer can
   * always tell whether the data underlying an indicator/dataQuality
   * verdict is real or fabricated, instead of the two being visually and
   * structurally identical.
   */
  synthetic?: boolean;
};

export type Timeframe = "1M" | "5M" | "15M" | "30M" | "1H" | "4H" | "1D";

const TF_SECONDS: Record<Timeframe, number> = {
  "1M":  60,
  "5M":  300,
  "15M": 900,
  "30M": 1800,
  "1H":  3600,
  "4H":  14400,
  "1D":  86400,
};

const MAX_CANDLES = 11_000;
const SUPPORTED_TIMEFRAMES = Object.keys(TF_SECONDS) as Timeframe[];

// candles[symbol][timeframe] = Candle[]
const _candles = new Map<string, Map<Timeframe, Candle[]>>();

// Current (open) candle per symbol per timeframe
const _current = new Map<string, Map<Timeframe, Candle>>();

function getOrCreate<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  if (!map.has(key)) map.set(key, init());
  return map.get(key)!;
}

function slotTime(nowSec: number, intervalSec: number): number {
  return Math.floor(nowSec / intervalSec) * intervalSec;
}

function onTick(symbol: string, mid: number, volumeEstimate: number, nowMs: number): void {
  const nowSec = Math.floor(nowMs / 1_000);

  for (const tf of SUPPORTED_TIMEFRAMES) {
    const intervalSec = TF_SECONDS[tf];
    const slot        = slotTime(nowSec, intervalSec);

    const symbolTfs    = getOrCreate(_candles,  symbol, () => new Map());
    const symbolCurr   = getOrCreate(_current,  symbol, () => new Map());
    const history      = getOrCreate(symbolTfs, tf,     () => []);

    const existing = symbolCurr.get(tf);

    if (!existing) {
      // First tick ever for this symbol+timeframe
      symbolCurr.set(tf, { time: slot, open: mid, high: mid, low: mid, close: mid, volume: volumeEstimate, synthetic: false });
      continue;
    }

    if (slot > existing.time) {
      // New candle period — commit the previous one to history
      history.push({ ...existing });
      if (history.length > MAX_CANDLES) history.splice(0, history.length - MAX_CANDLES);
      // Open the next candle using the previous close
      symbolCurr.set(tf, {
        time:   slot,
        open:   existing.close,
        high:   Math.max(existing.close, mid),
        low:    Math.min(existing.close, mid),
        close:  mid,
        volume: volumeEstimate,
        synthetic: false,
      });
    } else {
      // Still within the same candle period
      existing.high   = Math.max(existing.high,  mid);
      existing.low    = Math.min(existing.low,   mid);
      existing.close  = mid;
      existing.volume += volumeEstimate;
    }
  }
}

/**
 * Seeds historical candles for a specific symbol + timeframe.
 *
 * Called at boot by historical.seeder.ts (before live ticks arrive).
 * Will NOT overwrite an already-populated history — safe to call multiple times.
 *
 * @param symbol    - IGFX symbol (e.g. "EURUSD")
 * @param timeframe - Target timeframe (e.g. "1H")
 * @param candles   - Candles sorted ascending by time (oldest first)
 */
export function seedCandles(symbol: string, timeframe: Timeframe, candles: Candle[], force = false): void {
  if (!candles.length) return;

  const sym = symbol.toUpperCase();

  if (!SUPPORTED_TIMEFRAMES.includes(timeframe)) {
    console.warn(`[candle-aggregator] seedCandles: unsupported timeframe "${timeframe}" — skipping`);
    return;
  }

  const symbolTfs = getOrCreate(_candles, sym, () => new Map());
  const history   = getOrCreate(symbolTfs, timeframe, () => []);

  // Do not overwrite if already populated by live ticks, unless force=true
  // (used by TwelveData seeder to replace synthetic placeholder data).
  if (!force && history.length > 0) return;

  // Validate & deduplicate: keep only candles whose time aligns to the timeframe slot.
  const intervalSec = TF_SECONDS[timeframe];
  const seen        = new Set<number>();
  const aligned: Candle[] = [];

  for (const c of candles) {
    const slot = slotTime(c.time, intervalSec);
    if (slot !== c.time) continue; // misaligned — skip
    if (seen.has(c.time))  continue; // duplicate — skip
    seen.add(c.time);
    aligned.push(c);
  }

  // Candles are already ascending (oldest first from the REST client).
  history.push(...aligned);
  if (history.length > MAX_CANDLES) history.splice(0, history.length - MAX_CANDLES);
}

/**
 * Returns the completed candles + the current open candle for charting.
 * At most `limit` candles, newest-last (ascending time).
 */
export function getCandles(symbol: string, timeframe: Timeframe, limit = 200): Candle[] {
  const sym = symbol.toUpperCase().replace("-", "");
  const tf  = SUPPORTED_TIMEFRAMES.includes(timeframe as Timeframe)
    ? (timeframe as Timeframe)
    : "15M";

  const symbolTfs = _candles.get(sym);
  const history   = symbolTfs?.get(tf) ?? [];
  const current   = _current.get(sym)?.get(tf);

  // Slice down to what's needed BEFORE copying — history can hold up to
  // MAX_CANDLES (11,000) entries, and Phases 2/4 of the OLOS quant upgrade
  // call this far more often than before (per candidate signal, across 5
  // timeframes / multiple correlated instruments). Spreading the full
  // backing array on every call regardless of `limit` made that O(11,000)
  // instead of O(limit).
  const historySlots = current ? Math.max(0, limit - 1) : limit;
  const tail = historySlots > 0 ? history.slice(-historySlots) : [];

  const all = current ? [...tail, { ...current }] : [...tail];
  // Always return candles sorted ascending by time — LightweightCharts requires strict ASC order.
  return all.sort((a, b) => a.time - b.time);
}

// ─── Deterministic volume model ───────────────────────────────────────────────
// Average notional volume per minute by asset class (in instrument units).
// Session multiplier scales with UTC hour to reflect known liquidity patterns.
// No Math.random — deterministic given the same symbol + timestamp.

const BASE_VOLUME: Record<string, number> = {
  EURUSD: 150_000, GBPUSD: 80_000, USDJPY: 120_000,
  EURGBP:  30_000, AUDUSD:  40_000,
  XAUUSD:   3_000, WTI:      8_000, BRENT:   7_000,
  US500:    5_000, US100:    4_000, DE40:    3_000, UK100:   2_500,
  BTCUSD:      60, ETHUSD:     800,
  AAPL:     8_000, MSFT:    6_000, NVDA:    4_000, TSLA:    5_000, AMZN:    3_000,
};

const DEFAULT_VOLUME = 10_000;

/** Returns deterministic volume estimate for a symbol at a given UTC hour. */
function deterministicVolume(symbol: string, utcHour: number): number {
  const base = BASE_VOLUME[symbol.toUpperCase()] ?? DEFAULT_VOLUME;

  // Session multiplier: mirrors real intraday volume patterns.
  let multiplier: number;
  if (utcHour >= 13 && utcHour <= 17) multiplier = 1.40; // London/NY overlap — peak
  else if (utcHour >= 8  && utcHour <= 12) multiplier = 1.10; // London open
  else if (utcHour >= 18 && utcHour <= 21) multiplier = 0.90; // NY afternoon
  else if (utcHour >= 0  && utcHour <= 3)  multiplier = 0.60; // Asian session
  else multiplier = 0.45;                                       // dead zone

  return Math.round(base * multiplier);
}

/** Wire into the event bus so every quoteCache.set() tick updates OHLCV. */
export function startCandleAggregator(): void {
  eventBus.on("market.quote", (event) => {
    const e = event as {
      symbol: string;
      mid: number;
      bid?: number;
      ask?: number;
      timestamp?: string;
    };
    if (!e?.symbol || !e.mid) return;
    const utcHour        = new Date().getUTCHours();
    const volumeEstimate = deterministicVolume(e.symbol, utcHour);
    onTick(e.symbol, e.mid, volumeEstimate, Date.now());
  });

  console.log("[candle-aggregator] started — aggregating OHLCV for all timeframes");
}
