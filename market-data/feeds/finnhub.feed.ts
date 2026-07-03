import { WebSocket } from "ws";
import type { NormalizedQuote } from "./twelvedata.feed.js";

export type { NormalizedQuote };

export type FinnhubFeedOptions = {
  apiKey:       string;
  symbols:      string[];
  onQuote:      (quote: NormalizedQuote) => void;
  onError?:     (err: Error) => void;
  onReconnect?: (attempt: number) => void;
};

const WS_URL                = "wss://ws.finnhub.io";
const MAX_RECONNECT_DELAY_MS = 30_000;
const PING_INTERVAL_MS       = 30_000;

// igfxpro symbol → Finnhub WS symbol.
// Finnhub's free-tier WebSocket DOES stream real-time forex/metals via OANDA
// symbols (and crypto via Binance) — only real-time US equities require a
// paid plan. We subscribe forex/metals here as a genuine redundant source
// alongside TwelveData-WS, so FX majors never depend on a single provider.
const TO_FINNHUB: Record<string, string> = {
  AAPL:   "AAPL",
  MSFT:   "MSFT",
  NVDA:   "NVDA",
  TSLA:   "TSLA",
  AMZN:   "AMZN",
  BTCUSD: "BINANCE:BTCUSDT",
  ETHUSD: "BINANCE:ETHUSDT",
  EURUSD: "OANDA:EUR_USD",
  GBPUSD: "OANDA:GBP_USD",
  USDJPY: "OANDA:USD_JPY",
  EURGBP: "OANDA:EUR_GBP",
  AUDUSD: "OANDA:AUD_USD",
  USDCHF: "OANDA:USD_CHF",
  XAUUSD: "OANDA:XAU_USD",
  XAGUSD: "OANDA:XAG_USD",
  // Best-effort: indices/commodities/extra crypto via OANDA & Binance.
  // Harmless if unsupported on this plan — symbol simply won't tick.
  US500:  "OANDA:SPX500_USD",
  US100:  "OANDA:NAS100_USD",
  DE40:   "OANDA:DE30_EUR",
  UK100:  "OANDA:UK100_GBP",
  WTI:    "OANDA:WTICO_USD",
  BRENT:  "OANDA:BCO_USD",
  SOLUSD: "BINANCE:SOLUSDT",
};

// Reverse: Finnhub symbol → igfxpro symbol
const FROM_FINNHUB: Record<string, string> = Object.fromEntries(
  Object.entries(TO_FINNHUB).map(([ig, fh]) => [fh, ig]),
);

// Half-spread per igfxpro symbol for bid/ask synthesis (Finnhub delivers last-trade price only).
const HALF_SPREAD: Record<string, number> = {
  AAPL:   0.01,
  MSFT:   0.01,
  NVDA:   0.05,
  TSLA:   0.05,
  AMZN:   0.01,
  BTCUSD: 5.0,
  ETHUSD: 0.5,
  EURUSD: 0.00005,
  GBPUSD: 0.00005,
  USDJPY: 0.005,
  EURGBP: 0.00005,
  AUDUSD: 0.00005,
  USDCHF: 0.00005,
  XAUUSD: 0.2,
  XAGUSD: 0.02,
  US500:  0.5,
  US100:  1.5,
  DE40:   1.5,
  UK100:  1.0,
  WTI:    0.03,
  BRENT:  0.03,
  SOLUSD: 0.05,
};

function halfSpreadFor(symbol: string): number {
  return HALF_SPREAD[symbol] ?? 0.01;
}

export class FinnhubFeed {
  private ws:               WebSocket | null = null;
  private reconnectAttempt  = 0;
  private pingTimer:        NodeJS.Timeout | null = null;
  private reconnectTimer:   NodeJS.Timeout | null = null;
  private stopped           = false;
  private lastPrices        = new Map<string, number>();

  private readonly wsSymbols: string[];

  constructor(private readonly opts: FinnhubFeedOptions) {
    this.wsSymbols = opts.symbols
      .filter((s) => s in TO_FINNHUB)
      .map((s) => TO_FINNHUB[s]!);
  }

  start(): void {
    if (this.wsSymbols.length === 0) {
      console.warn("[finnhub-feed] no supported WS symbols in provided list — feed inactive");
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer)      clearInterval(this.pingTimer);
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
      for (const fhSymbol of this.wsSymbols) {
        this.ws!.send(JSON.stringify({ type: "subscribe", symbol: fhSymbol }));
      }
      this.startPing();
      console.log(`[finnhub-feed] connected — subscribed to ${this.wsSymbols.length} symbols`);
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg["type"] !== "trade") {
          // Surface error/ping-rejected/plan-restriction replies that were
          // previously dropped silently (e.g. "symbol not supported on plan").
          if (msg["type"] === "error") {
            this.opts.onError?.(new Error(`finnhub-ws message: ${JSON.stringify(msg).slice(0, 300)}`));
          }
          return;
        }

        const data = msg["data"];
        if (!Array.isArray(data)) return;

        // Group by symbol and keep the latest trade (highest timestamp)
        const latest = new Map<string, { p: number; t: number }>();
        for (const item of data) {
          const trade = item as Record<string, unknown>;
          const s  = trade["s"];
          const p  = trade["p"];
          const ts = trade["t"];
          if (typeof s !== "string" || typeof p !== "number" || !isFinite(p) || p <= 0) continue;
          const existing = latest.get(s);
          if (!existing || (typeof ts === "number" && ts > existing.t)) {
            latest.set(s, { p, t: typeof ts === "number" ? ts : 0 });
          }
        }

        for (const [fhSymbol, { p }] of latest) {
          const igSymbol = FROM_FINNHUB[fhSymbol];
          if (!igSymbol) continue;
          this.handleTick(igSymbol, p);
        }
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on("error", (err) => {
      // Redact the API token from error messages before forwarding
      const safe = err.message.replace(/token=[^&\s]+/gi, "token=REDACTED");
      this.opts.onError?.(new Error(safe));
    });

    this.ws.on("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private handleTick(igSymbol: string, price: number): void {
    // 90/10 smoothing to reduce jitter, same as TwelveData feed
    const prev     = this.lastPrices.get(igSymbol);
    const smoothed = prev !== undefined ? price * 0.9 + prev * 0.1 : price;
    this.lastPrices.set(igSymbol, smoothed);

    const hs  = halfSpreadFor(igSymbol);
    const bid = Number((smoothed - hs).toFixed(6));
    const ask = Number((smoothed + hs).toFixed(6));

    const quote: NormalizedQuote = {
      symbol:       igSymbol,
      bid,
      ask,
      mid:          Number(smoothed.toFixed(6)),
      spread:       Number((ask - bid).toFixed(6)),
      timestamp:    new Date().toISOString(),
      isRealSpread: false,
    };

    this.opts.onQuote(quote);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);
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
