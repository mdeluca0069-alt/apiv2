/**
 * 250-users.js — Tier 2: 250 concurrent traders
 *
 * Certification thresholds (must all PASS for GO):
 *   Order P95 < 3000ms, Close P95 < 4000ms, HTTP 5xx = 0
 *
 * Outputs k6-results-250.json for certification-runner.ps1 to parse.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

const orderLatency   = new Trend("order_latency_ms_250", true);
const closeLatency   = new Trend("close_latency_ms_250", true);
const walletLatency  = new Trend("wallet_latency_ms_250", true);
const filledOrders   = new Counter("orders_filled_250");
const rejectedOrders = new Counter("orders_rejected_250");
const settledPos     = new Counter("positions_settled_250");
const doubleSettle   = new Counter("double_settlement_250");
const swapDuplicates = new Counter("swap_duplicates_250");
const http5xxCount   = new Counter("http_5xx_count_250");
const errorRate      = new Rate("http_errors_250");

const BASE_URL   = __ENV.BASE_URL || "http://localhost:3000";
const USER_COUNT = 250;

export const options = {
  scenarios: {
    scenario_250: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "20s", target: 250 },
        { duration: "60s", target: 250 },
        { duration: "10s", target: 0   },
      ],
    },
  },
  thresholds: {
    order_latency_ms_250: ["p(50)<600",  "p(95)<3000", "p(99)<5000"],
    close_latency_ms_250: ["p(95)<4000"],
    http_errors_250:      ["rate<0.001"],
    http_5xx_count_250:   ["count<1"],
  },
};

const SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"];
function padId(n) { return String(n).padStart(5, "0"); }

const vuTokens = {};

function getToken(vuId) {
  if (vuTokens[vuId]) return vuTokens[vuId];

  const idx   = (vuId - 1) % USER_COUNT;
  const email = `loadtest-${padId(idx)}@igfxpro-loadtest.internal`;

  const res = http.post(`${BASE_URL}/api/v1/auth/login/db`,
    JSON.stringify({ email, password: "TestPass123!" }),
    { headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.${(vuId >> 8) & 0xFF}.${vuId & 0xFF}.1` } });

  errorRate.add(res.status >= 500);
  if (res.status !== 200) return null;

  try {
    const token = JSON.parse(res.body).accessToken;
    if (token) vuTokens[vuId] = token;
    return token || null;
  } catch { return null; }
}

export default function () {
  const vuId = __VU;
  const token = getToken(vuId);
  if (!token) { sleep(1); return; }

  const idx  = (vuId - 1) % USER_COUNT;
  const auth = { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "X-Forwarded-For": `10.${(vuId >> 8) & 0xFF}.${vuId & 0xFF}.1` };

  // ── Wallet balance ────────────────────────────────────────────────────────────
  const tw = Date.now();
  const walletRes = http.get(`${BASE_URL}/api/v1/wallet/balance`, { headers: auth });
  walletLatency.add(Date.now() - tw);
  if (walletRes.status === 401) { delete vuTokens[vuId]; return; }
  if (walletRes.status >= 500) { http5xxCount.add(1); errorRate.add(1); }

  sleep(0.05);

  // ── Place a market order ──────────────────────────────────────────────────────
  const symbol   = SYMBOLS[idx % SYMBOLS.length];
  const side     = idx % 2 === 0 ? "BUY" : "SELL";
  const clientId = `250-${padId(idx)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const t0 = Date.now();
  const openRes = http.post(`${BASE_URL}/api/v1/trading/order`, JSON.stringify({
    symbol, side, type: "MARKET", quantity: 1000, leverage: 10, clientOrderId: clientId,
  }), { headers: auth });
  orderLatency.add(Date.now() - t0);
  if (openRes.status >= 500) { http5xxCount.add(1); errorRate.add(1); }

  let positionId = null;
  try {
    const body = JSON.parse(openRes.body);
    if (body.status === "FILLED")   { filledOrders.add(1);   positionId = body.positionId; }
    if (body.status === "REJECTED") { rejectedOrders.add(1); }
  } catch {}

  check(openRes, {
    "open 200":           (r) => r.status === 200,
    "open not 5xx":       (r) => r.status < 500,
    "no duplicate (409)": (r) => r.status !== 409,
  });

  sleep(0.3);

  // ── Close position ────────────────────────────────────────────────────────────
  if (positionId) {
    const tc = Date.now();
    const closeRes = http.post(
      `${BASE_URL}/api/v1/trading/position/${positionId}/close`, "{}", { headers: auth });
    closeLatency.add(Date.now() - tc);
    if (closeRes.status >= 500) { http5xxCount.add(1); errorRate.add(1); }
    if (closeRes.status === 200) settledPos.add(1);
    else if (closeRes.status === 409 || closeRes.status === 422) doubleSettle.add(1);
    check(closeRes, { "close not 5xx": (r) => r.status < 500 });
  } else {
    const posRes = http.get(`${BASE_URL}/api/v1/trading/positions`, { headers: auth });
    let positions = [];
    try { const parsed = JSON.parse(posRes.body); if (Array.isArray(parsed)) positions = parsed; } catch {}
    for (const pos of positions.slice(0, 3)) {
      const tc = Date.now();
      const cr = http.post(
        `${BASE_URL}/api/v1/trading/position/${pos.id}/close`, "{}", { headers: auth });
      closeLatency.add(Date.now() - tc);
      if (cr.status >= 500) { http5xxCount.add(1); errorRate.add(1); }
      if (cr.status === 200) settledPos.add(1);
      else if (cr.status === 409 || cr.status === 422) doubleSettle.add(1);
    }
  }

  sleep(0.5);
}

export function handleSummary(data) {
  const m = data.metrics;
  function val(metric, stat) { return m[metric]?.values?.[stat] ?? null; }
  function cnt(metric)       { return m[metric]?.values?.count   ?? 0; }
  function rate(metric)      { return m[metric]?.values?.rate    ?? 0; }

  const results = {
    tier:              250,
    timestamp:         new Date().toISOString(),
    order_p50:         val("order_latency_ms_250", "p(50)"),
    order_p95:         val("order_latency_ms_250", "p(95)"),
    order_p99:         val("order_latency_ms_250", "p(99)"),
    close_p95:         val("close_latency_ms_250", "p(95)"),
    wallet_p95:        val("wallet_latency_ms_250", "p(95)"),
    orders_filled:     cnt("orders_filled_250"),
    orders_rejected:   cnt("orders_rejected_250"),
    positions_settled: cnt("positions_settled_250"),
    double_settlement: cnt("double_settlement_250"),
    swap_duplicates:   cnt("swap_duplicates_250"),
    http_5xx_count:    cnt("http_5xx_count_250"),
    http_error_rate:   rate("http_errors_250"),
    total_requests:    cnt("http_reqs"),
    test_duration_ms:  data.state?.testRunDurationMs ?? 0,
    thresholds_passed: Object.entries(data.metrics)
      .filter(([, m]) => m.thresholds)
      .every(([, m]) => Object.values(m.thresholds).every(Boolean)),
  };

  const p50  = results.order_p50;
  const p95  = results.order_p95;
  const p99  = results.order_p99;
  const p95c = results.close_p95;
  const p95w = results.wallet_p95;
  const dur  = results.test_duration_ms / 1000;
  const fmt  = (v) => typeof v === "number" ? v.toFixed(0) + "ms" : "N/A";

  return {
    stdout: `
=== TIER 2: 250 USERS — MEASURED RESULTS ===
Order  P50:              ${fmt(p50)}
Order  P95:              ${fmt(p95)}   [target <3000ms → ${p95 !== null && p95 < 3000 ? "PASS" : "FAIL"}]
Order  P99:              ${fmt(p99)}
Close  P95:              ${fmt(p95c)}  [target <4000ms → ${p95c !== null && p95c < 4000 ? "PASS" : "FAIL"}]
Wallet P95:              ${fmt(p95w)}
Orders filled:           ${results.orders_filled}
Orders rejected:         ${results.orders_rejected}
Positions settled:       ${results.positions_settled}
Double settlement (409): ${results.double_settlement}  [target 0 → ${results.double_settlement === 0 ? "PASS" : "FAIL"}]
Swap duplicates:         ${results.swap_duplicates}
HTTP 5xx count:          ${results.http_5xx_count}     [target 0 → ${results.http_5xx_count === 0 ? "PASS" : "FAIL"}]
Total requests:          ${results.total_requests}
Throughput:              ${(results.total_requests / dur).toFixed(1)} req/s
`,
    "k6-results-250.json": JSON.stringify(results, null, 2),
  };
}
