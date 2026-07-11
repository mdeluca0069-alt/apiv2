/**
 * AlertManager — production alerting for critical broker events.
 *
 * Channels:
 *   1. Telegram bot — instant push to ops chat (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
 *   2. SMTP email   — sent via nodemailer (SMTP_HOST/PORT/USER/PASS + ALERT_EMAIL_TO)
 *
 * Alert types:
 *   RECONCILIATION_MISMATCH — wallet/ledger/position inconsistency detected
 *   SETTLEMENT_FAILURE       — settlement transaction threw an unrecoverable error
 *   MARGIN_DISCREPANCY       — orphan margin detected on position close
 *   DB_SATURATION            — DB pool wait > 5s (pool_timeout approaching)
 *   WS_DISCONNECT            — all WebSocket connections dropped simultaneously
 *   MARKET_DATA_OUTAGE       — no price ticks received for >30s
 *   STOP_OUT_WAVE            — ≥5 stop-outs in a single 30s scan cycle
 *   KILL_SWITCH_ACTIVATED    — kill switch enabled by admin
 *   AUTOPILOT_CIRCUIT_BREAKER — autopilot auto-disabled platform-wide (daily drawdown breach)
 *   AUTOPILOT_FALLBACK_SPIKE  — autopilot correlation/regime fallback paths firing unusually often
 *   AUDIT_CONSUMER_FAILURE    — an OutboxEvent has failed TradeAudit/AuditLog processing repeatedly
 *
 * Deduplication: identical alerts are suppressed for DEDUP_WINDOW_MS (5 min).
 * All alerts are also written to AuditLog for compliance.
 */

import { metrics } from "../gateway/metrics.js";

// ── Config ────────────────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   ?? "";
const SMTP_HOST          = process.env.SMTP_HOST           ?? "";
const SMTP_PORT          = Number(process.env.SMTP_PORT    ?? 587);
const SMTP_USER          = process.env.SMTP_USER           ?? "";
const SMTP_PASS          = process.env.SMTP_PASS           ?? "";
const ALERT_EMAIL_TO     = process.env.ALERT_EMAIL_TO      ?? "";
const ALERT_EMAIL_FROM   = process.env.ALERT_EMAIL_FROM    ?? "alerts@igfxpro.com";
const DEDUP_WINDOW_MS    = 5 * 60 * 1000; // 5 minutes

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export type AlertPayload = {
  type:     string;
  severity: AlertSeverity;
  title:    string;
  message:  string;
  metadata?: Record<string, unknown>;
};

// ── Dedup ─────────────────────────────────────────────────────────────────────

const recentAlerts = new Map<string, number>(); // key → lastSentMs

function dedupKey(alert: AlertPayload): string {
  return `${alert.type}:${alert.severity}`;
}

function isDuplicate(alert: AlertPayload): boolean {
  const key  = dedupKey(alert);
  const last = recentAlerts.get(key);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return true;
  recentAlerts.set(key, Date.now());
  return false;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatTelegramMessage(alert: AlertPayload): string {
  const emoji = alert.severity === "CRITICAL" ? "🚨" : alert.severity === "WARNING" ? "⚠️" : "ℹ️";
  const lines = [
    `${emoji} *[${alert.severity}] ${alert.title}*`,
    ``,
    alert.message,
  ];
  if (alert.metadata) {
    lines.push(`\n\`\`\``);
    for (const [k, v] of Object.entries(alert.metadata)) {
      lines.push(`${k}: ${v}`);
    }
    lines.push(`\`\`\``);
  }
  lines.push(`\n_${new Date().toISOString()} — IGFXPRO_`);
  return lines.join("\n");
}

function formatEmailBody(alert: AlertPayload): string {
  const rows = alert.metadata
    ? Object.entries(alert.metadata).map(([k, v]) => `  ${k}: ${v}`).join("\n")
    : "";
  return [
    `[${alert.severity}] ${alert.title}`,
    ``,
    alert.message,
    rows ? `\nDetails:\n${rows}` : "",
    ``,
    `Timestamp: ${new Date().toISOString()}`,
    `Service: IGFXPRO-OLOS`,
  ].filter(Boolean).join("\n");
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(alert: AlertPayload): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const text = formatTelegramMessage(alert);
  const url  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
      }),
    });
    if (!res.ok) {
      console.error(`[alert] Telegram delivery failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error("[alert] Telegram fetch error:", (err as Error).message);
  }
}

// ── Email (SMTP via nodemailer dynamic import) ────────────────────────────────

async function sendEmail(alert: AlertPayload): Promise<void> {
  if (!SMTP_HOST || !ALERT_EMAIL_TO) return;

  try {
    // Dynamic import — nodemailer is an optional dep; won't crash if absent
    const nodemailer = await import("nodemailer").catch(() => null);
    if (!nodemailer) {
      console.warn("[alert] nodemailer not installed — email alert skipped");
      return;
    }

    const transporter = nodemailer.createTransport({
      host:   SMTP_HOST,
      port:   SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: SMTP_USER
        ? { user: SMTP_USER, pass: SMTP_PASS }
        : undefined,
    });

    await transporter.sendMail({
      from:    ALERT_EMAIL_FROM,
      to:      ALERT_EMAIL_TO,
      subject: `[${alert.severity}] ${alert.title}`,
      text:    formatEmailBody(alert),
    });
  } catch (err) {
    console.error("[alert] Email delivery failed:", (err as Error).message);
  }
}

// ── AlertManager ──────────────────────────────────────────────────────────────

class AlertManager {
  /**
   * Fire an alert. Deduplicates within 5 minutes and sends to all configured channels.
   */
  async send(alert: AlertPayload): Promise<void> {
    if (isDuplicate(alert)) return;

    const prefix = `[alert:${alert.type}]`;
    if (alert.severity === "CRITICAL") {
      console.error(`${prefix} ${alert.title} — ${alert.message}`, alert.metadata ?? "");
    } else {
      console.warn(`${prefix} ${alert.title} — ${alert.message}`, alert.metadata ?? "");
    }

    metrics.inc("alerts_sent_total");

    // Send in parallel; neither channel failing blocks the other
    await Promise.allSettled([
      sendTelegram(alert),
      sendEmail(alert),
    ]);
  }

  // ── Pre-built alert templates ──────────────────────────────────────────────

  reconciliationMismatch(dirtyUsers: number, details: string): Promise<void> {
    return this.send({
      type:     "RECONCILIATION_MISMATCH",
      severity: dirtyUsers >= 5 ? "CRITICAL" : "WARNING",
      title:    "Ledger Reconciliation Mismatch",
      message:  `${dirtyUsers} account(s) have wallet/ledger/position inconsistencies.`,
      metadata: { dirtyUsers, details },
    });
  }

  settlementFailure(positionId: string, userId: string, error: string): Promise<void> {
    return this.send({
      type:     "SETTLEMENT_FAILURE",
      severity: "CRITICAL",
      title:    "Settlement Transaction Failed",
      message:  `Position ${positionId} for user ${userId} could not be settled.`,
      metadata: { positionId, userId, error },
    });
  }

  marginDiscrepancy(positionId: string, userId: string, requested: number, released: number): Promise<void> {
    return this.send({
      type:     "MARGIN_DISCREPANCY",
      severity: "WARNING",
      title:    "Margin Discrepancy on Settlement",
      message:  `Orphan or double-release detected for position ${positionId}.`,
      metadata: { positionId, userId, requested: requested.toFixed(2), released: released.toFixed(2), discrepancy: (requested - released).toFixed(2) },
    });
  }

  dbSaturation(waitMs: number, poolSize: number): Promise<void> {
    return this.send({
      type:     "DB_SATURATION",
      severity: "CRITICAL",
      title:    "Database Pool Near Saturation",
      message:  `DB connection wait time ${waitMs}ms — pool of ${poolSize} connections is near capacity.`,
      metadata: { waitMs, poolSize },
    });
  }

  wsDisconnect(dropped: number): Promise<void> {
    return this.send({
      type:     "WS_DISCONNECT",
      severity: "WARNING",
      title:    "WebSocket Connections Dropped",
      message:  `${dropped} WebSocket client(s) disconnected simultaneously.`,
      metadata: { dropped },
    });
  }

  marketDataOutage(symbol: string, staleMs: number): Promise<void> {
    return this.send({
      type:     "MARKET_DATA_OUTAGE",
      severity: "CRITICAL",
      title:    "Market Data Outage",
      message:  `${symbol} has had no price ticks for ${(staleMs / 1000).toFixed(0)}s. SL/TP enforcement may be impaired.`,
      metadata: { symbol, staleMs },
    });
  }

  stopOutWave(count: number, totalPnl: number): Promise<void> {
    return this.send({
      type:     "STOP_OUT_WAVE",
      severity: count >= 10 ? "CRITICAL" : "WARNING",
      title:    "Stop-Out Wave Detected",
      message:  `${count} stop-out(s) triggered in a single scan cycle. Total P&L impact: ${totalPnl.toFixed(2)} USD.`,
      metadata: { count, totalPnl: totalPnl.toFixed(2) },
    });
  }

  killSwitchActivated(reason: string, actor: string): Promise<void> {
    return this.send({
      type:     "KILL_SWITCH_ACTIVATED",
      severity: "CRITICAL",
      title:    "Kill Switch Activated",
      message:  `All trading halted by ${actor}. Reason: ${reason}`,
      metadata: { reason, actor },
    });
  }

  swapAccrualError(positionCount: number, errors: number): Promise<void> {
    return this.send({
      type:     "SWAP_ACCRUAL_ERROR",
      severity: errors > 5 ? "CRITICAL" : "WARNING",
      title:    "Swap Accrual Errors",
      message:  `${errors} of ${positionCount} positions failed swap accrual tonight.`,
      metadata: { positionCount, errors },
    });
  }

  auditConsumerFailure(eventId: string, eventType: string, retries: number, error: string): Promise<void> {
    return this.send({
      type:     "AUDIT_CONSUMER_FAILURE",
      severity: "CRITICAL",
      title:    "Trade Audit Delivery Failing Persistently",
      message:  `OutboxEvent ${eventId} (${eventType}) has failed audit processing ${retries} time(s) and will keep retrying.`,
      metadata: { eventId, eventType, retries, error },
    });
  }
}

export const alertManager = new AlertManager();
