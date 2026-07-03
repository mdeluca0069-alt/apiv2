/**
 * getRegimeSnapshot — shared real ADX(14) + EMA(50/200) + ATR(14) replay,
 * extracted from the /api/v1/ai/regime route so the OLOS Investment Brief
 * endpoint can reuse the exact same classifier without duplicating the
 * candle-replay loop. Never fabricated — INSUFFICIENT_DATA below 210 candles.
 */
import { RegimeEngine }     from "./regime.engine.js";
import { VolatilityEngine } from "./volatility.engine.js";
import { getCandles }       from "../market-data/candle.aggregator.js";
import type { Timeframe }   from "../market-data/candle.aggregator.js";

export type RegimeSnapshot =
  | {
      status: "INSUFFICIENT_DATA";
      candlesAvailable: number;
      candlesRequired:  210;
      regime: null; adx: null; adxSlope: null; trending: null;
      description: null; atr: null; atrNormalized: null; volatilityLevel: null;
    }
  | {
      status: "ACTIVE";
      regime:          string;
      adx:             number;
      adxSlope:        number;
      trending:        boolean;
      description:     string;
      atr:             number | null;
      atrNormalized:   number | null;
      volatilityLevel: string | null;
      asOf:            string;
    };

export function getRegimeSnapshot(symbol: string, timeframe: Timeframe): RegimeSnapshot {
  const candles = getCandles(symbol, timeframe);

  if (candles.length < 210) {
    return {
      status: "INSUFFICIENT_DATA",
      candlesAvailable: candles.length, candlesRequired: 210,
      regime: null, adx: null, adxSlope: null, trending: null,
      description: null, atr: null, atrNormalized: null, volatilityLevel: null,
    };
  }

  const regimeEngine = new RegimeEngine();
  const volEngine    = new VolatilityEngine();
  let lastRegime: ReturnType<RegimeEngine["next"]> = null;
  let lastVol:    ReturnType<VolatilityEngine["next"]> = null;

  for (const c of candles) {
    const ohlcv = { open: c.open, high: c.high, low: c.low, close: c.close };
    lastVol    = volEngine.next(ohlcv) ?? lastVol;
    lastRegime = regimeEngine.next(ohlcv, lastVol ? {
      atrNormalized: lastVol.atrNormalized,
      atrExpanding:  lastVol.expanding,
    } : undefined) ?? lastRegime;
  }

  if (!lastRegime) {
    return {
      status: "INSUFFICIENT_DATA",
      candlesAvailable: candles.length, candlesRequired: 210,
      regime: null, adx: null, adxSlope: null, trending: null,
      description: null, atr: null, atrNormalized: null, volatilityLevel: null,
    };
  }

  return {
    status: "ACTIVE",
    regime:          lastRegime.regime,
    adx:             lastRegime.adx,
    adxSlope:        lastRegime.adxSlope,
    trending:        lastRegime.trending,
    description:     lastRegime.description,
    atr:             lastVol?.atr ?? null,
    atrNormalized:   lastVol?.atrNormalized ?? null,
    volatilityLevel: lastVol?.level ?? null,
    asOf:            new Date().toISOString(),
  };
}
