/**
 * EconomicEventService — aggregates macro calendar events from all configured
 * sources (ForexFactory, TradingEconomics, FRED), deduplicates, persists to
 * the EconomicEvent table, and provides an O(1) in-memory gate for signal
 * generation: `macroEventInNext4Hours(symbol)`.
 *
 * Symbol → currency mapping covers the 28 major FX pairs by extracting the
 * base and quote currencies and checking both.
 */

import { prisma, IS_PERSISTENT } from "../shared/db.js";
import {
  fetchForexFactory,
  fetchTradingEconomics,
  fetchFRED,
  type FetchedEvent,
} from "./economic.event.fetcher.js";

// ─── Symbol → currency set ────────────────────────────────────────────────────

const SYMBOL_CURRENCIES: Record<string, string[]> = {
  EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], USDJPY: ["USD", "JPY"],
  AUDUSD: ["AUD", "USD"], USDCAD: ["USD", "CAD"], USDCHF: ["USD", "CHF"],
  NZDUSD: ["NZD", "USD"], EURJPY: ["EUR", "JPY"], GBPJPY: ["GBP", "JPY"],
  EURGBP: ["EUR", "GBP"], AUDJPY: ["AUD", "JPY"], EURAUD: ["EUR", "AUD"],
  EURCAD: ["EUR", "CAD"], EURCHF: ["EUR", "CHF"], GBPAUD: ["GBP", "AUD"],
  GBPCAD: ["GBP", "CAD"], GBPCHF: ["GBP", "CHF"], AUDCAD: ["AUD", "CAD"],
  AUDCHF: ["AUD", "CHF"], AUDNZD: ["AUD", "NZD"], CADCHF: ["CAD", "CHF"],
  CADJPY: ["CAD", "JPY"], CHFJPY: ["CHF", "JPY"], NZDCAD: ["NZD", "CAD"],
  NZDCHF: ["NZD", "CHF"], NZDJPY: ["NZD", "JPY"], XAUUSD: ["XAU", "USD"],
  XAGUSD: ["XAG", "USD"],
};

export function currenciesForSymbol(symbol: string): string[] {
  const upper = symbol.replace(/[^A-Z]/g, "").toUpperCase();
  if (SYMBOL_CURRENCIES[upper]) return SYMBOL_CURRENCIES[upper];
  // Fallback: split 6-char pair manually
  if (upper.length === 6) return [upper.slice(0, 3), upper.slice(3, 6)];
  return [];
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

type CachedEvent = {
  currency:  string;
  impact:    string;
  eventTime: number; // ms epoch
};

type CacheState = {
  events:       CachedEvent[];
  builtAt:      number;
  windowStart:  number;
  windowEnd:    number;
};

export type EconomicEventDetail = {
  country:   string;
  currency:  string;
  title:     string;
  impact:    string;
  eventTime: string; // ISO
  actual:    string | null;
  forecast:  string | null;
  previous:  string | null;
};

// ─── Service ──────────────────────────────────────────────────────────────────

class EconomicEventService {
  private _cache: CacheState | null = null;
  private _refreshing               = false;

  /** Called by signal.generator.ts — O(1) check against in-memory cache. */
  macroEventInNext4Hours(symbol: string, hoursAhead = 4): boolean {
    if (!this._cache) return false;
    const currencies = currenciesForSymbol(symbol);
    if (!currencies.length) return false;

    const now    = Date.now();
    const cutoff = now + hoursAhead * 60 * 60 * 1_000;

    return this._cache.events.some(
      (ev) =>
        currencies.includes(ev.currency) &&
        (ev.impact === "high" || ev.impact === "medium") &&
        ev.eventTime >= now &&
        ev.eventTime <= cutoff,
    );
  }

  /** Full refresh: fetch all sources, upsert to DB, rebuild cache. */
  async refresh(): Promise<void> {
    if (!IS_PERSISTENT) return;
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      const now  = new Date();
      const from = new Date(now.getTime() - 60 * 60 * 1_000);          // 1 h back (for actuals)
      const to   = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000); // 7 days forward

      const [ffEvents, teEvents, fredEvents] = await Promise.allSettled([
        fetchForexFactory(),
        fetchTradingEconomics(from, to),
        fetchFRED(from, to),
      ]);

      const all: FetchedEvent[] = [
        ...(ffEvents.status   === "fulfilled" ? ffEvents.value   : []),
        ...(teEvents.status   === "fulfilled" ? teEvents.value   : []),
        ...(fredEvents.status === "fulfilled" ? fredEvents.value : []),
      ];

      console.info(`[economic-calendar] Fetched ${all.length} events total`);

      await this._upsertAll(all);
      await this._rebuildCache(from, to);
    } finally {
      this._refreshing = false;
    }
  }

  /** Reconstruct cache from DB on startup — avoids cold-start blind spot. */
  async warmFromDB(): Promise<void> {
    if (!IS_PERSISTENT) return;
    const now  = new Date();
    const from = new Date(now.getTime() - 60 * 60 * 1_000);
    const to   = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
    await this._rebuildCache(from, to);
  }

  /**
   * True when a high-impact macro event for this symbol's currencies
   * fired within the last `minutesBack` minutes.
   * Used by RegimeEngine to set NEWS_DRIVEN regime.
   */
  hasRecentHighImpactEvent(symbol: string, minutesBack = 60): boolean {
    if (!this._cache) return false;
    const currencies = currenciesForSymbol(symbol);
    if (!currencies.length) return false;

    const now      = Date.now();
    const earliest = now - minutesBack * 60 * 1_000;

    return this._cache.events.some(
      (ev) =>
        currencies.includes(ev.currency) &&
        ev.impact === "high" &&
        ev.eventTime >= earliest &&
        ev.eventTime <= now,
    );
  }

  /**
   * Real, DB-backed upcoming events for the next N hours — used by the public
   * homepage calendar widget and by the OLOS Investment Brief. Optionally
   * scoped to a set of currencies (e.g. from `currenciesForSymbol`).
   */
  async getUpcoming(hoursAhead = 48, currencies?: string[]): Promise<EconomicEventDetail[]> {
    if (!IS_PERSISTENT) return [];
    const now    = new Date();
    const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1_000);
    const rows   = await prisma.economicEvent.findMany({
      where: {
        eventTime: { gte: now, lte: cutoff },
        impact:    { in: ["high", "medium"] },
        ...(currencies && currencies.length ? { currency: { in: currencies } } : {}),
      },
      orderBy: { eventTime: "asc" },
      select:  { country: true, currency: true, title: true, impact: true, eventTime: true, actual: true, forecast: true, previous: true },
    });
    return rows.map((r) => ({
      country:   r.country,
      currency:  r.currency,
      title:     r.title,
      impact:    r.impact,
      eventTime: r.eventTime.toISOString(),
      actual:    r.actual,
      forecast:  r.forecast,
      previous:  r.previous,
    }));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _upsertAll(events: FetchedEvent[]): Promise<void> {
    let upserted = 0;
    for (const ev of events) {
      try {
        await prisma.economicEvent.upsert({
          where: {
            currency_eventTime_title_source: {
              currency:  ev.currency,
              eventTime: ev.eventTime,
              title:     ev.title,
              source:    ev.source,
            },
          },
          create: {
            country:   ev.country,
            currency:  ev.currency,
            title:     ev.title,
            impact:    ev.impact,
            source:    ev.source,
            eventTime: ev.eventTime,
            actual:    ev.actual,
            forecast:  ev.forecast,
            previous:  ev.previous,
          },
          update: {
            actual:   ev.actual,
            forecast: ev.forecast,
            previous: ev.previous,
            impact:   ev.impact,
          },
        });
        upserted++;
      } catch (err) {
        console.warn("[economic-calendar] upsert failed for event:", ev.title, (err as Error).message);
      }
    }
    console.info(`[economic-calendar] Upserted ${upserted}/${events.length} events`);
  }

  private async _rebuildCache(from: Date, to: Date): Promise<void> {
    const rows = await prisma.economicEvent.findMany({
      where:   { eventTime: { gte: from, lte: to } },
      select:  { currency: true, impact: true, eventTime: true },
      orderBy: { eventTime: "asc" },
    });

    this._cache = {
      events:      rows.map((r) => ({ currency: r.currency, impact: r.impact, eventTime: r.eventTime.getTime() })),
      builtAt:     Date.now(),
      windowStart: from.getTime(),
      windowEnd:   to.getTime(),
    };

    console.info(`[economic-calendar] Cache rebuilt — ${this._cache.events.length} events in window`);
  }
}

export const economicEventService = new EconomicEventService();
