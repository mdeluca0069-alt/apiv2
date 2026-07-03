/**
 * VirtualOrderbook — Level 2 synthetic depth for IGFX internal LP.
 *
 * Builds a 10-level bid/ask book from a mid-price and spread.
 * Volumes are calibrated to asset class so the simulated fill engine
 * produces realistic slippage for typical IGFXPRO trade sizes.
 */

export type DepthLevel = {
  price:            number;
  volume:           number;
  cumulativeVolume: number;
};

export type OrderBook = {
  symbol:      string;
  provider:    "IGFX_INTERNAL_LP";
  bid:         number;
  ask:         number;
  spread:      number;
  spreadBps:   number;
  bids:        DepthLevel[];
  asks:        DepthLevel[];
  snapshotAt:  string;
};

type BookInput = {
  symbol:     string;
  bid:        number;
  ask:        number;
  mid:        number;
  spread:     number;
  changePct:  number;
  assetClass: string;
};

// Volume per level in instrument units (first level is largest)
const VOLUME_SCALE: Record<string, number> = {
  FX_MAJOR:  750_000,
  FX_MINOR:  400_000,
  INDEX:     50,
  COMMODITY: 300,
  EQUITY:    500,
  CRYPTO:    2.5,
};

// Price step between depth levels
const TICK_STEP: Record<string, (mid: number) => number> = {
  FX_MAJOR:  ()    => 0.00005,
  FX_MINOR:  ()    => 0.00010,
  INDEX:     (mid) => mid * 0.00005,
  COMMODITY: (mid) => mid * 0.00020,
  EQUITY:    (mid) => mid * 0.00025,
  CRYPTO:    (mid) => mid * 0.00010,
};

function roundTo(value: number, precision: number): number {
  return Number(value.toFixed(precision));
}

function precisionFor(symbol: string, assetClass: string): number {
  if (symbol.includes("JPY")) return 3;
  if (assetClass === "FX_MAJOR" || assetClass === "FX_MINOR") return 5;
  return 2;
}

export class VirtualOrderbook {
  build(input: BookInput, levels = 10): OrderBook {
    const ac        = input.assetClass;
    const prec      = precisionFor(input.symbol, ac);
    const volScale  = VOLUME_SCALE[ac] ?? VOLUME_SCALE.FX_MAJOR;
    const tickStep  = (TICK_STEP[ac] ?? TICK_STEP.FX_MAJOR)(input.mid);

    // Spread volatility boost — wider market → larger volumes at each level
    const volBoost  = 1 + Math.min(Math.abs(input.changePct) * 0.5, 1.5);

    const bids: DepthLevel[] = [];
    const asks: DepthLevel[] = [];
    let cumBid = 0;
    let cumAsk = 0;

    for (let i = 0; i < levels; i++) {
      // Volumes taper away from the best price (front-loaded book)
      const bidVol = roundTo((levels - i) * volBoost * volScale, 0);
      const askVol = roundTo((levels - i) * volBoost * volScale * 0.97, 0);

      cumBid += bidVol;
      cumAsk += askVol;

      bids.push({
        price:            roundTo(input.bid - tickStep * i, prec),
        volume:           bidVol,
        cumulativeVolume: roundTo(cumBid, 0),
      });
      asks.push({
        price:            roundTo(input.ask + tickStep * i, prec),
        volume:           askVol,
        cumulativeVolume: roundTo(cumAsk, 0),
      });
    }

    const spread    = roundTo(input.ask - input.bid, prec);
    const spreadBps = roundTo((spread / input.mid) * 10_000, 2);

    return {
      symbol:     input.symbol,
      provider:   "IGFX_INTERNAL_LP",
      bid:        input.bid,
      ask:        input.ask,
      spread,
      spreadBps,
      bids,
      asks,
      snapshotAt: new Date().toISOString(),
    };
  }

  /**
   * Simulate a fill against a book.
   * Returns average fill price and slippage vs the best-level price.
   */
  simulateFill(
    book:     OrderBook,
    side:     "BUY" | "SELL",
    quantity: number,
  ): { averagePrice: number; slippage: number; partialFill: boolean } {
    const levels   = side === "BUY" ? book.asks : book.bids;
    const topPrice = side === "BUY" ? book.ask  : book.bid;

    let remaining = quantity;
    let notional  = 0;
    let filled    = 0;

    for (const lvl of levels) {
      if (remaining <= 0) break;
      const fillQty = Math.min(remaining, lvl.volume);
      notional     += fillQty * lvl.price;
      filled       += fillQty;
      remaining    -= fillQty;
    }

    const averagePrice = filled > 0 ? notional / filled : topPrice;
    const slippage     = Math.abs(averagePrice - topPrice);

    return { averagePrice, slippage, partialFill: remaining > 0 };
  }
}

export const virtualOrderbook = new VirtualOrderbook();
