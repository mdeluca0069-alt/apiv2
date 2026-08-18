import { WebSocket } from "ws";
import type { NormalizedQuote } from "./twelvedata.feed.js";

export type { NormalizedQuote };

/**
 * FinnhubFeed — STAGING-ONLY WebSocket adapter for Finnhub Free.
 *
 * Not part of the production feed lineup (see feed.manager.ts's own header
 * comment for why Finnhub was previously dropped as a forex/commodity
 * source). This adapter exists solely to demonstrate the Market Data Engine
 * end-to-end against a provider other than TwelveData, scoped to the 5 US
 * equities Finnhub Free reliably streams in real time: AAPL, MSFT, NVDA,
 * TSLA, AMZN. Only wired in when MARKET_DATA_STAGING_PROVIDER=finnhub (see
 * main.ts) — otherwise this class is never instantiated.
 *
 * Deliberately mirrors twelvedata.feed.ts / binance.feed.ts structurally
 * (same NormalizedQuote output type, same 90/10 smoothing, same exponential
 * reconnect backoff, same malformed-frame handling) so it plugs into the
 * existing FeedManager/InternalLiquidityCore ingestion path with zero new
 * quote format and zero changes to either of those files.
 */

export type FinnhubFeedOptions = {
  apiKey:       string;
  /** IGFX symbols == Finnhub US-stock ticker format (e.g. "AAPL") — no
   *  translation table needed, unlike Binance's exchange-specific symbols. */
  symbols:      string[];
  onQuote:      (quote: NormalizedQuote) => void;
  onError?:     (err: Error) => void;
  onReconnect?: (attempt: number) => void;
};

const WS_URL                 = "wss://ws.finnhub.io";
const MAX_RECONNECT_DELAY_MS = 30_000;

// Finnhub's free-plan trade stream carries last price only — no bid/ask
// field. Same half-spread synthesis convention as twelvedata.feed.ts's own
// free-plan fallback (isRealSpread: false). Approximate typical intraday
// spreads for these 5 large-cap US equities; STAGING ONLY, execution-path
// invariants (stale-data guard, sanity bounds) are unchanged by this and
// still gate every tick exactly as they do for every other source.
const HALF_SPREAD: Record<string, number> = {
  AAPL: 0.01,
  MSFT: 0.02,
  NVDA: 0.02,
  TSLA: 0.02,
  AMZN: 0.02,
};

function halfSpreadFor(symbol: string): number {
  return HALF_SPREAD[symbol] ?? 0.01;
}

export class FinnhubFeed {
  private ws:               WebSocket | null = null;
  private reconnectAttempt  = 0;
  private reconnectTimer:   NodeJS.Timeout | null = null;
  private stopped           = false;
  private lastPrices        = new Map<string, number>();

  constructor(private readonly opts: FinnhubFeedOptions) {}

  start(): void {
    if (this.opts.symbols.length === 0) {
      console.warn("[finnhub-feed] no symbols configured — feed inactive");
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;

    const url = `${WS_URL}?token=${this.opts.apiKey}`;
    this.ws = new WebSocket(url, { headers: { "User-Agent": "igfxpro-apiv2/1.0" } });

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      // Finnhub requires one subscribe message PER symbol — no comma-joined
      // batch subscribe like TwelveData's single message.
      for (const symbol of this.opts.symbols) {
        this.ws!.send(JSON.stringify({ type: "subscribe", symbol }));
      }
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

        if (msg["type"] === "error") {
          this.opts.onError?.(new Error(`finnhub-ws error: ${JSON.stringify(msg).slice(0, 1200)}`));
          return;
        }

        // Anything other than a trade frame (e.g. Finnhub's own keepalive
        // "ping" messages) is silently ignored — same conservative handling
        // as twelvedata.feed.ts's `if (msg["event"] !== "price") return;`.
        if (msg["type"] !== "trade") return;

        const data = msg["data"];
        if (!Array.isArray(data)) return;

        for (const entry of data) {
          const e      = entry as Record<string, unknown>;
          const symbol = e["s"];
          const price  = e["p"];
          if (typeof symbol !== "string" || typeof price !== "number") continue;
          if (!isFinite(price) || price <= 0) continue;

          this.handleTick(symbol, price);
        }
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on("error", (err) => {
      const safeMessage = err.message.replace(/token=[^&\s]+/gi, "token=REDACTED");
      this.opts.onError?.(new Error(safeMessage));
    });

    this.ws.on("close", () => {
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private handleTick(symbol: string, price: number): void {
    // Smooth mid: blend 90% new + 10% last to reduce jitter — same
    // convention as twelvedata.feed.ts / binance.feed.ts.
    const prev     = this.lastPrices.get(symbol);
    const smoothed = prev !== undefined ? price * 0.9 + prev * 0.1 : price;
    this.lastPrices.set(symbol, smoothed);

    const hs  = halfSpreadFor(symbol);
    const bid = Number((smoothed - hs).toFixed(2));
    const ask = Number((smoothed + hs).toFixed(2));

    const quote: NormalizedQuote = {
      symbol,
      bid,
      ask,
      mid:          Number(smoothed.toFixed(2)),
      spread:       Number((ask - bid).toFixed(2)),
      timestamp:    new Date().toISOString(),
      isRealSpread: false,
    };

    this.opts.onQuote(quote);
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    const delay = Math.min(
      1000 * 2 ** Math.min(this.reconnectAttempt - 1, 5),
      MAX_RECONNECT_DELAY_MS,
    );
    this.opts.onReconnect?.(this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
