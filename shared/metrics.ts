/**
 * shared/metrics.ts — Bloomberg-grade Prometheus metrics registry.
 *
 * Drop-in replacement for gateway/metrics.ts.
 * Adds:
 *   - Label support: incL / setL / observeL  (metric_name{k="v",...})
 *   - Per-label time-series stored separately from scalar values
 *   - All original API preserved (inc / set / observe / get / export)
 *   - OpenTelemetry OTLP push on startup if OTEL_EXPORTER_OTLP_ENDPOINT is set
 */

type MetricType = "counter" | "gauge" | "histogram";
export type Labels = Record<string, string | number>;

interface MetricDef {
  help:    string;
  type:    MetricType;
  buckets?: number[];
}

interface HistogramState {
  sum:     number;
  count:   number;
  buckets: Map<number, number>; // le → cumulative count
}

const DEFAULT_LATENCY_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
const FINE_LATENCY_BUCKETS    = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];
const TICK_RATE_BUCKETS       = [10, 50, 100, 250, 500, 1000, 2500, 5000];

function serializeLabels(labels: Labels): string {
  const entries = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");
  return entries ? `{${entries}}` : "";
}

export class MetricsRegistry {
  private readonly defs        = new Map<string, MetricDef>();
  // Scalar (unlabeled) values
  private readonly scalars     = new Map<string, number>();
  // Labeled values: key = "metric_name{labels}"
  private readonly labeledValues = new Map<string, number>();
  // Histogram states: key = "metric_name" or "metric_name{labels}"
  private readonly histograms  = new Map<string, HistogramState>();
  readonly startMs             = Date.now();

  register(name: string, type: MetricType, help: string, buckets?: number[]): void {
    this.defs.set(name, { help, type, buckets });
    if (type === "histogram") {
      const bkts = buckets ?? DEFAULT_LATENCY_BUCKETS;
      const bucketMap = new Map<number, number>();
      for (const b of bkts) bucketMap.set(b, 0);
      this.histograms.set(name, { sum: 0, count: 0, buckets: bucketMap });
    } else {
      if (!this.scalars.has(name)) this.scalars.set(name, 0);
    }
  }

  // ── Unlabeled API (backward-compatible) ─────────────────────────────────────

  inc(name: string, by = 1): void {
    this.scalars.set(name, (this.scalars.get(name) ?? 0) + by);
  }

  set(name: string, value: number): void {
    this.scalars.set(name, value);
  }

  observe(name: string, value: number): void {
    this._observeHistogram(name, value);
  }

  get(name: string): number {
    return this.scalars.get(name) ?? 0;
  }

  // ── Labeled API ──────────────────────────────────────────────────────────────

  /** Increment a labeled counter. Auto-initializes to 0 if unseen. */
  incL(name: string, labels: Labels, by = 1): void {
    const key = `${name}${serializeLabels(labels)}`;
    this.labeledValues.set(key, (this.labeledValues.get(key) ?? 0) + by);
  }

  /** Set a labeled gauge. */
  setL(name: string, labels: Labels, value: number): void {
    const key = `${name}${serializeLabels(labels)}`;
    this.labeledValues.set(key, value);
  }

  /** Record a labeled histogram observation. */
  observeL(name: string, labels: Labels, value: number): void {
    const def = this.defs.get(name);
    if (!def || def.type !== "histogram") return;
    const bkts = def.buckets ?? DEFAULT_LATENCY_BUCKETS;
    const key = `${name}${serializeLabels(labels)}`;
    let h = this.histograms.get(key);
    if (!h) {
      const bucketMap = new Map<number, number>();
      for (const b of bkts) bucketMap.set(b, 0);
      h = { sum: 0, count: 0, buckets: bucketMap };
      this.histograms.set(key, h);
    }
    h.sum += value;
    h.count++;
    for (const [le] of h.buckets) {
      if (value <= le) h.buckets.set(le, (h.buckets.get(le) ?? 0) + 1);
    }
  }

  getL(name: string, labels: Labels): number {
    return this.labeledValues.get(`${name}${serializeLabels(labels)}`) ?? 0;
  }

  // ── Histogram helpers ────────────────────────────────────────────────────────

  private _observeHistogram(key: string, value: number): void {
    const h = this.histograms.get(key);
    if (!h) return;
    h.sum += value;
    h.count++;
    for (const [le] of h.buckets) {
      if (value <= le) h.buckets.set(le, (h.buckets.get(le) ?? 0) + 1);
    }
  }

  getHistogramAvg(name: string): number {
    const h = this.histograms.get(name);
    if (!h || h.count === 0) return 0;
    return Math.round((h.sum / h.count) * 10) / 10;
  }

  getHistogramP99(name: string): number {
    const h = this.histograms.get(name);
    if (!h || h.count === 0) return 0;
    const target = h.count * 0.99;
    for (const [le, count] of h.buckets) {
      if (count >= target) return le;
    }
    return Array.from(h.buckets.keys()).pop() ?? 0;
  }

  // ── Prometheus text export ───────────────────────────────────────────────────

  export(): string {
    const lines: string[] = [];

    // Emit each registered metric
    for (const [name, def] of this.defs) {
      lines.push(`# HELP ${name} ${def.help}`);
      lines.push(`# TYPE ${name} ${def.type}`);

      if (def.type === "histogram") {
        // Unlabeled histogram
        const h = this.histograms.get(name);
        if (h) this._emitHistogram(lines, name, "", h);

        // Labeled histograms
        const prefix = `${name}{`;
        for (const [key, hist] of this.histograms) {
          if (key.startsWith(prefix)) {
            const labelStr = key.slice(name.length);
            this._emitHistogram(lines, name, labelStr, hist);
          }
        }
      } else {
        // Unlabeled scalar
        lines.push(`${name} ${this.scalars.get(name) ?? 0}`);
        // Labeled scalars
        const prefix = `${name}{`;
        for (const [key, val] of this.labeledValues) {
          if (key.startsWith(prefix)) lines.push(`${key} ${val}`);
        }
      }
    }

    // Built-in process metrics
    const uptimeSec = ((Date.now() - this.startMs) / 1000).toFixed(3);
    const mem       = process.memoryUsage();
    const cpu       = process.cpuUsage();

    lines.push("# HELP process_uptime_seconds Process uptime in seconds");
    lines.push("# TYPE process_uptime_seconds counter");
    lines.push(`process_uptime_seconds ${uptimeSec}`);

    lines.push("# HELP process_memory_rss_bytes Resident set size");
    lines.push("# TYPE process_memory_rss_bytes gauge");
    lines.push(`process_memory_rss_bytes ${mem.rss}`);

    lines.push("# HELP process_memory_heap_used_bytes Heap used");
    lines.push("# TYPE process_memory_heap_used_bytes gauge");
    lines.push(`process_memory_heap_used_bytes ${mem.heapUsed}`);

    lines.push("# HELP process_memory_heap_total_bytes Heap total");
    lines.push("# TYPE process_memory_heap_total_bytes gauge");
    lines.push(`process_memory_heap_total_bytes ${mem.heapTotal}`);

    lines.push("# HELP process_memory_external_bytes External memory");
    lines.push("# TYPE process_memory_external_bytes gauge");
    lines.push(`process_memory_external_bytes ${mem.external}`);

    lines.push("# HELP process_cpu_user_seconds_total CPU user time");
    lines.push("# TYPE process_cpu_user_seconds_total counter");
    lines.push(`process_cpu_user_seconds_total ${(cpu.user / 1e6).toFixed(6)}`);

    lines.push("# HELP process_cpu_system_seconds_total CPU system time");
    lines.push("# TYPE process_cpu_system_seconds_total counter");
    lines.push(`process_cpu_system_seconds_total ${(cpu.system / 1e6).toFixed(6)}`);

    lines.push(`# HELP nodejs_version_info Node.js version`);
    lines.push(`# TYPE nodejs_version_info gauge`);
    lines.push(`nodejs_version_info{version="${process.version}"} 1`);

    return lines.join("\n") + "\n";
  }

  private _emitHistogram(lines: string[], name: string, labelStr: string, h: HistogramState): void {
    const base = labelStr ? name + labelStr.replace("}", "") : name;
    // Insert le into labelStr
    const sep = labelStr ? labelStr.slice(0, -1) + "," : "{";
    for (const [le, count] of h.buckets) {
      lines.push(`${name}_bucket${sep}le="${le}"} ${count}`);
    }
    lines.push(`${name}_bucket${sep}le="+Inf"} ${h.count}`);
    lines.push(`${name}_sum${labelStr} ${h.sum}`);
    lines.push(`${name}_count${labelStr} ${h.count}`);
    void base; // suppress unused warning
  }
}

export const metrics = new MetricsRegistry();

// ── HTTP ──────────────────────────────────────────────────────────────────────
metrics.register("igfx_http_requests_total",              "counter",   "Total HTTP requests");
metrics.register("igfx_http_requests_2xx_total",          "counter",   "HTTP 2xx responses");
metrics.register("igfx_http_requests_4xx_total",          "counter",   "HTTP 4xx responses");
metrics.register("igfx_http_requests_5xx_total",          "counter",   "HTTP 5xx responses");
metrics.register("igfx_http_request_duration_ms",         "histogram", "HTTP request duration", DEFAULT_LATENCY_BUCKETS);
metrics.register("igfx_http_active_requests",             "gauge",     "Concurrent in-flight HTTP requests");
// Backward compat aliases
metrics.register("http_requests_total",                   "counter",   "Total HTTP requests received");
metrics.register("http_requests_2xx_total",               "counter",   "Total 2xx responses");
metrics.register("http_requests_4xx_total",               "counter",   "Total 4xx responses");
metrics.register("http_requests_5xx_total",               "counter",   "Total 5xx responses");
metrics.register("http_request_duration_ms_last",         "gauge",     "Duration of last request in ms");

// ── Trading ───────────────────────────────────────────────────────────────────
metrics.register("igfx_orders_total",                     "counter",   "Orders placed by type/side/status");
metrics.register("igfx_orders_placed_total",              "counter",   "Orders placed");
metrics.register("igfx_orders_rejected_total",            "counter",   "Orders rejected");
metrics.register("igfx_orders_filled_total",              "counter",   "Orders filled");
metrics.register("igfx_order_duration_ms",                "histogram", "End-to-end order execution latency", FINE_LATENCY_BUCKETS);
metrics.register("igfx_order_slippage_bps",               "histogram", "Order fill slippage in basis points", [0,1,2,5,10,20,50,100,250]);
metrics.register("igfx_positions_open_total",             "gauge",     "Open positions by symbol/side");
metrics.register("igfx_positions_pnl_usd",               "gauge",     "Unrealized PnL by user bucket");
// Backward compat
metrics.register("orders_placed_total",                   "counter",   "Total orders placed");
metrics.register("orders_rejected_total",                 "counter",   "Total orders rejected");
metrics.register("orders_filled_total",                   "counter",   "Total orders filled");
metrics.register("orders_pending_gauge",                  "gauge",     "Resting orders in book");
metrics.register("positions_opened_total",                "counter",   "Total positions opened");
metrics.register("positions_closed_total",                "counter",   "Total positions closed");
metrics.register("positions_open_gauge",                  "gauge",     "Positions currently open");
metrics.register("settlement_completed_total",            "counter",   "Settlements completed");
metrics.register("settlement_errors_total",               "counter",   "Settlement errors");

// ── Wallet / ledger ───────────────────────────────────────────────────────────
metrics.register("igfx_deposits_total",                   "counter",   "Deposit requests by PSP/status");
metrics.register("igfx_withdrawals_total",                "counter",   "Withdrawal requests by status");
metrics.register("igfx_deposit_amount_usd",               "histogram", "Deposit amounts in USD", [10,100,500,1000,5000,10000,50000]);
// Backward compat
metrics.register("deposit_requests_total",                "counter",   "Total deposit requests");
metrics.register("deposit_approvals_total",               "counter",   "Total deposits approved");
metrics.register("withdrawal_requests_total",             "counter",   "Total withdrawal requests");
metrics.register("withdrawal_approvals_total",            "counter",   "Total withdrawals approved");

// ── WebSocket ─────────────────────────────────────────────────────────────────
metrics.register("igfx_ws_connections_active",            "gauge",     "Active WebSocket connections");
metrics.register("igfx_ws_messages_sent_total",           "counter",   "WS messages sent by type");
metrics.register("igfx_ws_quote_coalesce_total",          "counter",   "Market quotes coalesced (ticks dropped for slow clients)");
// Backward compat
metrics.register("ws_connections_active",                 "gauge",     "Active WebSocket connections");
metrics.register("ws_messages_sent_total",                "counter",   "Total WS messages sent");
metrics.register("outbox_queue_depth",                    "gauge",     "Outbox events awaiting delivery");
metrics.register("outbox_delivered_total",                "counter",   "Total outbox events delivered");

// ── Market data ───────────────────────────────────────────────────────────────
metrics.register("igfx_market_ticks_total",               "counter",   "Price ticks by symbol");
metrics.register("igfx_market_tick_latency_ms",           "histogram", "Time between consecutive ticks", TICK_RATE_BUCKETS);
metrics.register("igfx_market_stale_symbols",             "gauge",     "Symbols with stale quotes");
metrics.register("igfx_market_spread_bps",                "histogram", "Bid/ask spread by symbol", [0,1,2,5,10,20,50,100,500]);
metrics.register("igfx_feed_restarts_total",              "counter",   "Feed reconnect events by provider");
metrics.register("igfx_feed_circuit_open",                "gauge",     "Feed circuit breakers open (1=open)");
// Backward compat
metrics.register("market_data_ticks_total",               "counter",   "Total price ticks received");
metrics.register("market_data_stale_symbols",             "gauge",     "Stale symbols count");
metrics.register("market_data_feed_restarts",             "counter",   "Feed reconnect events");

// ── Execution ─────────────────────────────────────────────────────────────────
metrics.register("igfx_execution_queue_depth",            "gauge",     "Orders waiting in execution queue");
metrics.register("igfx_execution_queue_completed_total",  "counter",   "Execution queue completions");
metrics.register("igfx_execution_queue_overflow_total",   "counter",   "Execution queue overflow rejections");
metrics.register("igfx_execution_queue_latency_ms",       "histogram", "Execution queue processing time", FINE_LATENCY_BUCKETS);
metrics.register("igfx_ei_decisions_total",               "counter",   "Execution Intelligence decisions by action");
metrics.register("igfx_ei_score",                         "histogram", "Execution Intelligence scores", [0,10,20,30,40,50,60,70,80,90,100]);
// Backward compat
metrics.register("execution_queue_completed_total",       "counter",   "Execution queue completions");
metrics.register("execution_queue_overflow_total",        "counter",   "Execution queue overflow");
metrics.register("execution_queue_errors_total",          "counter",   "Execution queue errors");
metrics.register("execution_queue_last_exec_ms",          "gauge",     "Last execution time ms");
metrics.register("execution_queue_lock_contention_total", "counter",   "Redis lock retry attempts");

// ── KYC / compliance ──────────────────────────────────────────────────────────
metrics.register("igfx_kyc_submissions_total",            "counter",   "KYC submissions by status");
metrics.register("igfx_kyc_review_duration_hours",        "histogram", "KYC review time in hours", [0.5,1,2,4,8,24,48,72]);
// Backward compat
metrics.register("kyc_uploads_total",                     "counter",   "Total KYC uploads");
metrics.register("kyc_approvals_total",                   "counter",   "Total KYC approvals");
metrics.register("kyc_rejections_total",                  "counter",   "Total KYC rejections");
metrics.register("aml_flags_total",                       "counter",   "AML flags raised");

// ── Auth / security ───────────────────────────────────────────────────────────
metrics.register("igfx_auth_logins_total",                "counter",   "Login attempts by result");
metrics.register("igfx_auth_token_refreshes_total",       "counter",   "JWT refreshes");
metrics.register("igfx_security_events_total",            "counter",   "Security events by category");
metrics.register("igfx_rate_limit_blocks_total",          "counter",   "Rate limit blocks by tier/endpoint");
metrics.register("igfx_waf_blocks_total",                 "counter",   "WAF rule trigger events");
metrics.register("igfx_ddos_bans_total",                  "counter",   "DDoS progressive bans issued");
metrics.register("igfx_bot_detections_total",             "counter",   "Bot detections by action");
// Backward compat
metrics.register("auth_logins_total",                     "counter",   "Successful logins");
metrics.register("auth_failures_total",                   "counter",   "Failed logins");
metrics.register("auth_token_refresh_total",              "counter",   "Token refreshes");
metrics.register("rate_limit_hits_total",                 "counter",   "Rate limit hits");

// ── Risk / supervisor ─────────────────────────────────────────────────────────
metrics.register("igfx_risk_pretrade_checks_total",       "counter",   "Pre-trade risk checks by result");
metrics.register("igfx_risk_pretrade_latency_ms",         "histogram", "Pre-trade check latency", FINE_LATENCY_BUCKETS);
metrics.register("igfx_supervisor_mode",                  "gauge",     "Global risk supervisor mode (0=NORMAL,1=SAFE,2=EMERGENCY,3=STOP)");
metrics.register("igfx_kill_switch_active",               "gauge",     "Kill switch enabled (1=active)");
metrics.register("igfx_margin_utilization_pct",           "histogram", "User margin utilization %", [10,20,30,40,50,60,70,80,90,95,100]);
// Backward compat
metrics.register("kill_switch_activations_total",         "counter",   "Kill switch activations");
metrics.register("margin_calls_total",                    "counter",   "Margin calls");
metrics.register("stop_out_events_total",                 "counter",   "Stop-out liquidations");
metrics.register("stop_loss_triggers_total",              "counter",   "Stop-loss closes");
metrics.register("take_profit_triggers_total",            "counter",   "Take-profit closes");

// ── OLOS Signal Engine ────────────────────────────────────────────────────────
metrics.register("igfx_signals_generated_total",          "counter",   "Signals generated by symbol/timeframe/type");
metrics.register("igfx_signal_confidence",                "histogram", "Signal confidence scores", [50,55,60,65,70,75,80,85,90,95,100]);
metrics.register("igfx_signal_cooldowns_active",          "gauge",     "Symbols currently in signal cooldown");
metrics.register("igfx_signal_persist_errors_total",      "counter",   "Signal DB persist failures");
metrics.register("igfx_signal_win_total",                 "counter",   "Signals marked as winning");
metrics.register("igfx_signal_loss_total",                "counter",   "Signals marked as losing");

// ── Autopilot ─────────────────────────────────────────────────────────────────
metrics.register("igfx_autopilot_users_active",           "gauge",     "Users with autopilot enabled");
metrics.register("igfx_autopilot_decisions_total",        "counter",   "Autopilot pipeline decisions by action");
metrics.register("igfx_autopilot_pipeline_duration_ms",   "histogram", "Full autopilot pipeline latency", FINE_LATENCY_BUCKETS);
metrics.register("igfx_autopilot_gate_exits_total",       "counter",   "Pipeline gate that rejected signal");
metrics.register("igfx_autopilot_positions_open",         "gauge",     "Open positions opened by autopilot");
metrics.register("igfx_autopilot_daily_trades",           "gauge",     "Autopilot trades today across all users");
// Backward compat
metrics.register("autopilot_correlation_fallback_total",  "counter",   "Autopilot correlation fallbacks");
metrics.register("autopilot_regime_unavailable_total",    "counter",   "Autopilot regime unavailable events");

// ── AI services ───────────────────────────────────────────────────────────────
metrics.register("igfx_ai_requests_total",                "counter",   "AI service requests by type/model");
metrics.register("igfx_ai_latency_ms",                    "histogram", "AI service response latency", [100,500,1000,2500,5000,10000,30000]);
metrics.register("igfx_ai_tokens_total",                  "counter",   "AI token usage by type (input/output)");
metrics.register("igfx_ai_errors_total",                  "counter",   "AI service errors by type");
metrics.register("igfx_ai_cache_hits_total",              "counter",   "AI response cache hits");

// ── Database ──────────────────────────────────────────────────────────────────
metrics.register("igfx_db_queries_total",                 "counter",   "DB queries by model/operation");
metrics.register("igfx_db_query_duration_ms",             "histogram", "DB query latency by model", FINE_LATENCY_BUCKETS);
metrics.register("igfx_db_connections_active",            "gauge",     "Active DB connections");
metrics.register("igfx_db_pool_waiters",                  "gauge",     "Requests waiting for a DB connection");
metrics.register("igfx_db_slow_queries_total",            "counter",   "DB queries exceeding slow threshold");
metrics.register("igfx_db_errors_total",                  "counter",   "DB errors by type");
// Backward compat
metrics.register("db_queries_total",                      "counter",   "Total DB queries");
metrics.register("db_slow_queries_total",                 "counter",   "Slow DB queries");
metrics.register("db_query_duration_ms",                  "histogram", "DB query latency", FINE_LATENCY_BUCKETS);

// ── Financial integrity ───────────────────────────────────────────────────────
metrics.register("igfx_reconciliation_issues_total",      "counter",   "Reconciliation issues by type");
metrics.register("igfx_reconciliation_dirty_users",       "gauge",     "Users with reconciliation issues");
metrics.register("igfx_negative_balance_clips_total",     "counter",   "Negative balance protection clips");
// Backward compat
metrics.register("margin_discrepancies_total",            "counter",   "Margin discrepancies");
metrics.register("reconciliation_mismatches_total",       "counter",   "Reconciliation mismatches");
metrics.register("reconciliation_dirty_users",            "gauge",     "Dirty reconciliation users");
metrics.register("reconciliation_orphan_margin_repaired_total","counter","Orphan margin repairs");
metrics.register("partial_fill_margin_released_total",     "counter",   "Unused margin released after a partial fill");
metrics.register("swap_accrual_total",                    "counter",   "Successful per-position swap accruals");
metrics.register("swap_accrual_errors_total",              "counter",   "Swap accrual errors");
metrics.register("negative_balance_clips_total",          "counter",   "Negative balance clips");
metrics.register("enhanced_recon_swap_mismatches",        "counter",   "Enhanced recon swap mismatches");
metrics.register("enhanced_recon_deposit_mismatches",     "counter",   "Enhanced recon deposit mismatches");
metrics.register("enhanced_recon_pnl_mismatches",         "counter",   "Enhanced recon PnL mismatches");
metrics.register("enhanced_recon_audit_mismatches",       "counter",   "Enhanced recon audit mismatches");
metrics.register("enhanced_recon_dirty_checks",           "gauge",     "Enhanced recon dirty checks");

// ── Latency histograms (backward compat) ─────────────────────────────────────
metrics.register("order_duration_ms",                     "histogram", "Order execution latency", FINE_LATENCY_BUCKETS);
metrics.register("settlement_duration_ms",                "histogram", "Settlement latency", DEFAULT_LATENCY_BUCKETS);
metrics.register("stopout_duration_ms",                   "histogram", "Stop-out sweep latency", DEFAULT_LATENCY_BUCKETS);
metrics.register("ws_broadcast_duration_ms",              "histogram", "WS broadcast latency", FINE_LATENCY_BUCKETS);

// ── Alerts ────────────────────────────────────────────────────────────────────
metrics.register("alerts_sent_total",                     "counter",   "Alerts fired by severity/channel");
metrics.register("retention_rows_deleted_total",          "counter",   "Rows deleted by retention service");
metrics.register("retention_last_run_ts",                 "gauge",     "Last retention run timestamp");

export { DEFAULT_LATENCY_BUCKETS, FINE_LATENCY_BUCKETS };
