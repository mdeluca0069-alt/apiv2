import { WebSocket } from "ws";

export type NormalizedQuote = {
  symbol:      string;
  bid:         number;
  ask:         number;
  mid:         number;
  spread:      number;
  timestamp:   string;
  /**
   * true  → bid/ask came directly from TwelveData (paid plan).
   * false → bid/ask synthesised from half-spread table (free plan fallback).
   * Consumers should prefer real bid/ask for execution pricing.
   */
  isRealSpread: boolean;
};

export type FeedOptions = {
  apiKey:       string;
  symbols:      string[];
  onQuote:      (quote: NormalizedQuote) => void;
  onError?:     (err: Error) => void;
  onReconnect?: (attempt: number) => void;
};

const WS_URL               = "wss://ws.twelvedata.com/v1/quotes/price";
const MAX_RECONNECT_DELAY_MS = 30_000;
const PING_INTERVAL_MS       = 25_000;

// Half-spread fallback for free-plan messages that lack bid/ask fields.
// Used ONLY when the paid-plan bid/ask fields are absent.
const HALF_SPREAD: Record<string, number> = {
  EUR:  0.00005,
  GBP:  0.00005,
  USD:  0.00005,
  JPY:  0.005,
  BTC:  5.0,
  ETH:  0.5,
  XAU:  0.2,
  SPY:  0.01,
  AAPL: 0.01,
};

function halfSpreadFor(symbol: string): number {
  for (const [prefix, spread] of Object.entries(HALF_SPREAD)) {
    if (symbol.startsWith(prefix)) return spread;
  }
  return 0.01;
}

export class TwelveDataFeed {
  private ws:               WebSocket | null = null;
  private reconnectAttempt  = 0;
  private pingTimer:        NodeJS.Timeout | null = null;
  private reconnectTimer:   NodeJS.Timeout | null = null;
  private stopped           = false;
  private lastPrices        = new Map<string, number>();

  constructor(private readonly opts: FeedOptions) {}

  start(): void {
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

    const url = `${WS_URL}?apikey=${this.opts.apiKey}`;
    this.ws = new WebSocket(url, { headers: { "User-Agent": "igfxpro-apiv2/1.0" } });

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.ws!.send(
        JSON.stringify({
          action: "subscribe",
          params: { symbols: this.opts.symbols.join(",") },
        })
      );
      this.startPing();
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg["event"] !== "price") {
          // Surface subscribe-status / error / plan-restriction responses that
          // were previously swallowed silently — these explain "WS connected
          // but no ticks ever arrive" symptoms (e.g. plan doesn't include WS).
          if (msg["event"] === "subscribe-status" || msg["status"] === "error" || msg["event"] === "error") {
            this.opts.onError?.(new Error(`subscribe-status: ${JSON.stringify(msg).slice(0, 1200)}`));
          }
          return;
        }

        const symbol = msg["symbol"];
        const price  = msg["price"];
        if (typeof symbol !== "string" || typeof price !== "string") return;

        const mid = parseFloat(price);
        if (!isFinite(mid) || mid <= 0) return;

        // TwelveData paid plan sends bid/ask alongside price.
        // Free plan sends price only — bid/ask fields are absent.
        const rawBid = msg["bid"];
        const rawAsk = msg["ask"];
        const bid = typeof rawBid === "string" ? parseFloat(rawBid) : undefined;
        const ask = typeof rawAsk === "string" ? parseFloat(rawAsk) : undefined;

        this.handleTick(symbol, mid, bid, ask);
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on("error", (err) => {
      const safeMessage = err.message.replace(/apikey=[^&\s]+/gi, "apikey=REDACTED");
      this.opts.onError?.(new Error(safeMessage));
    });

    this.ws.on("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private handleTick(
    symbol: string,
    price:  number,
    bid?:   number,
    ask?:   number,
  ): void {
    // Smooth mid: blend 90% new + 10% last to reduce jitter
    const prev     = this.lastPrices.get(symbol);
    const smoothed = prev !== undefined ? price * 0.9 + prev * 0.1 : price;
    this.lastPrices.set(symbol, smoothed);

    let finalBid: number;
    let finalAsk: number;
    let isRealSpread: boolean;

    if (
      bid !== undefined && ask !== undefined &&
      isFinite(bid) && isFinite(ask) &&
      bid > 0 && ask > bid
    ) {
      // Paid plan: use real bid/ask directly (no synthetic spread)
      finalBid     = Number(bid.toFixed(6));
      finalAsk     = Number(ask.toFixed(6));
      isRealSpread = true;
    } else {
      // Free plan: synthesise from half-spread table
      const hs     = halfSpreadFor(symbol);
      finalBid     = Number((smoothed - hs).toFixed(6));
      finalAsk     = Number((smoothed + hs).toFixed(6));
      isRealSpread = false;
    }

    const quote: NormalizedQuote = {
      symbol,
      bid:         finalBid,
      ask:         finalAsk,
      mid:         Number(smoothed.toFixed(6)),
      spread:      Number((finalAsk - finalBid).toFixed(6)),
      timestamp:   new Date().toISOString(),
      isRealSpread,
    };

    this.opts.onQuote(quote);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ action: "heartbeat" }));
      }
    }, PING_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    const delay = Math.min(
      1000 * 2 ** Math.min(this.reconnectAttempt - 1, 5),
      MAX_RECONNECT_DELAY_MS
    );
    this.opts.onReconnect?.(this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
