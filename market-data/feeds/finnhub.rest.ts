import * as https from "node:https";
import * as http  from "node:http";

/**
 * finnhub.rest.ts — STAGING-ONLY REST client for Finnhub Free's /quote
 * endpoint.
 *
 * Deliberately self-contained (own httpsGet helper, not shared with
 * twelvedata.rest.ts) so this whole adapter can be removed with a single
 * `rm market-data/feeds/finnhub.*.ts` and no cleanup required anywhere else
 * — see FINNHUB_STAGING_IMPLEMENTATION_REPORT.md.
 *
 * Finnhub's free plan has no batch /quote endpoint (unlike TwelveData's
 * comma-joined /quote and /price) — one HTTP call per symbol, issued
 * SEQUENTIALLY (never Promise.all) so a 5-symbol refresh never bursts more
 * than one request at a time against the free-tier rate limit.
 */

const BASE_URL   = "https://finnhub.io/api/v1";
const TIMEOUT_MS = 15_000;

interface FinnhubQuoteResponse {
  c?: number;  // current price
  h?: number;  // high
  l?: number;  // low
  o?: number;  // open
  pc?: number; // previous close
  t?: number;  // unix seconds
}

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
 * Fetch current prices for multiple symbols via Finnhub's /quote endpoint —
 * one request per symbol, sequentially. Same Map<symbol, price> return
 * shape as twelvedata.rest.ts's fetchCurrentPrices() so feed.manager.ts's
 * tertiary-polling call site needs no branching logic beyond which client
 * function it imports.
 *
 * @param apiKey  Finnhub API key (NOT logged)
 * @param symbols IGFX-format symbols, e.g. ["AAPL", "MSFT", "NVDA"]
 * @returns Map of IGFX symbol → current price. Missing/error symbols are omitted.
 */
export async function fetchCurrentPrices(
  apiKey:  string,
  symbols: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!symbols.length) return result;

  for (const symbol of symbols) {
    const params = new URLSearchParams({ symbol, token: apiKey });
    try {
      const body   = await httpsGet(`${BASE_URL}/quote?${params.toString()}`);
      const parsed = JSON.parse(body) as FinnhubQuoteResponse;
      const price  = parsed.c;
      if (typeof price === "number" && isFinite(price) && price > 0) {
        result.set(symbol.toUpperCase(), price);
      }
    } catch (err) {
      // One symbol's failure must not abort the rest of the sequential batch.
      console.error(`[finnhub-rest] fetchCurrentPrices failed for ${symbol}:`, (err as Error).message);
    }
  }

  console.log(`[finnhub-rest] fetchCurrentPrices: got ${result.size}/${symbols.length} prices`);
  return result;
}
