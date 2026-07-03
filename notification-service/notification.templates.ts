/**
 * NotificationTemplates — HTML/text email templates for all notification categories.
 */

export type TemplateVars = Record<string, string | number | boolean>;

export type RenderedTemplate = {
  subject: string;
  text:    string;
  html:    string;
};

function wrap(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>
    body{font-family:-apple-system,sans-serif;background:#05070d;color:#e2e8f0;margin:0;padding:24px}
    .card{max-width:520px;margin:0 auto;background:#0c1220;border:1px solid #1e293b;border-radius:12px;padding:28px}
    .brand{color:#22d3ee;font-size:18px;font-weight:700}.title{font-size:20px;font-weight:700;margin:16px 0 8px;color:#f8fafc}
    .body{color:#94a3b8;line-height:1.6;font-size:14px}.hi{color:#22d3ee;font-weight:600}
    .footer{margin-top:24px;font-size:11px;color:#475569;border-top:1px solid #1e293b;padding-top:16px}
  </style></head><body><div class="card">
    <div class="brand">IGFXPRO · OLOS</div>
    <div class="title">${title}</div>
    <div class="body">${body}</div>
    <div class="footer">© 2026 IGFXPRO. Not financial advice. CFDs involve risk.</div>
  </div></body></html>`;
}

export type TemplateName =
  | "order_filled" | "order_rejected" | "position_closed"
  | "margin_warning" | "margin_critical"
  | "deposit_received" | "withdrawal_approved"
  | "kyc_approved" | "kyc_rejected" | "kyc_docs_requested"
  | "signal_generated" | "2fa_enabled" | "login_new_device"
  | "password_changed" | "account_suspended";

const TEMPLATES: Record<TemplateName, (v: TemplateVars) => RenderedTemplate> = {
  order_filled: (v) => ({
    subject: `Order filled — ${v.symbol} ${v.side}`,
    text:    `Your ${v.side} order for ${v.symbol} was filled at ${v.price}. Qty: ${v.quantity}.`,
    html:    wrap(`Order Filled — ${v.symbol}`,
      `<span class="hi">${v.side} ${v.symbol}</span> filled at <b>${v.price}</b><br>Qty: ${v.quantity} · Margin: ${v.margin} USD`),
  }),
  order_rejected: (v) => ({
    subject: `Order rejected — ${v.symbol}`,
    text:    `Your ${v.symbol} order was rejected: ${v.reason}`,
    html:    wrap(`Order Rejected — ${v.symbol}`, `Reason: <b>${v.reason}</b>`),
  }),
  position_closed: (v) => ({
    subject: `Position closed — ${v.symbol} | P&L: ${v.pnl} USD`,
    text:    `${v.symbol} closed. Realized P&L: ${v.pnl} USD`,
    html:    wrap(`Position Closed — ${v.symbol}`,
      `Exit: <b>${v.exitPrice}</b> · Realized P&L: <span class="hi">${v.pnl} USD</span>`),
  }),
  margin_warning: (v) => ({
    subject: "⚠️ Margin warning — action required",
    text:    `Margin level: ${v.level}%. Stop-out at ${v.stopOut}%. Add funds or reduce positions.`,
    html:    wrap("Margin Warning", `Level: <span class="hi">${v.level}%</span> · Stop-out: ${v.stopOut}%`),
  }),
  margin_critical: (v) => ({
    subject: "🚨 CRITICAL: Stop-out imminent",
    text:    `URGENT: Margin level ${v.level}%. Positions may be liquidated.`,
    html:    wrap("CRITICAL: Stop-out Imminent", `<b style="color:#f87171">Margin: ${v.level}%</b> — liquidation imminent`),
  }),
  deposit_received: (v) => ({
    subject: `Deposit received — ${v.amount} USD pending`,
    text:    `Deposit of ${v.amount} USD received. Pending compliance review.`,
    html:    wrap("Deposit Received", `Amount: <span class="hi">${v.amount} USD</span> · Ref: ${v.reference} · Status: Pending`),
  }),
  withdrawal_approved: (v) => ({
    subject: `Withdrawal approved — ${v.amount} USD`,
    text:    `Withdrawal of ${v.amount} USD approved. Destination: ${v.destination}`,
    html:    wrap("Withdrawal Approved", `<span class="hi">${v.amount} USD</span> → ${v.destination}`),
  }),
  kyc_approved: (_) => ({
    subject: "Identity verified — live trading enabled",
    text:    "KYC approved. Live trading is now enabled.",
    html:    wrap("KYC Approved ✓", `Your identity is verified. <span class="hi">Live trading enabled.</span>`),
  }),
  kyc_rejected: (v) => ({
    subject: "Identity verification requires attention",
    text:    `KYC issue: ${v.reason}`,
    html:    wrap("Action Required — KYC", `Reason: ${v.reason}. Please re-upload documents.`),
  }),
  kyc_docs_requested: (v) => ({
    subject: "Additional documents required",
    text:    `Docs needed: ${v.documents}`,
    html:    wrap("Additional Documents Required", `Required: <b>${v.documents}</b>`),
  }),
  signal_generated: (v) => ({
    subject: `OLOS — ${v.symbol} ${v.direction} (${v.confidence}%)`,
    text:    `OLOS signal: ${v.symbol} ${v.direction} ${v.confidence}% confidence`,
    html:    wrap(`OLOS — ${v.symbol}`, `<span class="hi">${v.direction}</span> · Conf: ${v.confidence}% · TF: ${v.timeframe}`),
  }),
  "2fa_enabled": (_) => ({
    subject: "Two-factor authentication enabled",
    text:    "2FA has been enabled on your IGFXPRO account.",
    html:    wrap("2FA Enabled", "Your account is now protected with TOTP."),
  }),
  login_new_device: (v) => ({
    subject: "New login detected",
    text:    `Login from ${v.device} at ${v.time} (IP: ${v.ip})`,
    html:    wrap("New Login Detected", `Device: ${v.device} · IP: ${v.ip} · ${v.time}`),
  }),
  password_changed: (_) => ({
    subject: "Password changed",
    text:    "Your IGFXPRO password has been changed.",
    html:    wrap("Password Changed", "If you did not make this change, contact support immediately."),
  }),
  account_suspended: (v) => ({
    subject: "Account suspended",
    text:    `Account suspended: ${v.reason}`,
    html:    wrap("Account Suspended", `Reason: ${v.reason}. Contact support to resolve.`),
  }),
};

export class NotificationTemplateService {
  render(name: TemplateName, vars: TemplateVars = {}): RenderedTemplate {
    return (TEMPLATES[name]?.(vars)) ?? {
      subject: `IGFXPRO — ${name}`, text: JSON.stringify(vars), html: wrap(name, JSON.stringify(vars)),
    };
  }
  list(): TemplateName[] { return Object.keys(TEMPLATES) as TemplateName[]; }
}

export const notificationTemplates = new NotificationTemplateService();
export default notificationTemplates;
