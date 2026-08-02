/**
 * NotificationRouter — event-driven notification dispatcher.
 *
 * Architecture:
 *   EventBus event → NotificationRouter.handle() → DB queue (Notification table)
 *   → channel sender (email / in-app / push / SMS)
 *
 * The router subscribes to all relevant domain events from the EventBus.
 * Each event triggers a notification for the affected user(s).
 *
 * Channels:
 *   IN_APP — always sent; consumed by frontend via GET /api/v1/notifications
 *   EMAIL  — sent via email.sender (requires SMTP config)
 *   PUSH   — reserved for future push notification provider
 *   SMS    — reserved for future SMS provider
 */
import { randomUUID }    from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }      from "../events-bus/event.bus.js";
import { emailSender }   from "./email.sender.js";
import { immutableAudit } from "../security/immutable.audit.js";
import { Prisma }        from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotifChannel  = "EMAIL" | "SMS" | "PUSH" | "IN_APP";
export type NotifPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
export type NotifCategory =
  | "fill" | "rejection" | "margin" | "risk" | "kyc" | "wallet" | "signal" | "system" | "autopilot"
  | "account" | "support" | "compliance";

export type NotifPayload = {
  userId:    string;
  channel:   NotifChannel;
  category:  NotifCategory;
  priority:  NotifPriority;
  title:     string;
  body:      string;
  /** Optional rich HTML body for the EMAIL channel — falls back to <p>{body}</p> when omitted. */
  html?:     string;
  payload?:  Record<string, unknown>;
};

// ─── NotificationRouter ───────────────────────────────────────────────────────

export class NotificationRouter {

  /**
   * Queue a notification for a user on a specific channel.
   *
   * PHASE E FAILURE-INJECTION AUDIT: every call site of this method (via
   * sendAll()/sendAllRich(), see subscribe() below) is `void`-fired --
   * intentional, since a slow/failing notification must never block or
   * roll back the business transaction that triggered it. But the
   * un-awaited call site means any throw from this method becomes an
   * unhandled promise rejection, which main.ts's unhandledRejection
   * handler explicitly logs and discards as non-fatal (correct for
   * process stability, but it meant a single transient DB error --
   * plausible during exactly the kind of load spike a stop-out wave
   * causes -- silently and permanently dropped a MARGIN_CALL, STOP_OUT,
   * or KYC-rejection notification with zero record it was ever supposed
   * to exist. This is the same durability gap FASE 2.6 already closed for
   * order.filled/position.closed via a transactional OutboxEvent row +
   * dedicated consumer; margin/KYC notifications don't yet have an
   * equivalent durable queue of their own to migrate onto, so this method
   * instead now guarantees it never throws past this point: any DB
   * failure gets one retry, and if that also fails, a durable
   * immutableAudit record captures the notification that was about to be
   * lost (actor="notification-router", action=
   * "notification.delivery_failed") so an ops sweep can find and manually
   * redeliver it, instead of the failure vanishing into a discarded
   * promise rejection with no trace anywhere.
   */
  async send(n: NotifPayload): Promise<void> {
    if (!IS_PERSISTENT) return this._logConsole(n);

    const db = prisma as NonNullable<typeof prisma>;

    try {
      // Check user preferences (skip if channel disabled)
      const pref = await db.notificationPreference.findUnique({ where: { userId: n.userId } });
      if (pref) {
        if (n.channel === "EMAIL" && !pref.emailEnabled) return;
        if (n.channel === "SMS"   && !pref.smsEnabled)   return;
        if (n.channel === "PUSH"  && !pref.pushEnabled)   return;
        if (n.channel === "IN_APP"&& !pref.inAppEnabled)  return;

        const cats = (pref.categories as Record<string, boolean>) ?? {};
        if (cats[n.category] === false) return;
      }

      await this._createWithRetry(db, n);
    } catch (err) {
      console.error(`[notification] failed to persist notification for user=${n.userId} category=${n.category} (retries exhausted):`, (err as Error).message);
      await immutableAudit.write({
        actor:  "notification-router",
        action: "notification.delivery_failed",
        entity: n.userId,
        payload: {
          channel: n.channel, category: n.category, priority: n.priority,
          title: n.title, body: n.body, error: (err as Error).message,
        } as object,
      }).catch(() => { /* last-resort: already console.error'd above */ });
      return;
    }

    // Attempt immediate delivery for email
    if (n.channel === "EMAIL") {
      // emailSender falls back to a non-existent "<userId>@igfxpro.local" address
      // when no explicit `to` is given — always resolve the user's real email first.
      const user = await db.user.findUnique({ where: { id: n.userId }, select: { email: true } }).catch(() => null);
      await emailSender.send({
        userId:  n.userId,
        to:      user?.email,
        subject: n.title,
        text:    n.body,
        html:    n.html ?? `<p>${n.body}</p>`,
      }).catch((err) => {
        console.error("[notification] email send failed:", (err as Error).message);
      });
    }
  }

  /** One retry (after a short backoff) before giving up on the DB write — absorbs a single transient blip without a durable-audit fallback. */
  private async _createWithRetry(db: NonNullable<typeof prisma>, n: NotifPayload): Promise<void> {
    const data = {
      id:       randomUUID(),
      userId:   n.userId,
      channel:  n.channel,
      category: n.category,
      priority: n.priority,
      title:    n.title,
      body:     n.body,
      payload:  n.payload as object ?? {},
    };
    try {
      await db.notification.create({ data });
    } catch (err) {
      console.warn(`[notification] first create() attempt failed for user=${n.userId}, retrying once:`, (err as Error).message);
      await new Promise((r) => setTimeout(r, 200));
      await db.notification.create({ data });
    }
  }

  /** Send to all channels with a custom HTML body (richer than the plain sendAll). */
  async sendAllRich(
    userId:   string,
    category: NotifCategory,
    priority: NotifPriority,
    title:    string,
    body:     string,
    html:     string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await Promise.all([
      this.send({ userId, channel: "IN_APP", category, priority, title, body, payload }),
      this.send({ userId, channel: "EMAIL",  category, priority, title, body, html, payload }),
    ]);
  }

  /** Send to all channels (IN_APP always + EMAIL if enabled). */
  async sendAll(
    userId:   string,
    category: NotifCategory,
    priority: NotifPriority,
    title:    string,
    body:     string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await Promise.all([
      this.send({ userId, channel: "IN_APP", category, priority, title, body, payload }),
      this.send({ userId, channel: "EMAIL",  category, priority, title, body, payload }),
    ]);
  }

  /** Get unread in-app notifications for a user. */
  async getInApp(userId: string, limit = 50): Promise<unknown[]> {
    if (!IS_PERSISTENT) return [];
    const db = prisma as NonNullable<typeof prisma>;
    return db.notification.findMany({
      where:   { userId, channel: "IN_APP", sent: false },
      orderBy: { createdAt: "desc" },
      take:    Math.min(limit, 200),
    });
  }

  /** Mark in-app notifications as read. */
  async markRead(userId: string, ids?: string[]): Promise<void> {
    if (!IS_PERSISTENT) return;
    const db = prisma as NonNullable<typeof prisma>;
    await db.notification.updateMany({
      where: { userId, channel: "IN_APP", ...(ids ? { id: { in: ids } } : {}) },
      data:  { sent: true, sentAt: new Date() },
    });
  }

  /** Get notification preferences for a user. */
  async getPreferences(userId: string): Promise<unknown> {
    if (!IS_PERSISTENT) {
      return { emailEnabled: true, smsEnabled: false, pushEnabled: true, inAppEnabled: true, categories: {} };
    }
    const db   = prisma as NonNullable<typeof prisma>;
    const pref = await db.notificationPreference.findUnique({ where: { userId } });
    return pref ?? { emailEnabled: true, smsEnabled: false, pushEnabled: true, inAppEnabled: true, categories: {} };
  }

  /** Upsert notification preferences for a user. */
  async updatePreferences(userId: string, patch: Record<string, unknown>): Promise<unknown> {
    if (!IS_PERSISTENT) return patch;
    const db = prisma as NonNullable<typeof prisma>;

    const current = await db.notificationPreference.findUnique({ where: { userId } });
    const merged  = {
      emailEnabled: Boolean(patch.emailEnabled ?? current?.emailEnabled ?? true),
      smsEnabled:   Boolean(patch.smsEnabled   ?? current?.smsEnabled   ?? false),
      pushEnabled:  Boolean(patch.pushEnabled   ?? current?.pushEnabled   ?? true),
      inAppEnabled: Boolean(patch.inAppEnabled  ?? current?.inAppEnabled  ?? true),
      categories:   ({
        ...(current?.categories as Record<string, unknown> ?? {}),
        ...(patch.categories as Record<string, unknown> ?? {}),
      }) as Prisma.InputJsonValue,
    };

    return db.notificationPreference.upsert({
      where:  { userId },
      create: { userId, ...merged },
      update: merged,
    });
  }

  private _logConsole(n: NotifPayload): void {
    console.log(`[notify][${n.channel}][${n.category}] ${n.userId}: ${n.title}`);
  }

  private _welcomeEmailHtml(
    fullName: string, email: string, accountNumber: string, tier: string,
    dashboardUrl: string, supportEmail: string,
  ): string {
    return `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#0f172a">
        <div style="background:#05070d;padding:28px 32px;border-radius:12px 12px 0 0">
          <span style="color:#00d4ff;font-weight:700;font-size:18px;letter-spacing:0.05em">IGFXPRO</span>
        </div>
        <div style="background:#ffffff;padding:32px;border:1px solid #e2e8f0;border-radius:0 0 12px 12px">
          <h1 style="font-size:20px;margin:0 0 16px">Welcome, ${fullName}.</h1>
          <p style="font-size:14px;line-height:1.6;color:#334155">Your trading account has been created and is ready to use. Here are your account details:</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
            <tr><td style="padding:8px 0;color:#64748b">Account number</td><td style="padding:8px 0;font-weight:700;text-align:right">${accountNumber}</td></tr>
            <tr style="border-top:1px solid #e2e8f0"><td style="padding:8px 0;color:#64748b">Login email</td><td style="padding:8px 0;font-weight:700;text-align:right">${email}</td></tr>
            <tr style="border-top:1px solid #e2e8f0"><td style="padding:8px 0;color:#64748b">Account tier</td><td style="padding:8px 0;font-weight:700;text-align:right">${tier}</td></tr>
          </table>
          <p style="font-size:13px;line-height:1.6;color:#64748b">For your security, your password was never sent by email — it's the one you chose at signup. Use it together with your login email to access your dashboard.</p>
          <a href="${dashboardUrl}" style="display:inline-block;margin-top:12px;background:#00d4ff;color:#05070d;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Open my dashboard</a>
          <p style="font-size:12px;line-height:1.6;color:#94a3b8;margin-top:28px">Next steps: complete identity verification (KYC) to unlock live trading and withdrawals, then fund your account to start trading.</p>
          <p style="font-size:12px;color:#94a3b8">Need help? Contact us at <a href="mailto:${supportEmail}" style="color:#00d4ff">${supportEmail}</a> or open a support ticket from your dashboard.</p>
        </div>
      </div>`;
  }

  /** Wire all EventBus subscriptions. Call once at startup. */
  subscribe(): void {
    // Order fills, position closes: FASE 2.6 — moved to
    // notification-service/notification.outbox.consumer.ts. Both events
    // already write a transactional OutboxEvent row (FASE 2.1); the
    // fire-and-forget `void this.sendAll(...)`/`void this.send(...)` this
    // used to do here had no retry and no durable record that a
    // notification should have existed if the process crashed mid-send.
    // Every other listener below is unrelated to the order lifecycle this
    // OutboxEvent row exists for and stays fire-and-forget — out of scope
    // for this phase (see SYSTEM_ARCHITECTURE_FREEZE.md, FASE 2.6).

    // Order rejections
    eventBus.on("order.rejected", (e) => {
      void this.sendAll(e.userId, "rejection", "NORMAL",
        `Order rejected — ${e.symbol}`,
        String(e.reason ?? "Pre-trade risk check failed"),
        e as unknown as Record<string, unknown>,
      );
    });

    // Margin warnings — REALTIME_FREEZE.md Critical #1: single canonical
    // event for all three ESMA thresholds (WARNING 150%, MARGIN_CALL 100%,
    // STOP_OUT 50%). Previously this listener existed but nothing ever
    // emitted "margin.warning" -- unreachable dead code. Threshold-specific
    // copy/priority mirrors what stopout.engine.ts used to write directly
    // to the Notification table itself (now consolidated here, so it also
    // respects notificationPreference opt-outs like every other channel).
    eventBus.on("margin.warning", (e) => {
      const copy: Record<string, { title: string; body: string; priority: NotifPriority }> = {
        WARNING: {
          title:    "Margin Warning",
          body:     `Your margin level has dropped to ${e.marginLevelPct.toFixed(0)}%. Add funds or reduce positions to avoid a margin call.`,
          priority: "HIGH",
        },
        MARGIN_CALL: {
          title:    "Margin Call",
          body:     `Margin level is ${e.marginLevelPct.toFixed(0)}%. New positions are restricted. Add funds immediately to avoid stop-out.`,
          priority: "CRITICAL",
        },
        STOP_OUT: {
          title:    "Stop-Out Triggered",
          body:     `Your margin level dropped to ${e.marginLevelPct.toFixed(0)}% and ${e.positionsClosed ?? 0} position(s) ` +
                    `were automatically closed to protect your account (net P&L ${(e.totalPnl ?? 0).toFixed(2)} USD).`,
          priority: "CRITICAL",
        },
      };
      const msg = copy[e.threshold];
      if (!msg) return;
      void this.sendAll(e.userId, "margin", msg.priority, msg.title, msg.body,
        e as unknown as Record<string, unknown>,
      );
    });

    // Risk warnings (margin/liquidation only, see FASE 7 CLOSURE M.6).
    // PHASE E (failure-injection audit): userId is now optional -- see
    // RiskWarningEvent's docstring in events-bus/event.bus.ts. A per-user
    // IN_APP notification requires a known recipient, so a userId-less,
    // platform-wide event (feed.manager.ts's FEED_CIRCUIT_OPEN) is skipped
    // here; it reaches staff live via main.ts's pushToStaff() instead.
    eventBus.on("risk.warning", (e) => {
      if (!e.userId) return;
      void this.send({
        userId:   e.userId, channel: "IN_APP", category: "risk", priority: "HIGH",
        title:    "Risk alert",
        body:     String((e as Record<string, unknown>).message ?? "Risk threshold breached"),
        payload:  e as unknown as Record<string, unknown>,
      });
    });

    // Compliance alerts (AML/sanctions/transaction-monitoring) -- split out
    // of risk.warning under FASE 7 CLOSURE M.6, own category/copy instead
    // of the generic "Risk alert" every flavor previously shared.
    eventBus.on("compliance.alert", (e) => {
      void this.send({
        userId:   e.userId, channel: "IN_APP", category: "compliance", priority: "HIGH",
        title:    "Compliance alert",
        body:     e.message,
        payload:  e as unknown as Record<string, unknown>,
      });
    });

    // Wallet events (deposits/withdrawals, not margin locks)
    eventBus.on("wallet.event", (e) => {
      const type = String((e as Record<string, unknown>).type ?? "");
      if (type === "MARGIN_LOCK" || type === "MARGIN_RELEASE") return;
      void this.sendAll(e.userId, "wallet", "NORMAL",
        `Wallet ${type.toLowerCase().replace(/_/g, " ")}`,
        `Reference: ${String((e as Record<string, unknown>).reference ?? "")}`,
        e as unknown as Record<string, unknown>,
      );
    });

    // Account opened — welcome email with real account credentials/info
    eventBus.on("user.registered", (e) => {
      const dashboardUrl = `${process.env.FRONTEND_URL ?? "http://localhost:5173"}/dashboard`;
      const supportEmail = process.env.SUPPORT_EMAIL ?? "support@igfxpro.com";
      const body =
        `Welcome to IGFXPRO, ${e.fullName}. Your account ${e.accountNumber} (${e.tier}) is ready — ` +
        `login with ${e.email}. Dashboard: ${dashboardUrl}. Support: ${supportEmail}.`;
      void this.sendAllRich(
        e.userId, "account", "HIGH",
        "Welcome to IGFXPRO — your account is ready",
        body,
        this._welcomeEmailHtml(e.fullName, e.email, e.accountNumber, e.tier, dashboardUrl, supportEmail),
        e as unknown as Record<string, unknown>,
      );
    });

    // Support ticket created — confirmation to the client
    eventBus.on("support.ticket_created", (e) => {
      void this.sendAll(e.userId, "support", "NORMAL",
        `Support ticket received — #${e.ticketId.slice(0, 8).toUpperCase()}`,
        `We've received your request "${e.subject}" (priority: ${e.priority}). Our team will respond shortly. You can track its status from your dashboard.`,
        e as unknown as Record<string, unknown>,
      );
    });

    // Support ticket updated/resolved — notify the client of the agent's reply
    eventBus.on("support.ticket_updated", (e) => {
      const statusLabel = e.status.replace(/_/g, " ").toLowerCase();
      const note = e.resolution ?? e.agentNote;
      void this.sendAll(e.userId, "support", "HIGH",
        `Support ticket #${e.ticketId.slice(0, 8).toUpperCase()} — ${statusLabel}`,
        note ? `Our team replied: "${note}"` : `Your ticket status changed to ${statusLabel}.`,
        e as unknown as Record<string, unknown>,
      );
    });

    // KYC events
    eventBus.on("kyc.approved" as never, (e: Record<string, unknown>) => {
      void this.sendAll(String(e.userId), "kyc", "HIGH",
        "KYC approved — you can now trade live",
        "Your identity verification has been approved. Live trading is now enabled.",
        e,
      );
    });

    eventBus.on("kyc.rejected" as never, (e: Record<string, unknown>) => {
      void this.sendAll(String(e.userId), "kyc", "HIGH",
        "KYC requires attention",
        `Verification issue: ${String(e.reason ?? "Please re-upload your documents")}`,
        e,
      );
    });

    // Autopilot — trade executed (EMAIL+IN_APP: a real position was just opened automatically)
    eventBus.on("autopilot.executed", (e) => {
      void this.sendAll(e.userId, "autopilot", "NORMAL",
        `Autopilot trade executed — ${e.symbol}`,
        `${e.side} order placed automatically — ${e.reason}`,
        e as unknown as Record<string, unknown>,
      );
    });

    // Autopilot — trade rejected (EMAIL+IN_APP, HIGH: usually a risk/drawdown gate the client should see promptly)
    eventBus.on("autopilot.rejected", (e) => {
      void this.sendAll(e.userId, "autopilot", "HIGH",
        `Autopilot trade rejected — ${e.symbol}`,
        e.reason,
        e as unknown as Record<string, unknown>,
      );
    });

    // Autopilot — position managed (IN_APP only — fires every 30s cycle per
    // managed position, same noise-control choice already made for position.closed above)
    eventBus.on("autopilot.position_managed", (e) => {
      const bodyByAction: Record<typeof e.action, string> = {
        REGIME_EXIT:    "Closed early — the market regime reversed against this position.",
        TIME_STOP:      "Closed — no progress within the configured time limit.",
        BREAK_EVEN:     "Stop loss moved to break-even.",
        TRAILING_STOP:  `Trailing stop tightened${e.stopLoss !== undefined ? ` to ${e.stopLoss.toFixed(5)}` : ""}.`,
      };
      void this.send({
        userId: e.userId, channel: "IN_APP", category: "autopilot", priority: "NORMAL",
        title:  `Autopilot — ${e.symbol}`,
        body:   bodyByAction[e.action],
        payload: e as unknown as Record<string, unknown>,
      });
    });

    // Autopilot — config changed (IN_APP only, low-noise confirmation)
    eventBus.on("autopilot.config_changed", (e) => {
      void this.send({
        userId: e.userId, channel: "IN_APP", category: "autopilot", priority: "LOW",
        title:  "Autopilot settings updated",
        body:   `Autopilot is now ${e.enabled ? "ON" : "OFF"}.`,
        payload: e as unknown as Record<string, unknown>,
      });
    });

    // OLOS signals (high confidence only)
    eventBus.on("signal.generated", (e) => {
      const conf = Number((e as Record<string, unknown>).confidence ?? 0);
      if (conf < 75) return;
      void this.send({
        userId:   "BROADCAST", channel: "IN_APP", category: "signal", priority: "NORMAL",
        title:    `OLOS signal — ${String((e as Record<string, unknown>).symbol ?? "")}`,
        body:     `${String((e as Record<string, unknown>).signalType ?? "")} signal with ${conf.toFixed(0)}% confidence`,
        payload:  e as unknown as Record<string, unknown>,
      });
    });

    console.log("[notification-router] subscribed to all domain events");
  }
}

export const notificationRouter = new NotificationRouter();
export default notificationRouter;
