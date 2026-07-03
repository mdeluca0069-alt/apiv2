/**
 * SyntheticSeeder — generates realistic-looking historical OHLCV candles
 * at startup so charts have data immediately, before TwelveData responds.
 *
 * TwelveData's historical.seeder runs shortly after and overwrites these
 * with real market data (force=true).  The synthetic data is only a visual
 * placeholder — it is never used for trading or P&L calculations.
 */

import { seedCandles } from "./candle.aggregator.js";
import type { Candle, Timeframe } from "./candle.aggregator.js";

// ── Constants (mirror pricing.engine.ts) ────────────────────────────────────

// 252 trading days × 23 h open × 3600 s
const TRADING_SECONDS_PER_YEAR = 252 * 23 * 3600;

const SIGMA: Record<string, number> = {
  FX_MAJOR:  0.070,
  FX_MINOR:  0.095,
  INDEX:     0.180,
  COMMODITY: 0.220,
  EQUITY:    0.280,
  CRYPTO:    0.750,
};

// ── Instrument definitions ────────────────────────────────────────────────────

interface SymbolDef {
  symbol:     string;
  basePrice:  number;
  assetClass: string;
  precision:  number;   // decimal places for output
}

const SYMBOLS: SymbolDef[] = [
  { symbol: "EURUSD", basePrice: 1.16301, assetClass: "FX_MAJOR",  precision: 5 },
  { symbol: "GBPUSD", basePrice: 1.34617, assetClass: "FX_MAJOR",  precision: 5 },
  { symbol: "USDJPY", basePrice: 159.914, assetClass: "FX_MAJOR",  precision: 3 },
  { symbol: "EURGBP", basePrice: 0.86402, assetClass: "FX_MINOR",  precision: 5 },
  { symbol: "AUDUSD", basePrice: 0.71738, assetClass: "FX_MINOR",  precision: 5 },
  { symbol: "XAUUSD", basePrice: 2364.40, assetClass: "COMMODITY", precision: 2 },
  { symbol: "US500",  basePrice: 5288.50, assetClass: "INDEX",     precision: 2 },
  { symbol: "US100",  basePrice: 18420.2, assetClass: "INDEX",     precision: 2 },
  { symbol: "DE40",   basePrice: 18490.5, assetClass: "INDEX",     precision: 2 },
  { symbol: "UK100",  basePrice: 8440.80, assetClass: "INDEX",     precision: 2 },
  { symbol: "WTI",    basePrice: 78.35,   assetClass: "COMMODITY", precision: 2 },
  { symbol: "BRENT",  basePrice: 82.60,   assetClass: "COMMODITY", precision: 2 },
  { symbol: "BTCUSD", basePrice: 67650.0, assetClass: "CRYPTO",    precision: 2 },
  { symbol: "ETHUSD", basePrice: 3560.00, assetClass: "CRYPTO",    precision: 2 },
  { symbol: "AAPL",   basePrice: 194.20,  assetClass: "EQUITY",    precision: 2 },
  { symbol: "MSFT",   basePrice: 424.60,  assetClass: "EQUITY",    precision: 2 },
  { symbol: "NVDA",   basePrice: 948.40,  assetClass: "EQUITY",    precision: 2 },
  { symbol: "TSLA",   basePrice: 181.80,  assetClass: "EQUITY",    precision: 2 },
  { symbol: "AMZN",   basePrice: 185.50,  assetClass: "EQUITY",    precision: 2 },
];

// Timeframe → [intervalSec, candleCount]
// 5-year history: 1D×1825, 4H×10950, 1H×43800 (but capped), etc.
// FX trades 24h/5d, so skip weekends in generation.
const TIMEFRAMES: [Timeframe, number, number][] = [
  ["1M",  60,      1440],   // 1 day   of 1M
  ["5M",  300,     2016],   // 1 week  of 5M
  ["15M", 900,     6720],   // ~7 weeks of 15M
  ["30M", 1800,    8760],   // ~6 months of 30M
  ["1H",  3600,    8760],   // 1 year  of 1H
  ["4H",  14400,   10950],  // 5 years of 4H
  ["1D",  86400,   1825],   // 5 years of 1D
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Box-Muller: one standard-normal sample. */
function randN(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Typical average daily volume by asset class (in units of the base currency)
function baseVolume(assetClass: string): number {
  switch (assetClass) {
    case "FX_MAJOR":  return 5_000_000;
    case "FX_MINOR":  return 2_000_000;
    case "INDEX":     return 300_000;
    case "COMMODITY": return 500_000;
    case "EQUITY":    return 10_000_000;
    case "CRYPTO":    return 1_000_000;
    default:          return 1_000_000;
  }
}

// ── Core generator ────────────────────────────────────────────────────────────

function generateCandles(
  def:         SymbolDef,
  intervalSec: number,
  count:       number,
): Candle[] {
  const sigma         = SIGMA[def.assetClass] ?? 0.12;
  const dt            = intervalSec / TRADING_SECONDS_PER_YEAR;
  const sigmaPerCandle = sigma * Math.sqrt(dt);
  const volBase       = baseVolume(def.assetClass);
  const prec          = def.precision;

  const nowSec    = Math.floor(Date.now() / 1_000);
  const latestSlot = Math.floor(nowSec / intervalSec) * intervalSec;

  // ── Reverse-walk with soft mean-reversion ────────────────────────────────
  // Pure GBM over 5 years can drift to unrealistic prices.
  // We blend each backward step with a small pull toward basePrice so the
  // simulated history stays in a realistic band around the anchor.
  const PULL: Record<string, number> = {
    FX_MAJOR: 0.015, FX_MINOR: 0.012,
    INDEX: 0.008, COMMODITY: 0.010, EQUITY: 0.006, CRYPTO: 0.003,
  };
  const pull = PULL[def.assetClass] ?? 0.010;  // fraction pulled per candle
  const reversedCandles: Candle[] = [];
  let price = def.basePrice;

  for (let i = 0; i < count; i++) {
    const candleTime = latestSlot - (i + 1) * intervalSec;

    // Pure GBM step backward, then blend slightly toward basePrice.
    // Blend prevents multi-year drift without log-space explosion.
    const rawOpen = price * Math.exp(-(sigmaPerCandle * randN()));
    const open    = Math.max(
      rawOpen * (1 - pull) + def.basePrice * pull,
      def.basePrice * 0.20,   // hard floor: never below 20% of base
    );

    const candleOpen  = Number(open.toFixed(prec));
    const candleClose = Number(price.toFixed(prec));

    const bodyMax = Math.max(candleOpen, candleClose);
    const bodyMin = Math.min(candleOpen, candleClose);
    const bodyRange = Math.max(bodyMax - bodyMin, def.basePrice * sigmaPerCandle * 0.2);

    // Wicks: 20–100% of body range, log-normal distributed (small wicks common)
    const upperWick = bodyRange * (0.1 + Math.abs(randN()) * 0.4);
    const lowerWick = bodyRange * (0.1 + Math.abs(randN()) * 0.4);

    // Volume: normally distributed around base, scaled by timeframe
    const tfMultiplier = intervalSec / 3600;   // normalised to 1H
    const vol = Math.max(
      volBase * tfMultiplier * (0.4 + Math.random() * 1.2),
      1
    );

    reversedCandles.push({
      time:   candleTime,
      open:   candleOpen,
      high:   Number((bodyMax + upperWick).toFixed(prec)),
      low:    Number((bodyMin - lowerWick).toFixed(prec)),
      close:  candleClose,
      volume: Math.round(vol),
    });

    price = open; // step backwards
  }

  // Reverse so oldest candle comes first (ascending time)
  return reversedCandles.reverse();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Immediately seed realistic synthetic candles for all symbols / timeframes.
 * Runs synchronously so charts have data on the very first HTTP request.
 *
 * TwelveData's historical.seeder will later overwrite these with real data
 * (using force=true) without disrupting live ticks.
 */
export function seedSyntheticCandles(): void {
  let total = 0;

  for (const def of SYMBOLS) {
    for (const [tf, intervalSec, count] of TIMEFRAMES) {
      const candles = generateCandles(def, intervalSec, count);
      seedCandles(def.symbol, tf, candles);
      total += candles.length;
    }
  }

  console.log(
    `[synthetic-seeder] seeded ${total.toLocaleString()} placeholder candles ` +
    `(${SYMBOLS.length} symbols × ${TIMEFRAMES.length} timeframes) — ` +
    `TwelveData data will replace these shortly`
  );
}
