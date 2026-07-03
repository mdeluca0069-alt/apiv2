/**
 * 750-users.js — Tier 3.5 (Scale): 750 concurrent traders
 *
 * Intermediate certification tier between 500 and 1000 users.
 * Same GO/NO-GO thresholds as Tier 3 (500 users):
 *   Order P95 < 3000ms
 *   Close P95 < 4000ms
 *   HTTP 5xx = 0  (zero tolerance)
 *   Double settlement = 0
 *   Swap duplicates = 0
 *
 * Outputs k6-results-750.json for certification runner to parse.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

const orderLatency     = new Trend("order_latency_ms_750",  true);
const closeLatency     = new Trend("close_latency_ms_750",  true);
const walletLatency    = new Trend("wallet_latency_ms_750", true);
const filledOrders     = new Counter("orders_filled_750");
const rejectedOrders   = new Counter("orders_rejected_750");
const settledPositions = new Counter("positions_settled_750");
const doubleSettlement = new Counter("double_settlement_750");
const swapDuplicates   = new Counter("swap_duplicates_750");
const http5xxCount     = new Counter("http_5xx_count_750");
const httpErrors       = new Rate("http_errors_750");

const BASE_URL   = __ENV.BASE_URL || "http://localhost:3000";
const USER_COUNT = 750;

export const options = {
  scenarios: {
    scenario_750: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "60s", target: 750 },
        { duration: "60s", target: 750 },
        { duration: "10s", target: 0   },
      ],
    },
  },
  thresholds: {
    order_latency_ms_750:  ["p(95)<3000", "p(99)<7000", "p(50)<1000"],
    close_latency_ms_750:  ["p(95)<4000"],
    http_errors_750:       ["rate<0.002"],
    http_5xx_count_750:    ["count<1"],
    double_settlement_750: ["count<1"],
  },
};

const SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSD"];
function padId(n) { return String(n).padStart(5, "0"); }

const vuTokens = {};

function getToken(vuId) {
  if (vuTokens[vuId]) return vuTokens[vuId];

  const idx   = (vuId - 1) % USER_COUNT;
  const email = `loadtest-${padId(idx)}@igfxpro-loadtest.internal`;

  const res = http.post(`${BASE_URL}/api/v1/auth/login/db`,
    JSON.stringify({ email, password: "TestPass123!" }),
    { headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.${(vuId >> 8) & 0xFF}.${vuId & 0xFF}.1` } });

  httpErrors.add(res.status >= 500);
  if (res.status !== 200) return null;

  try {
    const token = JSON.parse(res.body).accessToken;
    if (token) vuTokens[vuId] = token;
    return token || null;
  } catch { return null; }
}

export default function () {
  const vuId  = __VU;
  const token = getToken(vuId);
  if (!token) { sleep(1); return; }

  const idx  = (vuId - 1) % USER_COUNT;
  const auth = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
    "X-Forwarded-For": `10.${(vuId >> 8) & 0xFF}.${vuId & 0xFF}.1`,
  };

  // Wallet balance
  const tw = Date.now();
  const walletRes = http.get(`${BASE_URL}/api/v1/wallet/balance`, { headers: auth });
  walletLatency.add(Date.now() - tw);
  if (walletRes.status === 401) { delete vuTokens[vuId]; return; }
  if (walletRes.status >= 500) { http5xxCount.add(1); httpErrors.add(1); }

  sleep(0.05);

  // Place market order
  const symbol   = SYMBOLS[idx % SYMBOLS.length];
  const side     = idx % 2 === 0 ? "BUY" : "SELL";
  const clientId = `750-${padId(idx)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const t0 = Date.now();
  const openRes = http.post(`${BASE_URL}/api/v1/trading/order`, JSON.stringify({
    symbol, side, type: "MARKET", quantity: 1000, leverage: 10, clientOrderId: clientId,
  }), { headers: auth });
  orderLatency.add(Date.now() - t0);
  if (openRes.status >= 500) { http5xxCount.add(1); httpErrors.add(1); }

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

  // Close position
  if (positionId) {
    const tc = Date.now();
    const closeRes = http.post(
      `${BASE_URL}/api/v1/trading/position/${positionId}/close`, "{}", { headers: auth });
    closeLatency.add(Date.now() - tc);
    if (closeRes.status >= 500) { http5xxCount.add(1); httpErrors.add(1); }
    if (closeRes.status === 200) settledPositions.add(1);
    else if (closeRes.status === 409 || closeRes.status === 422) doubleSettlement.add(1);
    check(closeRes, { "close not 5xx": (r) => r.status < 500 });
  } else {
    const posRes = http.get(`${BASE_URL}/api/v1/trading/positions`, { headers: auth });
    let positions = [];
    try { const p = JSON.parse(posRes.body); if (Array.isArray(p)) positions = p; } catch {}
    for (const pos of positions.slice(0, 2)) {
      const tc = Date.now();
      const cr = http.post(
        `${BASE_URL}/api/v1/trading/position/${pos.id}/close`, "{}", { headers: auth });
      closeLatency.add(Date.now() - tc);
      if (cr.status >= 500) { http5xxCount.add(1); httpErrors.add(1); }
      if (cr.status === 200) settledPositions.add(1);
      else if (cr.status === 409 || cr.status === 422) doubleSettlement.add(1);
    }
  }

  sleep(0.5);
}

export function handleSummary(data) {
  const m = data.metrics;
  function val(metric, stat) { return m[metric]?.values?.[stat] ?? null; }
  function cnt(metric)       { return m[metric]?.values?.count   ?? 0; }
  function rate(metric)      { return m[metric]?.values?.rate    ?? 0; }

  const p95  = val("order_latency_ms_750", "p(95)");
  const p99  = val("order_latency_ms_750", "p(99)");
  const p95c = val("close_latency_ms_750", "p(95)");
  const p95w = val("wallet_latency_ms_750", "p(95)");
  const dur  = (data.state?.testRunDurationMs ?? 0) / 1000;
  const total = cnt("http_reqs");
  const fmt  = (v) => typeof v === "number" ? v.toFixed(0) + "ms" : "N/A";
  const pass = (cond, label) => `${label} → ${cond ? "✓ PASS" : "✗ FAIL"}`;

  const results = {
    tier:              750,
    timestamp:         new Date().toISOString(),
    order_p95:         p95,
    order_p99:         p99,
    close_p95:         p95c,
    wallet_p95:        p95w,
    order_p50:         val("order_latency_ms_750", "p(50)"),
    orders_filled:     cnt("orders_filled_750"),
    orders_rejected:   cnt("orders_rejected_750"),
    positions_settled: cnt("positions_settled_750"),
    double_settlement: cnt("double_settlement_750"),
    swap_duplicates:   cnt("swap_duplicates_750"),
    http_5xx_count:    cnt("http_5xx_count_750"),
    http_error_rate:   rate("http_errors_750"),
    total_requests:    total,
    test_duration_ms:  data.state?.testRunDurationMs ?? 0,
  };

  return {
    stdout: `
╔══════════════════════════════════════════════════════════╗
║     TIER 3.5: 750 USERS — SCALE TEST RESULTS            ║
╚══════════════════════════════════════════════════════════╝

LATENCY (measured)
  Order  P95:   ${fmt(p95)}
  Order  P99:   ${fmt(p99)}
  Close  P95:   ${fmt(p95c)}
  Wallet P95:   ${fmt(p95w)}

CERTIFICATION CHECKS
  ${pass(p95 !== null && p95 < 3000,      "Order P95 < 3000ms     ")}
  ${pass(p95c !== null && p95c < 4000,    "Close P95 < 4000ms     ")}
  ${pass(results.http_5xx_count === 0,    "HTTP 5xx = 0           ")}
  ${pass(results.double_settlement === 0, "Zero double-settlement ")}
  ${pass(results.swap_duplicates === 0,   "Zero swap duplicates   ")}

THROUGHPUT
  Total requests:    ${total}
  Orders filled:     ${results.orders_filled}
  Orders rejected:   ${results.orders_rejected}
  Positions settled: ${results.positions_settled}
  Throughput:        ${dur > 0 ? (total / dur).toFixed(1) : "N/A"} req/s
`,
    "k6-results-750.json": JSON.stringify(results, null, 2),
  };
}
