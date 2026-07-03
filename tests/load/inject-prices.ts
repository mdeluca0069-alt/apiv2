import { quoteCache } from "../../market-data/quote.cache.js";

const PRICES = {
  EURUSD: { bid: 1.08700, ask: 1.08710, mid: 1.08705, spread: 0.0001, changePct: 0.05 },
  GBPUSD: { bid: 1.33800, ask: 1.33815, mid: 1.33808, spread: 0.00015, changePct: 0.02 },
  USDJPY: { bid: 158.30, ask: 158.32, mid: 158.31, spread: 0.02, changePct: -0.01 },
  XAUUSD: { bid: 4260.0, ask: 4261.5, mid: 4260.75, spread: 1.5, changePct: 0.1 },
  BTCUSD: { bid: 67400, ask: 67500, mid: 67450, spread: 100, changePct: 0.5 },
  ETHUSD: { bid: 3540, ask: 3545, mid: 3542.5, spread: 5, changePct: 0.3 },
  US500: { bid: 5290, ask: 5292, mid: 5291, spread: 2, changePct: 0.2 },
  US100: { bid: 18500, ask: 18502, mid: 18501, spread: 2, changePct: 0.3 },
  EURGBP: { bid: 0.8568, ask: 0.8570, mid: 0.8569, spread: 0.0002, changePct: 0.01 },
  AUDUSD: { bid: 0.6650, ask: 0.6651, mid: 0.6651, spread: 0.0001, changePct: -0.02 },
  AAPL: { bid: 215.0, ask: 215.1, mid: 215.05, spread: 0.1, changePct: 0.3 },
  MSFT: { bid: 425.0, ask: 425.2, mid: 425.1, spread: 0.2, changePct: 0.2 },
};

const ts = new Date().toISOString();
let count = 0;
for (const [symbol, p] of Object.entries(PRICES)) {
  quoteCache.set({ symbol, ...p, ts });
  count++;
}
console.log(`[inject-prices] Injected ${count} fresh quotes at ${ts}`);
process.exit(0);
