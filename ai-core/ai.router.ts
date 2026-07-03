/**
 * IGFXPRO — AI Router
 * Real implementations for: Chat (Claude), Backtest, Strategy Builder, Hedge Manager
 */
import Anthropic from "@anthropic-ai/sdk";
import { getCandles } from "../market-data/candle.aggregator.js";
import type { RequestContext } from "../shared/http.js";
import type { Candle } from "../market-data/candle.aggregator.js";

// ─── Anthropic client (lazy — only created when key is present) ─────────────
let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic | null {
  if (_anthropic) return _anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

// ─────────────────────────────────────────────────────────────────────────────
// INDICATOR MATH
// ─────────────────────────────────────────────────────────────────────────────

function calcEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i]! * k + out[i - 1]! * (1 - k));
  }
  return out;
}

function calcRSI(values: number[], period = 14): number[] {
  if (values.length < period + 1) return Array(values.length).fill(50);
  const rsi: number[] = Array(period).fill(50);
  const gains = values.slice(1).map((v, i) => Math.max(0, v - values[i]!));
  const losses = values.slice(1).map((v, i) => Math.max(0, values[i]! - v));
  let ag = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let al = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < gains.length; i++) {
    ag = (ag * (period - 1) + gains[i]!) / period;
    al = (al * (period - 1) + losses[i]!) / period;
    rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return rsi;
}

function calcMACD(values: number[]) {
  const ema12 = calcEMA(values, 12);
  const ema26 = calcEMA(values, 26);
  const macd  = ema12.map((v, i) => v - ema26[i]!);
  const sig   = calcEMA(macd, 9);
  const hist  = macd.map((v, i) => v - sig[i]!);
  return { macd, sig, hist };
}

function calcBollinger(values: number[], period = 20, mult = 2) {
  const upper: number[] = [], mid: number[] = [], lower: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1);
    const mean  = slice.reduce((a, b) => a + b, 0) / period;
    const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    mid.push(mean);
    upper.push(mean + mult * std);
    lower.push(mean - mult * std);
  }
  return { upper, mid, lower };
}

function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs = candles.slice(1).map((c, i) =>
    Math.max(c.high - c.low, Math.abs(c.high - candles[i]!.close), Math.abs(c.low - candles[i]!.close))
  );
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function pearsonCorr(x: number[], y: number[], n = 60): number {
  const len = Math.min(x.length, y.length, n);
  if (len < 5) return 0;
  const xs = x.slice(-len), ys = y.slice(-len);
  const mx = xs.reduce((a, b) => a + b, 0) / len;
  const my = ys.reduce((a, b) => a + b, 0) / len;
  let xy = 0, xx = 0, yy = 0;
  for (let i = 0; i < len; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my;
    xy += dx * dy; xx += dx * dx; yy += dy * dy;
  }
  const d = Math.sqrt(xx * yy);
  return d === 0 ? 0 : Math.max(-1, Math.min(1, xy / d));
}

function calcSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std  = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  return std === 0 ? 0 : (mean / std) * Math.sqrt(252);
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKTESTING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

type BacktestTrade = {
  entryTime: number; exitTime: number;
  entryPrice: number; exitPrice: number;
  side: "BUY" | "SELL";
  pnlPips: number; pnlUsd: number;
  exitReason: "TP" | "SL" | "SIGNAL";
  durationMin: number;
};

type StrategyId = "OLOS Momentum" | "OLOS Mean Reversion" | "OLOS Breakout" | "OLOS Trend Follow" | "OLOS Scalp";

function runBacktest(candles: Candle[], strategy: StrategyId, symbol: string, initialCapital: number) {
  if (candles.length < 60) {
    return {
      trades: [], equityCurve: [{ time: Date.now(), equity: initialCapital }],
      metrics: { totalTrades: 0, winRate: 0, totalPnlUsd: 0, sharpeRatio: 0, maxDrawdown: 0, profitFactor: 0, avgWin: 0, avgLoss: 0, winTrades: 0, lossTrades: 0, grossProfit: 0, grossLoss: 0, maxDrawdownPct: 0 },
      note: "Insufficient candle data. Start the server and wait for more market data to accumulate.",
    };
  }

  const closes = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const rsi     = calcRSI(closes);
  const { hist } = calcMACD(closes);
  const ema20   = calcEMA(closes, 20);
  const ema50   = calcEMA(closes, 50);
  const { upper: bbUpper, lower: bbLower } = calcBollinger(closes);
  const atr     = calcATR(candles) || closes[closes.length - 1]! * 0.001;

  const pipSize = symbol.includes("JPY") ? 0.01 : symbol.includes("US5") || symbol.includes("US1") || symbol.includes("BTC") ? 1 : 0.0001;
  const slAtr = 1.5 * atr;
  const tpAtr = 3.0 * atr;

  const trades: BacktestTrade[] = [];
  let inTrade: { side: "BUY" | "SELL"; idx: number; ep: number; sl: number; tp: number } | null = null;

  const START = 55;
  const bbOffset = 19; // bollinger starts at period-1=19

  for (let i = START; i < candles.length; i++) {
    const c = candles[i]!;
    const r = rsi[i] ?? 50;
    const h = hist[i] ?? 0;
    const hPrev = hist[i - 1] ?? 0;
    const e20 = ema20[i] ?? c.close;
    const e50 = ema50[i] ?? c.close;
    const bbu = bbUpper[i - bbOffset] ?? Infinity;
    const bbl = bbLower[i - bbOffset] ?? -Infinity;

    if (inTrade) {
      const hitSl = inTrade.side === "BUY" ? c.low <= inTrade.sl : c.high >= inTrade.sl;
      const hitTp = inTrade.side === "BUY" ? c.high >= inTrade.tp : c.low <= inTrade.tp;

      let exitPrice: number | null = null;
      let exitReason: "TP" | "SL" | "SIGNAL" = "SIGNAL";

      if (hitSl) { exitPrice = inTrade.sl; exitReason = "SL"; }
      else if (hitTp) { exitPrice = inTrade.tp; exitReason = "TP"; }
      else if (strategy === "OLOS Scalp") {
        if ((inTrade.side === "BUY" && r > 65) || (inTrade.side === "SELL" && r < 35)) {
          exitPrice = c.close; exitReason = "SIGNAL";
        }
      } else if (strategy === "OLOS Mean Reversion") {
        const bbMid = (bbu + bbl) / 2;
        if (inTrade.side === "BUY" && c.close >= bbMid) { exitPrice = c.close; exitReason = "SIGNAL"; }
        if (inTrade.side === "SELL" && c.close <= bbMid) { exitPrice = c.close; exitReason = "SIGNAL"; }
      }

      if (exitPrice !== null) {
        const pnlRaw = inTrade.side === "BUY" ? exitPrice - inTrade.ep : inTrade.ep - exitPrice;
        const pnlPips = pnlRaw / pipSize;
        const pnlUsd  = pnlRaw * (symbol.includes("JPY") ? 900 : symbol.includes("BTC") ? 0.01 : 10000);
        trades.push({
          entryTime: candles[inTrade.idx]!.time * 1000,
          exitTime:  c.time * 1000,
          entryPrice: inTrade.ep,
          exitPrice,
          side: inTrade.side,
          pnlPips: Math.round(pnlPips * 10) / 10,
          pnlUsd:  Math.round(pnlUsd * 100) / 100,
          exitReason,
          durationMin: Math.round((c.time - candles[inTrade.idx]!.time) / 60),
        });
        inTrade = null;
      }
    } else {
      let signal: "BUY" | "SELL" | null = null;

      if (strategy === "OLOS Momentum") {
        const macdBull = h > 0 && hPrev <= 0;
        const macdBear = h < 0 && hPrev >= 0;
        if (r < 48 && macdBull && c.close > e50) signal = "BUY";
        else if (r > 52 && macdBear && c.close < e50) signal = "SELL";

      } else if (strategy === "OLOS Mean Reversion") {
        if (c.close < bbl && r < 35) signal = "BUY";
        else if (c.close > bbu && r > 65) signal = "SELL";

      } else if (strategy === "OLOS Breakout") {
        const lb = Math.min(20, i - START);
        const recentHigh = Math.max(...highs.slice(i - lb, i));
        const recentLow  = Math.min(...lows.slice(i - lb, i));
        if (c.close > recentHigh * 1.0001 && e20 > e50 && r > 50) signal = "BUY";
        else if (c.close < recentLow * 0.9999 && e20 < e50 && r < 50) signal = "SELL";

      } else if (strategy === "OLOS Trend Follow") {
        const cross = ema20[i - 1] !== undefined && ema50[i - 1] !== undefined;
        if (cross && e20 > e50 && ema20[i - 1]! <= ema50[i - 1]!) signal = "BUY";
        else if (cross && e20 < e50 && ema20[i - 1]! >= ema50[i - 1]!) signal = "SELL";

      } else if (strategy === "OLOS Scalp") {
        if (r < 28 && h > 0) signal = "BUY";
        else if (r > 72 && h < 0) signal = "SELL";
      }

      if (signal) {
        const ep = c.close;
        const sl = signal === "BUY" ? ep - slAtr : ep + slAtr;
        const tp = signal === "BUY" ? ep + tpAtr : ep - tpAtr;
        inTrade = { side: signal, idx: i, ep, sl, tp };
      }
    }
  }

  // Metrics
  const w = trades.filter(t => t.pnlUsd > 0), l = trades.filter(t => t.pnlUsd <= 0);
  const gp = w.reduce((s, t) => s + t.pnlUsd, 0);
  const gl = Math.abs(l.reduce((s, t) => s + t.pnlUsd, 0));
  const totalPnl = gp - gl;
  const returns = trades.map(t => t.pnlUsd / initialCapital);
  const sharpe  = calcSharpe(returns);

  // Max drawdown
  let peak = 0, equity = 0, maxDD = 0;
  const curve: { time: number; equity: number }[] = [{ time: candles[START]!.time * 1000, equity: initialCapital }];
  for (const t of trades) {
    equity += t.pnlUsd;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDD) maxDD = peak - equity;
    curve.push({ time: t.exitTime, equity: initialCapital + equity });
  }

  return {
    trades: trades.slice(-20),
    equityCurve: curve,
    metrics: {
      totalTrades: trades.length,
      winTrades: w.length,
      lossTrades: l.length,
      winRate: trades.length ? Math.round((w.length / trades.length) * 1000) / 10 : 0,
      totalPnlUsd: Math.round(totalPnl * 100) / 100,
      grossProfit: Math.round(gp * 100) / 100,
      grossLoss:   Math.round(gl * 100) / 100,
      profitFactor: gl === 0 ? (gp > 0 ? 99 : 0) : Math.round((gp / gl) * 100) / 100,
      avgWin:  w.length ? Math.round((gp / w.length) * 100) / 100 : 0,
      avgLoss: l.length ? Math.round((gl / l.length) * 100) / 100 : 0,
      sharpeRatio: Math.round(sharpe * 100) / 100,
      maxDrawdown:    Math.round(maxDD * 100) / 100,
      maxDrawdownPct: peak > 0 ? Math.round((maxDD / peak) * 1000) / 10 : 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. CHAT (Claude AI + enhanced rule-based fallback) ────────────────────────
export async function handleAiChat(ctx: RequestContext) {
  const { res, body } = ctx;
  const b = body as { message?: string; context?: Record<string, unknown> } | undefined;
  const userMessage = b?.message ?? "";
  const context     = b?.context ?? {};

  const client = getAnthropic();

  if (client && userMessage) {
    // ── Real Claude AI streaming ─────────────────────────────────────────────
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const signals   = (context.signals  as { symbol: string; signalType: string; confidence: number; entryPrice?: number }[]) ?? [];
    const positions = (context.positions as { symbol: string; side: string; pnl: number }[]) ?? [];
    const quotes    = (context.quotes    as Record<string, { mid: number; changePct: number }>) ?? {};
    const confScore = (context.confidenceScore as number) ?? 0;

    const systemPrompt = `You are OLOS, IGFXPRO's institutional-grade AI trading assistant. You have deep expertise in:
- Technical analysis (RSI, MACD, EMA, Bollinger Bands, Smart Money Concepts)
- Forex, indices, commodities, crypto, and equity CFD trading
- Risk management (ESMA regulations, leverage limits, margin management)
- IGFXPRO's platform features (iTrader terminal, autopilot, backtesting)

CURRENT MARKET DATA (live, use this in responses):
- Active OLOS signals (${signals.length} total): ${signals.slice(0, 5).map(s => `${s.symbol} ${s.signalType} ${s.confidence.toFixed(0)}%`).join(", ") || "scanning..."}
- Overall confidence score: ${(confScore * 100).toFixed(1)}%
- Open positions (${positions.length}): ${positions.map(p => `${p.symbol} ${p.side} P&L:${p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)}`).join(", ") || "none"}
- Live quotes: ${Object.entries(quotes).slice(0, 6).map(([s, q]) => `${s}:${q.mid.toFixed(5)} (${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%)`).join(", ") || "loading"}

RULES:
- Be specific and data-driven. Reference actual signals, prices, and conditions above.
- Always include risk warnings for trading recommendations.
- Respond concisely but with professional depth. Max 3 paragraphs.
- Language: respond in the same language as the user's message.
- Never guarantee profits. Always emphasize risk management.`;

    try {
      const stream = await client.messages.stream({
        model:      "claude-opus-4-8",
        max_tokens: 600,
        system:     systemPrompt,
        messages:   [{ role: "user", content: userMessage }],
      });

      for await (const chunk of stream) {
        if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
          res.write(`data: ${JSON.stringify({ token: chunk.delta.text })}\n\n`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI unavailable";
      res.write(`data: ${JSON.stringify({ token: `[OLOS AI error: ${msg}]` })}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
    return null;
  }

  // ── Enhanced rule-based fallback (real market data) ──────────────────────
  const signals   = (context.signals  as { symbol: string; signalType: string; confidence: number; entryPrice?: number; stopLoss?: number; timeframe?: string; entryRationale?: string }[]) ?? [];
  const positions = (context.positions as { symbol: string; side: string; pnl: number }[]) ?? [];
  const confScore = (context.confidenceScore as number) ?? 0;
  const lower     = userMessage.toLowerCase();

  const activeSignals = signals.filter(s => (s as unknown as { status?: string }).status === "ACTIVE" || !( "status" in s));
  const buys = activeSignals.filter(s => s.signalType === "BUY").sort((a, b) => b.confidence - a.confidence);
  const sells = activeSignals.filter(s => s.signalType === "SELL").sort((a, b) => b.confidence - a.confidence);

  // Get real indicator snapshot for mentioned symbol if available
  const symMatch = userMessage.match(/[A-Z]{2,6}USD|XAUUSD|US500|US100|BTCUSD|ETHUSD|EURUSD|GBPUSD|USDJPY|GBPJPY/i);
  const mentionedSym = symMatch ? symMatch[0].toUpperCase() : null;

  let reply = "";

  if (lower.includes("ciao") || lower.includes("hello") || lower.includes("salve") || lower.includes("hey")) {
    reply = `Benvenuto! Sono OLOS, l'intelligenza artificiale di IGFXPRO. In questo momento monitoro **${activeSignals.length} segnali attivi** su Forex, Indici, Commodities e Crypto con una confidence media del **${activeSignals.length ? (activeSignals.reduce((s, x) => s + x.confidence, 0) / activeSignals.length).toFixed(0) : 0}%**. Il tuo portafoglio ha **${positions.length} posizioni aperte**. Come posso aiutarti?`;

  } else if (lower.includes("confidence") || lower.includes("fiducia") || lower.includes("affidabile")) {
    const pct = (confScore * 100).toFixed(1);
    const status = confScore > 0.7 ? "ALTA — i modelli concordano, le condizioni di mercato sono favorevoli" : confScore > 0.4 ? "MODERATA — procedi con cautela e attendi conferme" : "BASSA — mercato incerto, meglio attendere";
    reply = `Il **confidence score OLOS globale è ${pct}%** — stato: ${status}. Il punteggio è calcolato da 6 fattori: allineamento trend, momentum (RSI+MACD), contesto volatilità, conferma volume, allineamento macro e timing di sessione. Con ${buys.length} segnali BUY e ${sells.length} SELL attivi, il sistema ${buys.length > sells.length ? "mostra un bias rialzista complessivo" : buys.length < sells.length ? "mostra un bias ribassista" : "è neutro"}.`;

  } else if (lower.includes("comprar") || lower.includes("buy") || lower.includes("acquist") || lower.includes("long") || lower.includes("oggi")) {
    if (!buys.length) {
      reply = `Nessun segnale BUY attivo in questo momento. OLOS sta monitorando ${activeSignals.length} strumenti e genererà un nuovo segnale alla prossima finestra di valutazione (ogni 60 secondi). La confidence attuale è ${(confScore * 100).toFixed(0)}% — considera di aspettare un setup più chiaro.`;
    } else {
      const top = buys[0]!;
      reply = `**Miglior segnale BUY attivo: ${top.symbol}** — confidence **${top.confidence.toFixed(0)}%** su ${top.timeframe ?? "H1"}. ${top.entryPrice ? `Entry suggerita: **${top.entryPrice.toFixed(5)}**${top.stopLoss ? `, SL: ${top.stopLoss.toFixed(5)}` : ""}. ` : ""}${top.entryRationale ?? "Segnale basato su confluenza RSI+MACD+EMA."} ${buys.length > 1 ? `\n\nAltri ${buys.length - 1} segnali BUY: ${buys.slice(1, 4).map(s => `${s.symbol} (${s.confidence.toFixed(0)}%)`).join(", ")}.` : ""} Gestisci sempre il rischio: max 1-2% del capitale per trade.`;
    }

  } else if (lower.includes("sell") || lower.includes("vend") || lower.includes("short") || lower.includes("ribass")) {
    if (!sells.length) {
      reply = `Nessun segnale SELL attivo al momento. Il sistema identifica opportunità short solo quando ci sono almeno 3 fattori convergenti in direzione ribassista (trend, momentum e conferma volume). Patience è fondamentale nel trading professionale.`;
    } else {
      const top = sells[0]!;
      reply = `**Miglior segnale SELL attivo: ${top.symbol}** — confidence **${top.confidence.toFixed(0)}%** su ${top.timeframe ?? "H1"}. ${top.entryPrice ? `Entry suggerita: **${top.entryPrice.toFixed(5)}**. ` : ""}${top.entryRationale ?? ""} ${sells.length > 1 ? `\n\nAltri ${sells.length - 1} segnali SELL: ${sells.slice(1, 4).map(s => `${s.symbol} (${s.confidence.toFixed(0)}%)`).join(", ")}.` : ""}`;
    }

  } else if (mentionedSym) {
    const symSigs = activeSignals.filter(s => s.symbol === mentionedSym);
    const candles = getCandles(mentionedSym, "1H");
    const closes  = candles.map(c => c.close);
    const rsi     = closes.length > 14 ? calcRSI(closes).slice(-1)[0]?.toFixed(1) ?? "N/A" : "N/A";
    const { hist } = closes.length > 26 ? calcMACD(closes) : { hist: [] };
    const macdBias = hist.length ? (hist.slice(-1)[0]! > 0 ? "BULLISH" : "BEARISH") : "N/A";
    const ema20 = closes.length > 20 ? calcEMA(closes, 20).slice(-1)[0]?.toFixed(5) ?? "N/A" : "N/A";
    const atr   = candles.length > 14 ? (calcATR(candles) / (mentionedSym.includes("JPY") ? 0.01 : 0.0001)).toFixed(1) : "N/A";

    if (!symSigs.length) {
      reply = `**Analisi ${mentionedSym}** — RSI(14): **${rsi}**, MACD bias: **${macdBias}**, EMA20: **${ema20}**, ATR: **${atr} pip**. Nessun segnale OLOS attivo su questo strumento. Il sistema ha un cooldown di 4 ore tra i segnali per evitare overtrading. Monitora le condizioni e attendi un setup con confluenza su almeno 3 indicatori.`;
    } else {
      const top = symSigs.sort((a, b) => b.confidence - a.confidence)[0]!;
      reply = `**Analisi ${mentionedSym}** — RSI(14): **${rsi}**, MACD bias: **${macdBias}**, EMA20: **${ema20}**, ATR: **${atr} pip**.\n\nSegnale OLOS attivo: **${top.signalType}** con confidence **${top.confidence.toFixed(0)}%**. ${top.entryPrice ? `Entry: ${top.entryPrice.toFixed(5)}` : ""}${top.stopLoss ? ` · SL: ${top.stopLoss.toFixed(5)}` : ""}. ${top.entryRationale ?? ""}`;
    }

  } else if (lower.includes("posizion") || lower.includes("portafoglio") || lower.includes("portfolio")) {
    if (!positions.length) {
      reply = `Non hai posizioni aperte al momento. Usa il terminale iTrader o i segnali OLOS per identificare la prossima opportunità. Il sistema ha ${activeSignals.length} segnali attivi da analizzare.`;
    } else {
      const totalPnl = positions.reduce((s, p) => s + p.pnl, 0);
      reply = `**Portafoglio aperto**: ${positions.length} posizioni — P&L totale non realizzato: **${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}**. Posizioni: ${positions.map(p => `${p.symbol} ${p.side} (${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)})`).join(", ")}. ${totalPnl < 0 ? "⚠️ Il portfolio è in perdita. Considera di rivedere il risk management." : "Il portfolio è in profitto. Monitora il livello di margine e gestisci gli stop."}`;
    }

  } else if (lower.includes("top") || lower.includes("miglior") || lower.includes("best")) {
    const top = activeSignals.sort((a, b) => b.confidence - a.confidence)[0];
    if (!top) {
      reply = `Nessun segnale attivo al momento. OLOS sta scansionando i mercati. La confidence attuale è ${(confScore * 100).toFixed(0)}%.`;
    } else {
      reply = `**Top segnale OLOS**: ${top.signalType} su **${top.symbol}** — confidence **${top.confidence.toFixed(0)}%** su timeframe ${top.timeframe ?? "H1"}. ${top.entryRationale ?? "Confluenza tecnica multifattore confermata."} Ricorda di impostare sempre stop loss e rispettare il tuo piano di money management.`;
    }

  } else if (lower.includes("backt") || lower.includes("strategia") || lower.includes("strategy")) {
    reply = `OLOS include un **Backtesting Lab reale** con 5 strategie (Momentum, Mean Reversion, Breakout, Trend Follow, Scalp). Naviga su OLOS AI → Backtesting Lab per testare le performance storiche su dati reali. Per creare strategie personalizzate usa il **Strategy Builder** che analizza gli indicatori live (RSI, MACD, EMA, ATR) e genera entry/exit conditions specifiche per il simbolo scelto.`;

  } else if (lower.includes("hedge") || lower.includes("copertura") || lower.includes("rischio")) {
    reply = `L'**Hedge Manager OLOS** calcola correlazioni Pearson in tempo reale tra tutti gli strumenti usando gli ultimi 60 candles. Per ogni posizione aperta identifica lo strumento correlato ottimale e suggerisce la dimensione del hedge per ridurre il rischio del portafoglio. Vai su OLOS AI → Hedge Manager. Attualmente hai ${positions.length} posizione${positions.length !== 1 ? "i" : "e"} aperte.`;

  } else {
    reply = `Ho ricevuto la tua domanda. In questo momento OLOS monitora **${activeSignals.length} segnali** su Forex, Crypto, Indici e Commodities. Confidence media: **${activeSignals.length ? (activeSignals.reduce((s, x) => s + x.confidence, 0) / activeSignals.length).toFixed(0) : 0}%**. Puoi chiedermi: analisi di un simbolo (es. "Analizza EURUSD"), migliori opportunità BUY/SELL, stato del portafoglio, o informazioni su backtest e hedge. ${!getAnthropic() ? "\n\n*Nota: Configura ANTHROPIC_API_KEY nel .env per abilitare risposte AI complete.*" : ""}`;
  }

  // SSE even for fallback
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Simulate streaming word by word
  const words = reply.split(" ");
  for (const word of words) {
    res.write(`data: ${JSON.stringify({ token: word + " " })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
  return null;
}

// ── 2. BACKTEST ────────────────────────────────────────────────────────────────
export async function handleBacktest(ctx: RequestContext) {
  const b = ctx.body as {
    symbol?: string; timeframe?: string; strategy?: string;
    dateFrom?: string; dateTo?: string;
    initialCapital?: number; riskPerTrade?: number;
  };

  const symbol    = (b?.symbol    ?? "EURUSD").toUpperCase();
  const timeframe = (b?.timeframe ?? "1H") as "1M" | "5M" | "15M" | "30M" | "1H" | "4H" | "1D";
  const strategy  = (b?.strategy  ?? "OLOS Momentum") as StrategyId;
  const capital   = b?.initialCapital ?? 10000;

  let candles = getCandles(symbol, timeframe);

  // Filter by date range if provided
  if (b?.dateFrom) {
    const from = new Date(b.dateFrom).getTime() / 1000;
    candles = candles.filter(c => c.time >= from);
  }
  if (b?.dateTo) {
    const to = new Date(b.dateTo).getTime() / 1000;
    candles = candles.filter(c => c.time <= to);
  }

  const result = runBacktest(candles, strategy, symbol, capital);

  const period = candles.length > 0 ? {
    from: new Date(candles[0]!.time * 1000).toISOString(),
    to:   new Date(candles[candles.length - 1]!.time * 1000).toISOString(),
  } : { from: "-", to: "-" };

  return {
    symbol, timeframe, strategy,
    candlesAnalyzed: candles.length,
    period,
    ...result,
  };
}

// ── 3. STRATEGY BUILDER ────────────────────────────────────────────────────────
export async function handleStrategyGen(ctx: RequestContext) {
  const b = ctx.body as { symbol?: string; timeframe?: string; riskLevel?: string };
  const symbol    = (b?.symbol    ?? "EURUSD").toUpperCase();
  const timeframe = (b?.timeframe ?? "1H") as "1M" | "5M" | "15M" | "1H" | "4H" | "1D";
  const riskLevel = (b?.riskLevel ?? "MEDIUM") as "LOW" | "MEDIUM" | "HIGH";

  const candles = getCandles(symbol, timeframe);
  const closes  = candles.map(c => c.close);

  if (closes.length < 30) {
    return { error: "Insufficient data", note: "Wait for more candle data to accumulate (need 30+ candles)." };
  }

  const rsiArr    = calcRSI(closes);
  const { hist }  = calcMACD(closes);
  const ema20Arr  = calcEMA(closes, 20);
  const ema50Arr  = calcEMA(closes, 50);
  const atr       = calcATR(candles);

  const rsi  = rsiArr.slice(-1)[0]  ?? 50;
  const macdH = hist.slice(-1)[0]   ?? 0;
  const macdPrev = hist.slice(-2)[0] ?? 0;
  const ema20 = ema20Arr.slice(-1)[0] ?? closes.slice(-1)[0]!;
  const ema50 = ema50Arr.slice(-1)[0] ?? closes.slice(-1)[0]!;
  const price = closes.slice(-1)[0]!;

  const pipSize = symbol.includes("JPY") ? 0.01 : symbol.includes("BTC") || symbol.includes("US5") || symbol.includes("US1") ? 1 : 0.0001;
  const atrPips = atr / pipSize;

  // Determine bias from indicators
  const bullPoints =
    (rsi < 50 ? 1 : 0) +
    (macdH > 0 ? 1 : 0) +
    (price > ema20 ? 1 : 0) +
    (price > ema50 ? 1 : 0) +
    (ema20 > ema50 ? 1 : 0);

  const bias: "BUY" | "SELL" | "NEUTRAL" = bullPoints >= 3 ? "BUY" : bullPoints <= 2 ? "SELL" : "NEUTRAL";

  const slMult = riskLevel === "LOW" ? 1.0 : riskLevel === "MEDIUM" ? 1.5 : 2.5;
  const tpMult = riskLevel === "LOW" ? 1.5 : riskLevel === "MEDIUM" ? 2.5 : 4.0;
  const slPips = Math.round(atrPips * slMult * 10) / 10;
  const tpPips = Math.round(atrPips * tpMult * 10) / 10;
  const slPrice = bias === "BUY" ? price - slPips * pipSize : price + slPips * pipSize;
  const tpPrice = bias === "BUY" ? price + tpPips * pipSize : price - tpPips * pipSize;
  const rrRatio = tpPips / slPips;

  const confidence = Math.min(90, 40 + bullPoints * 10 + (Math.abs(rsi - 50) > 15 ? 10 : 0) + (Math.abs(macdH) > 0 ? 5 : 0));

  const macdBias = macdH > macdPrev ? "BULLISH cross" : "BEARISH cross";
  const rsiStatus = rsi < 30 ? "Oversold" : rsi > 70 ? "Overbought" : rsi < 45 ? "Weak bearish" : rsi > 55 ? "Weak bullish" : "Neutral";
  const trendStatus = price > ema50 ? "Bullish (above EMA50)" : "Bearish (below EMA50)";

  const strategyNames = {
    BUY:     ["OLOS Momentum Long", "OLOS Breakout Bull", "OLOS Trend Rider", "OLOS Accumulation Entry"],
    SELL:    ["OLOS Momentum Short", "OLOS Breakdown Bear", "OLOS Counter-Trend", "OLOS Distribution Exit"],
    NEUTRAL: ["OLOS Range Scalp", "OLOS Wait-and-See"],
  };
  const nameIdx = (symbol.charCodeAt(0) + timeframe.charCodeAt(0)) % strategyNames[bias].length;
  const name = strategyNames[bias][nameIdx]!;

  const entryConditions = bias === "BUY" ? [
    `RSI(14) = ${rsi.toFixed(1)} — ${rsiStatus} (entry on pullback below 50)`,
    `MACD Histogram: ${macdH.toFixed(6)} — ${macdBias}`,
    `Price ${price.toFixed(5)} ${price > ema20 ? "above" : "below"} EMA20 (${ema20.toFixed(5)})`,
    `Price ${price > ema50 ? "above" : "below"} EMA50 — ${trendStatus}`,
    `ATR(14) = ${atrPips.toFixed(1)} pip — volatility ${atrPips > 20 ? "HIGH" : atrPips > 10 ? "MEDIUM" : "LOW"}`,
  ] : [
    `RSI(14) = ${rsi.toFixed(1)} — ${rsiStatus} (entry on bounce above 50)`,
    `MACD Histogram: ${macdH.toFixed(6)} — ${macdBias}`,
    `Price ${price.toFixed(5)} ${price < ema20 ? "below" : "above"} EMA20 (${ema20.toFixed(5)})`,
    `Price ${price < ema50 ? "below" : "above"} EMA50 — ${trendStatus}`,
    `ATR(14) = ${atrPips.toFixed(1)} pip — use ATR-based sizing`,
  ];

  const exitConditions = [
    `Take profit at ${tpPrice.toFixed(pipSize === 1 ? 2 : 5)} (+${tpPips.toFixed(1)} pip · ${tpMult}x ATR)`,
    `Stop loss at ${slPrice.toFixed(pipSize === 1 ? 2 : 5)} (-${slPips.toFixed(1)} pip · ${slMult}x ATR)`,
    `RSI ${bias === "BUY" ? "crosses above 70 (exit on overbought)" : "crosses below 30 (exit on oversold)"}`,
    `MACD histogram ${bias === "BUY" ? "turns negative" : "turns positive"} — signal reversal`,
  ];

  const winRateEstimate = Math.round(45 + confidence * 0.2 + (rrRatio > 2 ? 5 : 0));

  return {
    name, symbol, timeframe, riskLevel, bias, confidence,
    currentPrice: price,
    entryPrice:   price,
    stopLoss:     Math.round(slPrice * 100000) / 100000,
    takeProfit:   Math.round(tpPrice * 100000) / 100000,
    stopLossPips: slPips,
    takeProfitPips: tpPips,
    riskRewardRatio: Math.round(rrRatio * 100) / 100,
    winRateEstimate,
    indicators: {
      rsi: Math.round(rsi * 10) / 10,
      macd: macdBias,
      ema20: Math.round(ema20 * 100000) / 100000,
      ema50: Math.round(ema50 * 100000) / 100000,
      atrPips: Math.round(atrPips * 10) / 10,
      trend: trendStatus,
    },
    entryConditions,
    exitConditions,
    description: `${bias === "BUY" ? "Bullish" : bias === "SELL" ? "Bearish" : "Neutral"} strategy on ${symbol} (${timeframe}). Risk: ${riskLevel}. R:R = 1:${rrRatio.toFixed(1)}. Based on ${bullPoints}/5 bullish indicator readings. Confidence: ${confidence.toFixed(0)}%.`,
    candlesUsed: closes.length,
    generatedAt: new Date().toISOString(),
  };
}

// ── 4. HEDGE MANAGER ──────────────────────────────────────────────────────────
export async function handleHedge(_ctx: RequestContext) {
  const b = _ctx.body as {
    positions?: { id: string; symbol: string; side: "BUY" | "SELL"; quantity: number; pnl?: number }[];
  };
  const positions = b?.positions ?? [];

  const ALL_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "US500", "US100", "BTCUSD", "ETHUSD", "XAGUSD", "WTI", "GBPJPY", "EURGBP", "AUDUSD", "USDCHF"];
  const TIMEFRAME  = "1H" as const;
  const N_CORR     = 60;

  // Fetch candle closes for all symbols
  const closesCache: Record<string, number[]> = {};
  for (const sym of ALL_SYMBOLS) {
    const c = getCandles(sym, TIMEFRAME);
    if (c.length >= 10) {
      closesCache[sym] = c.map(x => x.close);
    }
  }

  const suggestions = positions.map(pos => {
    const posCloses = closesCache[pos.symbol];
    if (!posCloses || posCloses.length < 10) {
      return {
        positionId: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        quantity: pos.quantity,
        pnl: pos.pnl ?? 0,
        correlations: [],
        topHedge: null,
        note: "Insufficient data for correlation",
      };
    }

    const correlations = ALL_SYMBOLS
      .filter(s => s !== pos.symbol && closesCache[s] && closesCache[s]!.length >= 10)
      .map(hedgeSym => {
        const corr = pearsonCorr(posCloses, closesCache[hedgeSym]!, N_CORR);
        return { symbol: hedgeSym, correlation: Math.round(corr * 1000) / 1000 };
      })
      .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    // Top hedge: most negatively correlated (natural hedge) or strong positive (scaling hedge)
    const naturalHedge = correlations.find(c => c.correlation < -0.3);
    const strongHedge  = naturalHedge ?? correlations[0];

    let topHedge = null;
    if (strongHedge) {
      const hedgeSide: "BUY" | "SELL" = strongHedge.correlation > 0
        ? (pos.side === "BUY" ? "SELL" : "BUY") // positive corr: opposite side
        : pos.side;                               // negative corr: same side

      const hedgeRatio = Math.abs(strongHedge.correlation);
      const hedgeSize  = Math.round(pos.quantity * hedgeRatio * 100) / 100;
      const riskReduction = Math.round(hedgeRatio * 60 + 5); // 5-65% range

      topHedge = {
        symbol:        strongHedge.symbol,
        correlation:   strongHedge.correlation,
        correlationType: strongHedge.correlation < 0 ? "Negative (natural hedge)" : "Positive (directional hedge)",
        hedgeSide,
        hedgeSize,
        riskReduction,
      };
    }

    return {
      positionId:   pos.id,
      symbol:       pos.symbol,
      side:         pos.side,
      quantity:     pos.quantity,
      pnl:          pos.pnl ?? 0,
      correlations: correlations.slice(0, 6),
      topHedge,
    };
  });

  // Build correlation matrix for top symbols
  const matrixSymbols = Object.keys(closesCache).slice(0, 8);
  const correlationMatrix: Record<string, Record<string, number>> = {};
  for (const s1 of matrixSymbols) {
    correlationMatrix[s1] = {};
    for (const s2 of matrixSymbols) {
      correlationMatrix[s1]![s2] = s1 === s2 ? 1 :
        Math.round(pearsonCorr(closesCache[s1]!, closesCache[s2]!, N_CORR) * 1000) / 1000;
    }
  }

  return {
    suggestions,
    correlationMatrix,
    dataQuality: {
      symbolsWithData: Object.keys(closesCache).length,
      candlesPerSymbol: N_CORR,
      computedAt: new Date().toISOString(),
    },
  };
}
