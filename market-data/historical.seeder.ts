import { fetchHistoricalCandles } from "./feeds/twelvedata.rest.js";
import { seedCandles }            from "./candle.aggregator.js";
import type { Timeframe }         from "./candle.aggregator.js";

// ─── Symbol mapping: IGFX → TwelveData ───────────────────────────────────────

interface SymbolEntry {
  igfx:      string;
  td:        string;
  exchange?: string;
}

const SYMBOLS: SymbolEntry[] = [
  // Forex
  { igfx: "EURUSD",  td: "EUR/USD" },
  { igfx: "GBPUSD",  td: "GBP/USD" },
  { igfx: "USDJPY",  td: "USD/JPY" },
  { igfx: "EURGBP",  td: "EUR/GBP" },
  { igfx: "AUDUSD",  td: "AUD/USD" },
  // Metals
  { igfx: "XAUUSD",  td: "XAU/USD" },
  // Indices
  { igfx: "US500",   td: "SPX",        exchange: "ICAP" },
  { igfx: "US100",   td: "NDX",        exchange: "NASDAQ" },
  { igfx: "DE40",    td: "DAX" },
  { igfx: "UK100",   td: "FTSE",       exchange: "LSE" },
  // Commodities / Energy
  { igfx: "WTI",     td: "WTI/USD" },
  { igfx: "BRENT",   td: "BRENT/USD" },
  // Crypto
  { igfx: "BTCUSD",  td: "BTC/USD" },
  { igfx: "ETHUSD",  td: "ETH/USD" },
  // US Equities
  { igfx: "AAPL",    td: "AAPL" },
  { igfx: "MSFT",    td: "MSFT" },
  { igfx: "NVDA",    td: "NVDA" },
  { igfx: "TSLA",    td: "TSLA" },
  { igfx: "AMZN",    td: "AMZN" },
];

// ─── Timeframe mapping: IGFX → TwelveData interval ───────────────────────────

interface TimeframeEntry {
  igfx:       Timeframe;
  td:         string;
  outputSize: number;
}

const TIMEFRAMES: TimeframeEntry[] = [
  { igfx: "1M",  td: "1min",  outputSize: 500  },
  { igfx: "5M",  td: "5min",  outputSize: 1000 },
  { igfx: "15M", td: "15min", outputSize: 1000 },
  { igfx: "30M", td: "30min", outputSize: 1000 },
  { igfx: "1H",  td: "1h",    outputSize: 2000 },
  { igfx: "4H",  td: "4h",    outputSize: 2000 },
  { igfx: "1D",  td: "1day",  outputSize: 1825 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Sleep for `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main seeder ──────────────────────────────────────────────────────────────

/**
 * Seeds historical OHLCV candles for all IGFX instruments and timeframes
 * using the TwelveData REST /time_series endpoint.
 *
 * Rate-limit: TwelveData paid plan (Starter $29/mo+) → 800 req/min ≈ 13 req/s.
 * We use a 130ms inter-request delay (~7.7 req/s) for safe headroom.
 *
 * This function is intentionally non-blocking from the caller's perspective —
 * it should be awaited inside a `.catch()`-wrapped async IIFE.
 */
export async function seedHistoricalCandles(apiKey: string): Promise<void> {
  if (!apiKey) {
    console.warn("[seeder] TWELVEDATA_API_KEY not set — skipping historical seed");
    return;
  }

  console.log(
    `[seeder] starting historical candle seed — ${SYMBOLS.length} symbols × ${TIMEFRAMES.length} timeframes`,
  );

  let totalSeeded = 0;
  let totalErrors = 0;

  for (const sym of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      // Build the TwelveData symbol string, optionally appending the exchange.
      // e.g. "SPX:ICAP" or just "EUR/USD"
      const tdSymbol = sym.exchange ? `${sym.td}:${sym.exchange}` : sym.td;

      try {
        const candles = await fetchHistoricalCandles(apiKey, tdSymbol, tf.td, tf.outputSize);

        if (candles.length > 0) {
          seedCandles(sym.igfx, tf.igfx, candles, true); // force=true: overwrite synthetic placeholder
          console.log(`[seeder] ${sym.igfx} ${tf.igfx}: ${candles.length} candles seeded`);
          totalSeeded += candles.length;
        } else {
          console.warn(`[seeder] ${sym.igfx} ${tf.igfx}: no data returned`);
        }
      } catch (err) {
        totalErrors++;
        console.error(
          `[seeder] ${sym.igfx} ${tf.igfx}: unexpected error —`,
          (err as Error).message,
        );
      }

      // Paid plan: 800 req/min → 130ms gap keeps us at ~7.7 req/s.
      await delay(130);
    }
  }

  console.log(
    `[seeder] historical seed complete — ${totalSeeded} total candles, ${totalErrors} errors`,
  );
}
