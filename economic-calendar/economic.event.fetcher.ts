/**
 * EconomicEventFetcher — retrieves macro calendar events from three sources:
 *
 *   1. ForexFactory  — XML calendar feed (high-impact FX events, no auth required)
 *   2. TradingEconomics — REST API (global coverage, TRADINGECONOMICS_API_KEY)
 *   3. FRED (St. Louis Fed) — US macro release schedule (FRED_API_KEY, free)
 *
 * Each fetcher is independent and fails gracefully. The EventService merges
 * and deduplicates results from all available sources.
 *
 * Environment variables:
 *   TRADINGECONOMICS_API_KEY  — TradingEconomics API key
 *   FRED_API_KEY              — FRED API key (free at fred.stlouisfed.org)
 *   FOREXFACTORY_CALENDAR_URL — override the ForexFactory XML URL (optional)
 */

import https from "node:https";

// ─── Shared output type ────────────────────────────────────────────────────────

export type FetchedEvent = {
  country:   string;
  currency:  string;
  title:     string;
  impact:    "low" | "medium" | "high";
  eventTime: Date;
  actual:    string | null;
  forecast:  string | null;
  previous:  string | null;
  source:    "FOREXFACTORY" | "TRADINGECONOMICS" | "FRED";
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function httpsGet(url: string, timeoutMs = 12_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path:     u.pathname + u.search,
        method:   "GET",
        headers:  { "User-Agent": "igfxpro/2 economic-calendar/1.0", "Accept": "*/*" },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(httpsGet(res.headers.location, timeoutMs));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          // A non-2xx response (rate-limited, blocked, moved) must surface as
          // a real error — otherwise an HTML error page silently parses to
          // "0 events" and looks identical to an honest empty calendar.
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120).replace(/\s+/g, " ")}`));
            return;
          }
          resolve(body);
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Request timeout")));
    req.end();
  });
}

const COUNTRY_CURRENCY: Record<string, string> = {
  US: "USD", EU: "EUR", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR",
  GB: "GBP", JP: "JPY", AU: "AUD", NZ: "NZD", CA: "CAD", CH: "CHF",
  CN: "CNH", HK: "HKD", SG: "SGD", NO: "NOK", SE: "SEK", BR: "BRL",
  MX: "MXN", IN: "INR", RU: "RUB", ZA: "ZAR", TR: "TRY",
};

function toCurrency(country: string): string {
  return COUNTRY_CURRENCY[country?.toUpperCase()] ?? country?.toUpperCase()?.slice(0, 3) ?? "UNK";
}

function normalizeImpact(raw: string): "low" | "medium" | "high" {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("high") || s === "3" || s === "red")    return "high";
  if (s.includes("med")  || s === "2" || s === "orange") return "medium";
  return "low";
}

// ─── 1. ForexFactory XML ──────────────────────────────────────────────────────
// ForexFactory publishes a best-effort XML feed. The URL may change; the
// default below is the documented community export format.

// "cdn-nfs.forexfactory.com" no longer resolves (NXDOMAIN). The community
// mirror below is the real, currently-working, no-auth XML feed.
const FF_BASE_URL =
  process.env.FOREXFACTORY_CALENDAR_URL ??
  "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";

export async function fetchForexFactory(): Promise<FetchedEvent[]> {
  let xml: string;
  try {
    xml = await httpsGet(FF_BASE_URL);
  } catch (err) {
    console.warn("[ff-fetcher] ForexFactory unreachable:", (err as Error).message);
    return [];
  }

  const events: FetchedEvent[] = [];
  // Simple regex-based XML extraction — no dependency required
  const blocks = xml.match(/<event>[\s\S]*?<\/event>/g) ?? [];

  for (const block of blocks) {
    const get = (tag: string) => {
      const raw = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim();
      if (!raw) return null;
      // Most fields (date/time/impact/forecast/previous/actual) are CDATA-wrapped.
      const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
      return (cdata ? cdata[1] : raw).trim() || null;
    };

    const title    = get("title");
    // The feed's <country> tag actually holds the 3-letter CURRENCY code
    // (e.g. "USD", "EUR", "CNY"), not an ISO country code.
    const currency = get("country");
    const impact   = get("impact");
    const dateStr  = get("date");
    const timeStr  = get("time") ?? "0:00am";

    if (!title || !currency || !dateStr) continue;

    const eventTime = _parseFFDateTime(dateStr, timeStr);
    if (!eventTime) continue;

    events.push({
      country:   currency.toUpperCase(),
      currency:  currency.toUpperCase(),
      title,
      impact:    normalizeImpact(impact ?? "low"),
      eventTime,
      actual:    get("actual"),
      forecast:  get("forecast"),
      previous:  get("previous"),
      source:    "FOREXFACTORY",
    });
  }

  return events;
}

function _parseFFDateTime(dateStr: string, timeStr: string): Date | null {
  try {
    // Real feed format: date "MM-DD-YYYY", time "H:MMam"/"H:MMpm" (or
    // non-numeric placeholders like "All Day"/"Tentative"/"Day 1").
    const [mm, dd, yyyy] = dateStr.split("-").map((s) => parseInt(s, 10));
    if (!mm || !dd || !yyyy) return null;

    const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
    let hour = 0, minute = 0;
    if (timeMatch) {
      hour   = parseInt(timeMatch[1], 10) % 12;
      minute = parseInt(timeMatch[2], 10);
      if (timeMatch[3].toLowerCase() === "pm") hour += 12;
    }
    // Non-numeric time placeholders ("All Day", "Tentative", "Day 1") fall
    // back to midnight on the given date — never Invalid Date.

    const dt = new Date(yyyy, mm - 1, dd, hour, minute);
    return isNaN(dt.getTime()) ? null : dt;
  } catch {
    return null;
  }
}

// ─── 2. TradingEconomics ──────────────────────────────────────────────────────

type TEEvent = {
  Country:     string;
  Category:    string;
  Date:        string;    // "2026-01-28T13:30:00"
  Actual:      string | null;
  Previous:    string | null;
  Forecast:    string | null;
  TEForecast:  string | null;
  Importance:  number;    // 1 = low, 2 = medium, 3 = high
};

export async function fetchTradingEconomics(from: Date, to: Date): Promise<FetchedEvent[]> {
  const key = process.env.TRADINGECONOMICS_API_KEY ?? "";
  if (!key) {
    console.warn("[te-fetcher] TRADINGECONOMICS_API_KEY not set — skipping");
    return [];
  }

  const d1  = from.toISOString().slice(0, 10);
  const d2  = to.toISOString().slice(0, 10);
  const url = `https://api.tradingeconomics.com/calendar?c=${encodeURIComponent(key)}&d1=${d1}&d2=${d2}&format=json`;

  let raw: string;
  try {
    raw = await httpsGet(url);
  } catch (err) {
    console.warn("[te-fetcher] TradingEconomics unreachable:", (err as Error).message);
    return [];
  }

  let parsed: TEEvent[];
  try {
    parsed = JSON.parse(raw) as TEEvent[];
    if (!Array.isArray(parsed)) return [];
  } catch {
    console.warn("[te-fetcher] TradingEconomics response parse failed");
    return [];
  }

  const events: FetchedEvent[] = [];
  for (const ev of parsed) {
    const eventTime = new Date(ev.Date);
    if (isNaN(eventTime.getTime())) continue;

    const currency = toCurrency(ev.Country ?? "");
    if (currency === "UNK") continue;

    const impactNum = Number(ev.Importance ?? 1);
    const impact: "low" | "medium" | "high" =
      impactNum >= 3 ? "high" : impactNum === 2 ? "medium" : "low";

    events.push({
      country:   (ev.Country ?? "").toUpperCase(),
      currency,
      title:     ev.Category ?? "Economic Event",
      impact,
      eventTime,
      actual:    ev.Actual  ?? null,
      forecast:  ev.Forecast ?? ev.TEForecast ?? null,
      previous:  ev.Previous ?? null,
      source:    "TRADINGECONOMICS",
    });
  }

  return events;
}

// ─── 3. FRED (St. Louis Federal Reserve) ─────────────────────────────────────
// FRED provides US economic data release schedules. We fetch upcoming release
// dates for major series (NFP, CPI, GDP, FOMC minutes, etc.).

type FREDReleaseDate = {
  release_id:   number;
  release_name: string;
  date:         string;  // "2026-01-28"
};

// NOTE: "FOMC"/"Federal Open Market Committee" deliberately excluded — FRED's
// /fred/releases/dates returns release_id 101 ("FOMC Press Release") with a
// row for nearly every business day (39 dates in a 61-day window observed),
// not real meeting dates. This is a FRED metadata quirk for that specific
// release, not a real cadence — including it would flood the calendar with
// fabricated-looking duplicate entries. ForexFactory already covers FOMC
// events correctly with real meeting dates, so no coverage is lost.
const FRED_HIGH_IMPACT_RELEASES = new Set([
  "Employment Situation",            // NFP
  "Consumer Price Index",            // CPI
  "Gross Domestic Product",          // GDP
  "Producer Price Index",            // PPI
  "Retail Sales",
  "Nonfarm Payroll",
  "Personal Income and Outlays",
  "Industrial Production",
  "Durable Goods Orders",
]);

const FRED_MEDIUM_IMPACT_RELEASES = new Set([
  "Initial Claims",
  "Trade Balance",
  "ISM Manufacturing",
  "ISM Services",
  "Existing Home Sales",
  "New Residential Sales",
  "Building Permits",
  "Consumer Confidence",
  "University of Michigan",
]);

export async function fetchFRED(from: Date, to: Date): Promise<FetchedEvent[]> {
  const key = process.env.FRED_API_KEY ?? "";
  if (!key) {
    console.warn("[fred-fetcher] FRED_API_KEY not set — skipping");
    return [];
  }

  const d1 = from.toISOString().slice(0, 10);
  const d2 = to.toISOString().slice(0, 10);

  // Fetch upcoming release dates for the window
  // include_release_dates_with_no_data MUST be true — this is a forward-looking
  // calendar of scheduled releases, and future releases never have data yet
  // (false silently returns zero rows for any future-dated window).
  const url = `https://api.stlouisfed.org/fred/releases/dates?api_key=${encodeURIComponent(key)}&realtime_start=${d1}&realtime_end=${d2}&limit=500&include_release_dates_with_no_data=true&file_type=json`;

  let raw: string;
  try {
    raw = await httpsGet(url);
  } catch (err) {
    console.warn("[fred-fetcher] FRED unreachable:", (err as Error).message);
    return [];
  }

  let parsed: { release_dates?: FREDReleaseDate[] };
  try {
    parsed = JSON.parse(raw) as { release_dates?: FREDReleaseDate[] };
  } catch {
    console.warn("[fred-fetcher] FRED response parse failed");
    return [];
  }

  const releaseDates = parsed.release_dates ?? [];
  const events: FetchedEvent[] = [];

  for (const rd of releaseDates) {
    const eventTime = new Date(rd.date + "T12:30:00Z"); // FRED releases typically at 8:30 ET = 12:30 UTC
    if (isNaN(eventTime.getTime())) continue;
    if (eventTime < from || eventTime > to) continue;

    const name   = rd.release_name ?? "";
    const isHigh = [...FRED_HIGH_IMPACT_RELEASES].some((h) => name.toLowerCase().includes(h.toLowerCase()));
    const isMed  = !isHigh && [...FRED_MEDIUM_IMPACT_RELEASES].some((m) => name.toLowerCase().includes(m.toLowerCase()));

    if (!isHigh && !isMed) continue; // skip low-impact FRED releases

    events.push({
      country:   "US",
      currency:  "USD",
      title:     name,
      impact:    isHigh ? "high" : "medium",
      eventTime,
      actual:    null,
      forecast:  null,
      previous:  null,
      source:    "FRED",
    });
  }

  return events;
}
