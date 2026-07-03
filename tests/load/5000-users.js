/**
 * 5000-users.js — Tier 5: 5,000 concurrent traders (stress test)
 *
 * Purpose:
 *   Identify the breaking point of the platform. Unlike lower-tier tests,
 *   this test is designed to expose resource exhaustion, connection pool
 *   saturation, Redis lock contention, and GC pressure under extreme load.
 *
 * Certification thresholds (stress tier — relaxed vs. Tier 1-4):
 *   Order P95  < 8000ms  (2× the Tier-3 1000-user threshold)
 *   Order P99  < 15000ms (15s max for any individual order)
 *   HTTP 5xx   < 1%      (some degradation acceptable at 5K; 0 is production target)
 *   Double settlement: 0 (financial idempotency is never relaxed)
 *
 * Ramp profile:
 *   0→500  in 30s  (warm up connection pool)
 *   500→2000 in 30s (approaching rated capacity)
 *   2000→5000 in 60s (stress zone)
 *   5000→5000 for 120s (sustained peak)
 *   5000→0 in 30s  (teardown)
 *   Total: ~270s
 *
 * Outputs: k6-results-5000.json for SCALABILITY_CERTIFICATION.md
 */

import http from "k6/http";
import ws   from "k6/ws";
import { check, sleep } from "k6";
import { Rate, Trend, Counter, Gauge } from "k6/metrics";

// ── Custom metrics ────────────────────────────────────────────────────────────
const orderLatency      = new Trend("order_latency_ms",   true);
const closeLatency      = new Trend("close_latency_ms",   true);
const walletLatency     = new Trend("wallet_latency_ms",  true);
const wsLatency         = new Trend("ws_event_latency_ms",true);
const filledOrders      = new Counter("orders_filled");
const rejectedOrders    = new Counter("orders_rejected");
const settledPos        = new Counter("positions_settled");
const doubleSettle      = new Counter("double_settlement");
const http5xxCount      = new Counter("http_5xx_count");
const errorRate         = new Rate("http_errors");
const wsConnections     = new Gauge("ws_active_connections");
const lockContention    = new Counter("lock_contention");
const poolExhaustion    = new Counter("db_pool_exhaustion");

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL   = __ENV.BASE_URL    || "http://localhost:3000";
const WS_URL     = __ENV.WS_URL      || "ws://localhost:3000/ws";
const USER_COUNT = __ENV.USER_COUNT  ? parseInt(__ENV.USER_COUNT, 10) : 5000;
const ENABLE_WS  = __ENV.ENABLE_WS   !== "false"; // default: enabled

export const options = {
  scenarios: {
    // Main load scenario: HTTP order/close cycle
    trading_load: {
      executor:  "ramping-vus",
      startVUs:  0,
      stages: [
        { duration: "30s",  target: 500  },
        { duration: "30s",  target: 2000 },
        { duration: "60s",  target: 5000 },
        { duration: "120s", target: 5000 },
        { duration: "30s",  target: 0    },
      ],
      gracefulRampDown: "30s",
      exec: "tradingScenario",
    },

    // WebSocket scenario: validate cross-node event delivery at scale
    ws_subscribers: {
      executor:  "ramping-vus",
      startVUs:  0,
      stages: [
        { duration: "20s",  target: 200  },
        { duration: "40s",  target: 1000 },
        { duration: "120s", target: 1000 },
        { duration: "30s",  target: 0    },
      ],
      gracefulRampDown: "30s",
      exec: "wsScenario",
    },
  },

  thresholds: {
    // Stress tier: relaxed latency but financial correctness is absolute
    order_latency_ms:    ["p(95)<8000", "p(99)<15000"],
    close_latency_ms:    ["p(95)<10000"],
    http_errors:         ["rate<0.01"],    // <1% error rate (stress tier)
    http_5xx_count:      ["count<500"],    // some 503s acceptable at extreme load
    double_settlement:   ["count<1"],      // MUST be 0 — financial invariant
  },

  // HTTP/2 not enabled by default in k6 — use HTTP/1.1 keep-alive
  httpDebug: false,
};

// ── Token cache (per-VU, persists across iterations) ─────────────────────────
const vuTokens = {};

function padId(n) { return String(n).padStart(5, "0"); }

function getToken(vuId) {
  if (vuTokens[vuId]) return vuTokens[vuId];

  const idx   = (vuId - 1) % USER_COUNT;
  const email = `loadtest-${padId(idx)}@igfxpro-loadtest.internal`;

  const res = http.post(
    `${BASE_URL}/api/v1/auth/login/db`,
    JSON.stringify({ email, password: "TestPass123!" }),
    {
      headers: {
        "Content-Type":   "application/json",
        // Spread source IPs to avoid single-IP rate-limit buckets
        "X-Forwarded-For": `10.${Math.floor(vuId / 256) & 0xFF}.${vuId & 0xFF}.1`,
      },
      timeout: "15s",
    },
  );

  errorRate.add(res.status >= 500);
  if (res.status >= 500) {
    http5xxCount.add(1);
    if (res.status === 503 || res.status === 504) poolExhaustion.add(1);
  }
  if (res.status !== 200) return null;

  try {
    const token = JSON.parse(res.body).accessToken;
    if (token) vuTokens[vuId] = token;
    return token || null;
  } catch { return null; }
}

const SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "AUDUSD", "BTCUSD", "ETHUSD", "US500"];

// ── Trading scenario ──────────────────────────────────────────────────────────
export function tradingScenario() {
  const vuId = __VU;
  const token = getToken(vuId);
  if (!token) { sleep(1); return; }

  const idx  = (vuId - 1) % USER_COUNT;
  const auth = {
    "Content-Type":    "application/json",
    "Authorization":   `Bearer ${token}`,
    "X-Forwarded-For": `10.${Math.floor(vuId / 256) & 0xFF}.${vuId & 0xFF}.1`,
    "Connection":      "keep-alive",
  };

  // ── Wallet balance ──────────────────────────────────────────────────────────
  const tw = Date.now();
  const walletRes = http.get(`${BASE_URL}/api/v1/wallet/balance`, { headers: auth, timeout: "10s" });
  walletLatency.add(Date.now() - tw);
  if (walletRes.status === 401) { delete vuTokens[vuId]; return; }
  if (walletRes.status >= 500)  { http5xxCount.add(1); errorRate.add(1); }

  sleep(0.05 + Math.random() * 0.1); // 50-150ms think time

  // ── Place a market order ────────────────────────────────────────────────────
  const symbol   = SYMBOLS[idx % SYMBOLS.length];
  const side     = idx % 2 === 0 ? "BUY" : "SELL";
  // Rotate quantity to vary DB row sizes and margin calculations
  const qty      = [500, 1000, 2000, 5000][idx % 4];
  const clientId = `5k-${padId(idx)}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const t0 = Date.now();
  const orderRes = http.post(
    `${BASE_URL}/api/v1/trading/order`,
    JSON.stringify({ symbol, side, type: "MARKET", quantity: qty, leverage: 10, clientOrderId: clientId }),
    { headers: auth, timeout: "20s" },
  );
  orderLatency.add(Date.now() - t0);

  if (orderRes.status >= 500) {
    http5xxCount.add(1);
    errorRate.add(1);
    if (orderRes.status === 503) poolExhaustion.add(1);
  } else if (orderRes.status === 429) {
    lockContention.add(1);
  }

  let positionId = null;
  try {
    const body = JSON.parse(orderRes.body);
    if (body.status === "FILLED")   { filledOrders.add(1);   positionId = body.positionId; }
    if (body.status === "REJECTED") { rejectedOrders.add(1); }
  } catch {}

  check(orderRes, {
    "order not 5xx":         (r) => r.status < 500,
    "no duplicate (409/422)":(r) => r.status !== 409 && r.status !== 422,
    "order timeout OK":      (r) => r.status !== 408 && r.status !== 504,
  });

  sleep(0.1 + Math.random() * 0.3);

  // ── Close position ──────────────────────────────────────────────────────────
  if (positionId) {
    const tc = Date.now();
    const closeRes = http.post(
      `${BASE_URL}/api/v1/trading/position/${positionId}/close`,
      "{}",
      { headers: auth, timeout: "20s" },
    );
    closeLatency.add(Date.now() - tc);

    if (closeRes.status >= 500) { http5xxCount.add(1); errorRate.add(1); }
    if (closeRes.status === 200) settledPos.add(1);
    if (closeRes.status === 409 || closeRes.status === 422) doubleSettle.add(1);

    check(closeRes, {
      "close not 5xx":      (r) => r.status < 500,
      "close not duplicate":(r) => r.status !== 409,
    });
  } else {
    // No position from this order — try to close oldest open position
    const posRes = http.get(`${BASE_URL}/api/v1/trading/positions`, { headers: auth, timeout: "10s" });
    try {
      const positions = JSON.parse(posRes.body);
      if (Array.isArray(positions) && positions.length > 0) {
        const pos = positions[0];
        const tc = Date.now();
        const cr = http.post(
          `${BASE_URL}/api/v1/trading/position/${pos.id}/close`, "{}",
          { headers: auth, timeout: "20s" },
        );
        closeLatency.add(Date.now() - tc);
        if (cr.status === 200) settledPos.add(1);
        if (cr.status === 409 || cr.status === 422) doubleSettle.add(1);
      }
    } catch {}
  }

  // Randomised think time: 100-600ms (mirrors real traders under stress)
  sleep(0.1 + Math.random() * 0.5);
}

// ── WebSocket scenario ────────────────────────────────────────────────────────
export function wsScenario() {
  if (!ENABLE_WS) { sleep(5); return; }

  const vuId  = __VU;
  const token = getToken(vuId);
  if (!token) { sleep(1); return; }

  const url = `${WS_URL}?token=${token}`;
  const eventsReceived = [];
  const connectTime    = Date.now();

  ws.connect(url, {}, function (sock) {
    wsConnections.add(1);

    sock.on("open", () => {
      // Subscribe to market quotes for all symbols
      sock.send(JSON.stringify({ type: "SUBSCRIBE", symbols: SYMBOLS }));
    });

    sock.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "market.quote" || msg.type === "market.quotes") {
          eventsReceived.push(Date.now());
        } else if (msg.type === "order.filled" || msg.type === "position.opened") {
          const latency = Date.now() - connectTime;
          wsLatency.add(latency);
        }
      } catch {}
    });

    sock.on("error", (e) => {
      errorRate.add(1);
    });

    // Hold connection for 10s then disconnect
    sock.setTimeout(() => {
      check(sock, {
        "ws received at least 1 quote": () => eventsReceived.length > 0,
      });
      sock.close();
    }, 10_000);
  });

  wsConnections.add(-1);
  sleep(1);
}

// ── Summary handler ───────────────────────────────────────────────────────────
export function handleSummary(data) {
  const m = data.metrics;
  function val(metric, stat) { return m[metric]?.values?.[stat] ?? null; }
  function cnt(metric)       { return m[metric]?.values?.count  ?? 0;    }
  function rate(metric)      { return m[metric]?.values?.rate   ?? 0;    }

  const results = {
    tier:              5000,
    timestamp:         new Date().toISOString(),
    order_p50:         val("order_latency_ms",    "p(50)"),
    order_p95:         val("order_latency_ms",    "p(95)"),
    order_p99:         val("order_latency_ms",    "p(99)"),
    close_p95:         val("close_latency_ms",    "p(95)"),
    wallet_p95:        val("wallet_latency_ms",   "p(95)"),
    ws_event_p95:      val("ws_event_latency_ms", "p(95)"),
    orders_filled:     cnt("orders_filled"),
    orders_rejected:   cnt("orders_rejected"),
    positions_settled: cnt("positions_settled"),
    double_settlement: cnt("double_settlement"),
    lock_contention:   cnt("lock_contention"),
    db_pool_exhaustion:cnt("db_pool_exhaustion"),
    http_5xx_count:    cnt("http_5xx_count"),
    http_error_rate:   rate("http_errors"),
    total_requests:    cnt("http_reqs"),
    test_duration_ms:  data.state?.testRunDurationMs ?? 0,
    thresholds_passed: Object.entries(data.metrics)
      .filter(([, m]) => m.thresholds)
      .every(([, m]) => Object.values(m.thresholds).every(Boolean)),
  };

  const fmt     = (v) => typeof v === "number" ? v.toFixed(0) + "ms" : "N/A";
  const dur     = results.test_duration_ms / 1000;
  const throughput = dur > 0 ? (results.total_requests / dur).toFixed(1) : "N/A";

  const dsStatus   = results.double_settlement === 0   ? "✓ PASS" : "✗ FAIL";
  const p95Status  = results.order_p95 !== null && results.order_p95 < 8000 ? "✓ PASS" : "✗ FAIL";
  const errStatus  = results.http_error_rate < 0.01    ? "✓ PASS" : "✗ FAIL";

  return {
    stdout: `
════════════════════════════════════════════════════════
  TIER 5 STRESS TEST: 5,000 USERS
════════════════════════════════════════════════════════
Order  P50:              ${fmt(results.order_p50)}
Order  P95:              ${fmt(results.order_p95)}   [< 8000ms → ${p95Status}]
Order  P99:              ${fmt(results.order_p99)}
Close  P95:              ${fmt(results.close_p95)}
Wallet P95:              ${fmt(results.wallet_p95)}
WS     P95:              ${fmt(results.ws_event_p95)}

Orders filled:           ${results.orders_filled}
Orders rejected:         ${results.orders_rejected}
Positions settled:       ${results.positions_settled}

── Financial Integrity ──────────────────────────────
Double settlement:       ${results.double_settlement}  [must = 0 → ${dsStatus}]
Lock contention (429):   ${results.lock_contention}
DB pool exhaustion:      ${results.db_pool_exhaustion}

── Infrastructure ───────────────────────────────────
HTTP 5xx count:          ${results.http_5xx_count}
HTTP error rate:         ${(results.http_error_rate * 100).toFixed(2)}% [< 1% → ${errStatus}]
Total requests:          ${results.total_requests}
Throughput:              ${throughput} req/s
Test duration:           ${dur.toFixed(0)}s
════════════════════════════════════════════════════════
`,
    "k6-results-5000.json": JSON.stringify(results, null, 2),
  };
}
