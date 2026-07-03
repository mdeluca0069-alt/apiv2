import { TwelveDataFeed, type NormalizedQuote } from "./feeds/twelvedata.feed.js";

export type AggregatorOptions = {
  apiKey:   string;
  symbols:  string[];
  /**
   * Routes external quotes to InternalLiquidityCore rather than directly to
   * quoteCache.  The liquidity core is the single canonical write path.
   * bid/ask are forwarded when available (TwelveData paid plan).
   */
  externalQuoteHandler?: (
    symbol: string,
    mid:    number,
    bid?:   number,
    ask?:   number,
  ) => void;
};

export type AggregatorStats = {
  running:     boolean;
  feedType:    "twelvedata" | "none";
  symbols:     string[];
  quoteCount:  number;
  lastQuoteAt: string | null;
  errors:      number;
};

export class MarketDataAggregator {
  private feed:         TwelveDataFeed | null = null;
  private running       = false;
  private quoteCount    = 0;
  private errorCount    = 0;
  private lastQuoteAt:  string | null = null;
  private readonly latestQuotes = new Map<string, NormalizedQuote>();

  constructor(private readonly opts: AggregatorOptions) {}

  start(): void {
    if (this.running) return;
    if (!this.opts.apiKey) {
      console.error(
        "[market-data] CRITICAL: TWELVEDATA_API_KEY not set. " +
        "MarketDataAggregator will not start. " +
        "All instruments will remain stale — orders will be rejected with NO_LIVE_MARKET_DATA."
      );
      return;
    }

    this.running = true;
    this.feed = new TwelveDataFeed({
      apiKey:      this.opts.apiKey,
      symbols:     this.opts.symbols,
      onQuote:     (quote) => this.handleQuote(quote),
      onError:     (err)   => {
        this.errorCount++;
        console.error("[market-data] feed error:", err.message);
      },
      onReconnect: (attempt) => {
        console.warn(`[market-data] reconnecting (attempt ${attempt})...`);
      },
    });

    this.feed.start();
    console.log(
      `[market-data] TwelveData feed started for ${this.opts.symbols.length} symbols`
    );
  }

  stop(): void {
    this.feed?.stop();
    this.running = false;
  }

  getLatestQuote(symbol: string): NormalizedQuote | null {
    return this.latestQuotes.get(symbol) ?? null;
  }

  getAllQuotes(): NormalizedQuote[] {
    return [...this.latestQuotes.values()];
  }

  getStats(): AggregatorStats {
    return {
      running:     this.running,
      feedType:    this.opts.apiKey ? "twelvedata" : "none",
      symbols:     this.opts.symbols,
      quoteCount:  this.quoteCount,
      lastQuoteAt: this.lastQuoteAt,
      errors:      this.errorCount,
    };
  }

  private handleQuote(quote: NormalizedQuote): void {
    this.latestQuotes.set(quote.symbol, quote);
    this.quoteCount++;
    this.lastQuoteAt = quote.timestamp;

    if (this.opts.externalQuoteHandler) {
      // Forward real bid/ask when available (paid plan).
      // On free plan (isRealSpread = false), pass only mid so InternalLiquidityCore
      // derives bid/ask from its SpreadStore (last observed real spread) rather
      // than from the synthesised values TwelveDataFeed built using HALF_SPREAD.
      if (quote.isRealSpread) {
        this.opts.externalQuoteHandler(quote.symbol, quote.mid, quote.bid, quote.ask);
      } else {
        this.opts.externalQuoteHandler(quote.symbol, quote.mid);
      }
    }
  }
}

export function initMarketDataAggregator(opts: AggregatorOptions): MarketDataAggregator {
  return new MarketDataAggregator(opts);
}
