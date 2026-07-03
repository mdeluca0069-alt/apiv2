/**
 * EconomicCalendarService — fetches, persists, and serves economic calendar data.
 *
 * Data source: Finnhub /calendar/economic (FINNHUB_API_KEY required).
 * Refresh: every 6 hours via a registered distributed job.
 * Storage: EconomicEvent table (PostgreSQL) + in-memory cache for hot-path checks.
 *
 * Signal suppression: SignalGenerator calls hasHighImpactEventNearby(currency)
 * before evaluating confluence. If a HIGH or MEDIUM event is within 4 hours,
 * the macroEventIn4h flag is set → ConfidenceEngine suppresses the signal.
 *
 * Currency mapping: extracts the base and quote currency from the symbol
 * (e.g. EURUSD → EUR + USD) and checks both against upcoming events.
 */

import https from "node:https";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EconomicImpact = "low" | "medium" | "high";

export type EconomicEventRecord = {
  country:   string;
  currency:  string;
  event:     string;
  impact:    EconomicImpact;
  eventTime: Date;
  actual:    string | null;
  estimate:  string | null;
  prev:      string | null;
};

// Finnhub raw response shape
type FinnhubEconomicEvent = {
  country:  string;
  event:    string;
  impact:   string;
  time:     string;  // ISO date or datetime string
  actual:   string | null;
  estimate: string | null;
  prev:     string | null;
};

// ─── Country → Currency map ───────────────────────────────────────────────────

const COUNTRY_CURRENCY: Record<string, string> = {
  US: "USD",
  EU: "EUR",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  ES: "EUR",
  GB: "GBP",
  JP: "JPY",
  AU: "AUD",
  NZ: "NZD",
  CA: "CAD",
  CH: "CHF",
  CN: "CNH",
  HK: "HKD",
  SG: "SGD",
  NO: "NOK",
  SE: "SEK",
  BR: "BRL",
  IN: "INR",
};

// ─── Service ─────────────────────────────────────────────────────────────────

class EconomicCalendarService {
  /** In-memory cache: currency → list of upcoming events (sorted by eventTime asc) */
  private readonly _cache = new Map<string, EconomicEventRecord[]>();
  private _lastRefreshAt: Date | null = null;

  /**
   * Check whether a high or medium impact event is within `hoursAhead` hours
   * for any of the currencies involved in the given symbol.
   *
   * Called on every signal evaluation — must be synchronous and O(1).
   */
  hasHighImpactEventNearby(symbol: string, hoursAhead = 4): boolean {
    const currencies = this._extractCurrencies(symbol);
    const windowMs   = hoursAhead * 60 * 60 * 1_000;
    const now        = Date.now();

    for (const currency of currencies) {
      const events = this._cache.get(currency) ?? [];
      for (const ev of events) {
        const distance = ev.eventTime.getTime() - now;
        if (distance >= -15 * 60 * 1_000 && distance <= windowMs) {
          // Within window: -15min (just released) to +hoursAhead
          if (ev.impact === "high" || ev.impact === "medium") return true;
        }
      }
    }
    return false;
  }

  /**
   * Get all upcoming events within the next N hours for admin display.
   */
  getUpcomingEvents(hoursAhead = 24): EconomicEventRecord[] {
    const windowEnd = Date.now() + hoursAhead * 60 * 60 * 1_000;
    const now       = Date.now() - 15 * 60 * 1_000; // include recently released
    const out: EconomicEventRecord[] = [];

    for (const events of this._cache.values()) {
      for (const ev of events) {
        const t = ev.eventTime.getTime();
        if (t >= now && t <= windowEnd) out.push(ev);
      }
    }
    return out.sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
  }

  /** Returns the timestamp of the last successful refresh, or null. */
  getLastRefreshAt(): Date | null {
    return this._lastRefreshAt;
  }

  /**
   * Fetch events for the next 7 days from Finnhub, persist to DB, warm cache.
   * Safe to call on a schedule — handles missing API key gracefully.
   */
  async refresh(): Promise<{ fetched: number; persisted: number }> {
    const apiKey = process.env.FINNHUB_API_KEY ?? "";
    if (!apiKey) {
      console.warn("[economic-calendar] FINNHUB_API_KEY not set — calendar refresh skipped");
      return { fetched: 0, persisted: 0 };
    }

    const from = this._dateStr(new Date());
    const to   = this._dateStr(new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000));

    let raw: FinnhubEconomicEvent[];
    try {
      raw = await this._fetchFinnhub(apiKey, from, to);
    } catch (err) {
      console.error("[economic-calendar] Finnhub fetch failed:", (err as Error).message);
      // Warm cache from DB if Finnhub is unavailable
      await this._warmCacheFromDB();
      return { fetched: 0, persisted: 0 };
    }

    const mapped = raw
      .map((e) => this._mapEvent(e))
      .filter((e): e is EconomicEventRecord => e !== null);

    let persisted = 0;
    if (IS_PERSISTENT && prisma) {
      persisted = await this._persistEvents(mapped);
    }

    this._buildCache(mapped);
    this._lastRefreshAt = new Date();
    console.log(`[economic-calendar] refreshed — ${mapped.length} events fetched, ${persisted} new rows persisted`);
    return { fetched: mapped.length, persisted };
  }

  /**
   * Warm the in-memory cache from DB without calling Finnhub.
   * Used at startup and as fallback when Finnhub is unavailable.
   */
  async warmFromDB(): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;
    await this._warmCacheFromDB();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _extractCurrencies(symbol: string): string[] {
    // Standard FX pairs: EURUSD → [EUR, USD]
    const upper = symbol.toUpperCase().replace("/", "").replace("-", "").replace("_", "");
    if (upper.length === 6) {
      return [upper.slice(0, 3), upper.slice(3, 6)];
    }
    // Commodity / crypto / index: check known mappings
    if (upper === "XAUUSD" || upper === "XAGUSD") return ["USD"];
    if (upper.startsWith("BTC") || upper.startsWith("ETH")) return ["USD"];
    if (upper.includes("500") || upper.includes("100")) return ["USD"];
    if (upper === "DE40" || upper === "DAX") return ["EUR"];
    if (upper === "UK100" || upper === "FTSE") return ["GBP"];
    return ["USD"]; // safe fallback
  }

  private _buildCache(events: EconomicEventRecord[]): void {
    this._cache.clear();
    const now = Date.now() - 15 * 60 * 1_000;
    for (const ev of events) {
      if (ev.eventTime.getTime() < now) continue; // skip past events
      const list = this._cache.get(ev.currency) ?? [];
      list.push(ev);
      this._cache.set(ev.currency, list);
    }
    // Sort each list ascending
    for (const [cur, list] of this._cache) {
      this._cache.set(cur, list.sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime()));
    }
  }

  private async _warmCacheFromDB(): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;
    const db     = prisma as NonNullable<typeof prisma>;
    const cutoff = new Date(Date.now() - 15 * 60 * 1_000);
    try {
      const rows = await db.economicEvent.findMany({
        where:   { eventTime: { gte: cutoff } },
        orderBy: { eventTime: "asc" },
      });
      const mapped: EconomicEventRecord[] = rows.map((r) => ({
        country:   r.country,
        currency:  r.currency,
        event:     r.event,
        impact:    r.impact as EconomicImpact,
        eventTime: r.eventTime,
        actual:    r.actual,
        estimate:  r.estimate,
        prev:      r.prev,
      }));
      this._buildCache(mapped);
    } catch (err) {
      console.error("[economic-calendar] DB warm failed:", (err as Error).message);
    }
  }

  private async _persistEvents(events: EconomicEventRecord[]): Promise<number> {
    if (!IS_PERSISTENT || !prisma) return 0;
    const db = prisma as NonNullable<typeof prisma>;
    let count = 0;
    for (const ev of events) {
      try {
        // Dedup by (currency, eventTime, event) — skip if already stored
        const existing = await db.economicEvent.findFirst({
          where: {
            currency:  ev.currency,
            eventTime: ev.eventTime,
            event:     ev.event,
          },
          select: { id: true },
        });
        if (!existing) {
          await db.economicEvent.create({
            data: {
              country:   ev.country,
              currency:  ev.currency,
              event:     ev.event,
              impact:    ev.impact,
              eventTime: ev.eventTime,
              actual:    ev.actual,
              estimate:  ev.estimate,
              prev:      ev.prev,
            },
          });
          count++;
        }
      } catch { /* skip individual failures */ }
    }
    return count;
  }

  private _mapEvent(raw: FinnhubEconomicEvent): EconomicEventRecord | null {
    const currency = COUNTRY_CURRENCY[raw.country?.toUpperCase()] ?? null;
    if (!currency) return null;

    const impact = this._normalizeImpact(raw.impact);
    const eventTime = new Date(raw.time);
    if (isNaN(eventTime.getTime())) return null;

    return {
      country:   raw.country,
      currency,
      event:     raw.event ?? "Unknown",
      impact,
      eventTime,
      actual:    raw.actual   ?? null,
      estimate:  raw.estimate ?? null,
      prev:      raw.prev     ?? null,
    };
  }

  private _normalizeImpact(raw: string): EconomicImpact {
    const s = (raw ?? "").toLowerCase();
    if (s === "high" || s === "3") return "high";
    if (s === "medium" || s === "2") return "medium";
    return "low";
  }

  private _dateStr(d: Date): string {
    return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
  }

  private _fetchFinnhub(apiKey: string, from: string, to: string): Promise<FinnhubEconomicEvent[]> {
    return new Promise((resolve, reject) => {
      const path = `/api/v1/calendar/economic?from=${from}&to=${to}&token=${encodeURIComponent(apiKey)}`;
      const req  = https.request(
        { hostname: "finnhub.io", path, method: "GET", headers: { "Accept": "application/json" } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                economicCalendar?: FinnhubEconomicEvent[];
              };
              resolve(body.economicCalendar ?? []);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(10_000, () => { req.destroy(new Error("Finnhub request timeout")); });
      req.end();
    });
  }
}

export const economicCalendar = new EconomicCalendarService();
