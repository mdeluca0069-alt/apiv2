import * as https from "node:https";
import * as http  from "node:http";

import type { Candle } from "../candle.aggregator.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TwelveDataValue {
  datetime: string;
  open:     string;
  high:     string;
  low:      string;
  close:    string;
  volume:   string;
}

interface TwelveDataResponse {
  meta?:   Record<string, unknown>;
  values?: TwelveDataValue[];
  status?: string;
  code?:   number;
  message?: string;
}

// ─── REST client ──────────────────────────────────────────────────────────────

const BASE_URL   = "https://api.twelvedata.com";
const TIMEOUT_MS = 15_000;

// ─── Quote types ──────────────────────────────────────────────────────────────

export type LiveQuote = {
  symbol:     string;
  close:      number;   // latest price
  open:       number;   // day open
  high:       number;   // day high
  low:        number;   // day low
  changePct:  number;   // % change from previous close
  prevClose:  number;   // previous session close
  timestamp:  string;
};

interface TwelveDataQuoteEntry {
  symbol:            string;
  name?:             string;
  open?:             string;
  high?:             string;
  low?:              string;
  close?:            string;
  previous_close?:   string;
  change?:           string;
  percent_change?:   string;
  datetime?:         string;
  is_market_open?:   boolean;
}

interface TwelveDataPriceEntry {
  price: string;
}

type TwelveDataBatchResponse<T> = Record<string, T | { status: string; message: string; code: number }>;

/**
 * Perform a single HTTPS GET and resolve with the full JSON body.
 * Rejects on HTTP error, network error, or timeout.
 */
function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: TIMEOUT_MS }, (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
        } else {
          resolve(body);
        }
      });
      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.on("error", reject);
  });
}

/**
 * Parse a TwelveData datetime string ("2026-06-01 22:00:00" or "2026-06-01")
 * into a Unix timestamp in seconds (UTC).
 */
function parseDatetime(dt: string): number {
  // Replace space separator with "T" and append Z so Date.parse treats it as UTC.
  const iso = dt.includes("T") ? dt : dt.replace(" ", "T") + (dt.length === 10 ? "T00:00:00Z" : "Z");
  const ms  = Date.parse(iso);
  if (isNaN(ms)) return 0;
  return Math.floor(ms / 1_000);
}

/**
 * Fetch historical OHLCV candles from TwelveData REST /time_series.
 *
 * @param apiKey     - TwelveData API key (NOT logged)
 * @param symbol     - Symbol in TwelveData format (e.g. "EUR/USD", "AAPL")
 * @param interval   - TwelveData interval string (e.g. "1min", "1h", "1day")
 * @param outputSize - Number of data points requested (max 5000)
 * @returns Candles sorted ascending by time (oldest first), or [] on any error.
 */
export async function fetchHistoricalCandles(
  apiKey:     string,
  symbol:     string,
  interval:   string,
  outputSize: number,
): Promise<Candle[]> {
  const params = new URLSearchParams({
    apikey:     apiKey,
    symbol,
    interval,
    outputsize: String(outputSize),
    format:     "JSON",
  });

  // Build the URL but never log it — it contains the API key.
  const url = `${BASE_URL}/time_series?${params.toString()}`;

  let body: string;
  try {
    body = await httpsGet(url);
  } catch (err) {
    console.error(
      `[twelvedata-rest] network error fetching ${symbol} ${interval}:`,
      (err as Error).message,
    );
    return [];
  }

  let parsed: TwelveDataResponse;
  try {
    parsed = JSON.parse(body) as TwelveDataResponse;
  } catch {
    console.error(`[twelvedata-rest] invalid JSON for ${symbol} ${interval}`);
    return [];
  }

  if (parsed.status !== "ok") {
    // Log without the raw body (may contain sensitive auth info in error messages)
    console.error(
      `[twelvedata-rest] API error for ${symbol} ${interval}: code=${parsed.code ?? "?"} msg=${parsed.message ?? "unknown"}`,
    );
    return [];
  }

  if (!Array.isArray(parsed.values) || parsed.values.length === 0) {
    console.warn(`[twelvedata-rest] no values for ${symbol} ${interval}`);
    return [];
  }

  // TwelveData returns newest-first — reverse to get ascending order.
  const candles: Candle[] = parsed.values
    .map((v): Candle | null => {
      const time   = parseDatetime(v.datetime);
      const open   = parseFloat(v.open);
      const high   = parseFloat(v.high);
      const low    = parseFloat(v.low);
      const close  = parseFloat(v.close);
      const volume = parseFloat(v.volume ?? "0");

      if (!time || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) return null;

      return { time, open, high, low, close, volume: isNaN(volume) ? 0 : volume, synthetic: false };
    })
    .filter((c): c is Candle => c !== null)
    .reverse(); // oldest first

  return candles;
}

/**
 * Fetch the latest quote (open, close, change%) for multiple symbols in one
 * REST call using the /quote batch endpoint.
 *
 * @param apiKey  TwelveData API key (NOT logged)
 * @param symbols TwelveData-format symbols, e.g. ["EUR/USD", "BTC/USD", "AAPL"]
 * @returns Map of normalised IGFX symbol → LiveQuote. Missing/error symbols are omitted.
 */
export async function fetchLiveQuotes(
  apiKey:  string,
  symbols: string[],
): Promise<Map<string, LiveQuote>> {
  const result = new Map<string, LiveQuote>();
  if (!symbols.length) return result;

  const params = new URLSearchParams({
    apikey:  apiKey,
    symbol:  symbols.join(","),
    format:  "JSON",
  });

  let body: string;
  try {
    body = await httpsGet(`${BASE_URL}/quote?${params.toString()}`);
  } catch (err) {
    console.error("[twelvedata-rest] fetchLiveQuotes network error:", (err as Error).message);
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.error("[twelvedata-rest] fetchLiveQuotes invalid JSON");
    return result;
  }

  // Single symbol → TwelveData returns the object directly, not wrapped in symbol key
  const entries = symbols.length === 1
    ? { [symbols[0]]: parsed as TwelveDataQuoteEntry }
    : (parsed as TwelveDataBatchResponse<TwelveDataQuoteEntry>);

  for (const [rawSymbol, entry] of Object.entries(entries)) {
    const q = entry as TwelveDataQuoteEntry;
    if (!q?.close) continue; // error entry has no `close`

    const close     = parseFloat(q.close     ?? "0");
    const open      = parseFloat(q.open      ?? String(close));
    const high      = parseFloat(q.high      ?? String(close));
    const low       = parseFloat(q.low       ?? String(close));
    const prevClose = parseFloat(q.previous_close ?? String(close));
    const pctChange = parseFloat(q.percent_change ?? "0");

    if (!isFinite(close) || close <= 0) continue;

    // Normalise symbol to IGFX format (e.g. "EUR/USD" → "EURUSD")
    const igfxSymbol = rawSymbol.toUpperCase().replace("/", "");

    result.set(igfxSymbol, {
      symbol:    igfxSymbol,
      close,
      open:      isFinite(open)      ? open      : close,
      high:      isFinite(high)      ? high      : close,
      low:       isFinite(low)       ? low       : close,
      prevClose: isFinite(prevClose) ? prevClose : close,
      changePct: isFinite(pctChange) ? pctChange : 0,
      timestamp: q.datetime ?? new Date().toISOString(),
    });
  }

  console.log(`[twelvedata-rest] fetchLiveQuotes: got ${result.size}/${symbols.length} quotes`);
  return result;
}

/**
 * Fetch current raw prices for multiple symbols via the /price batch endpoint.
 * Lighter than /quote — only returns the latest price, no day OHLC or change%.
 * Useful for rapid startup seeding when /quote rate limits are a concern.
 *
 * @returns Map of IGFX symbol → mid price
 */
export async function fetchCurrentPrices(
  apiKey:  string,
  symbols: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!symbols.length) return result;

  const params = new URLSearchParams({
    apikey:  apiKey,
    symbol:  symbols.join(","),
    format:  "JSON",
  });

  let body: string;
  try {
    body = await httpsGet(`${BASE_URL}/price?${params.toString()}`);
  } catch (err) {
    console.error("[twelvedata-rest] fetchCurrentPrices network error:", (err as Error).message);
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return result;
  }

  const entries = symbols.length === 1
    ? { [symbols[0]]: parsed as TwelveDataPriceEntry }
    : (parsed as TwelveDataBatchResponse<TwelveDataPriceEntry>);

  for (const [rawSymbol, entry] of Object.entries(entries)) {
    const p = entry as TwelveDataPriceEntry;
    const price = parseFloat(p?.price ?? "0");
    if (!isFinite(price) || price <= 0) continue;
    const igfxSymbol = rawSymbol.toUpperCase().replace("/", "");
    result.set(igfxSymbol, price);
  }

  console.log(`[twelvedata-rest] fetchCurrentPrices: got ${result.size}/${symbols.length} prices`);
  return result;
}
