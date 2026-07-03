import { WebSocket } from "ws";
import type { NormalizedQuote } from "./twelvedata.feed.js";

export type { NormalizedQuote };

export type BinanceFeedOptions = {
  symbols:      string[];   // igfxpro symbols, e.g. ["BTCUSD","ETHUSD","SOLUSD"]
  onQuote:      (quote: NormalizedQuote) => void;
  onError?:     (err: Error) => void;
  onReconnect?: (attempt: number) => void;
};

const WS_BASE                = "wss://stream.binance.com:9443/stream";
const MAX_RECONNECT_DELAY_MS = 30_000;

// igfxpro symbol → Binance trade-stream symbol. Binance's public market-data
// WebSocket needs no API key and no auth — real-time trades for every major
// pair, free, no plan restrictions (unlike TwelveData/Finnhub's free tiers).
const TO_BINANCE: Record<string, string> = {
  BTCUSD: "btcusdt",
  ETHUSD: "ethusdt",
  SOLUSD: "solusdt",
};

const FROM_BINANCE: Record<string, string> = Object.fromEntries(
  Object.entries(TO_BINANCE).map(([ig, bn]) => [bn, ig]),
);

const HALF_SPREAD: Record<string, number> = {
  BTCUSD: 5.0,
  ETHUSD: 0.5,
  SOLUSD: 0.02,
};

function halfSpreadFor(symbol: string): number {
  return HALF_SPREAD[symbol] ?? 0.01;
}

export class BinanceFeed {
  private ws:              WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer:  NodeJS.Timeout | null = null;
  private stopped          = false;
  private lastPrices       = new Map<string, number>();

  private readonly streams: string[];

  constructor(private readonly opts: BinanceFeedOptions) {
    this.streams = opts.symbols
      .filter((s) => s in TO_BINANCE)
      .map((s) => `${TO_BINANCE[s]}@trade`);
  }

  start(): void {
    if (this.streams.length === 0) {
      console.warn("[binance-feed] no supported symbols in provided list — feed inactive");
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

    const url = `${WS_BASE}?streams=${this.streams.join("/")}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      console.log(`[binance-feed] connected — streaming ${this.streams.length} symbols`);
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { data?: { s?: string; p?: string } };
        const d = msg.data;
        if (!d?.s || !d.p) return;

        const bnSymbol = d.s.toLowerCase();
        const igSymbol = FROM_BINANCE[bnSymbol];
        if (!igSymbol) return;

        const price = Number(d.p);
        if (!isFinite(price) || price <= 0) return;

        this.handleTick(igSymbol, price);
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on("error", (err) => {
      this.opts.onError?.(err);
    });

    this.ws.on("close", () => {
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private handleTick(igSymbol: string, price: number): void {
    // 90/10 smoothing to reduce jitter, same convention as the other feeds.
    const prev     = this.lastPrices.get(igSymbol);
    const smoothed = prev !== undefined ? price * 0.9 + prev * 0.1 : price;
    this.lastPrices.set(igSymbol, smoothed);

    const hs  = halfSpreadFor(igSymbol);
    const bid = Number((smoothed - hs).toFixed(2));
    const ask = Number((smoothed + hs).toFixed(2));

    const quote: NormalizedQuote = {
      symbol:       igSymbol,
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
