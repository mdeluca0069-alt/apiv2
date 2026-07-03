/**
 * WebhookSender — delivers events to broker-configured HTTP webhooks.
 * Retries up to 3× with exponential backoff. Writes delivery status to AuditLog.
 */
import { randomUUID } from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

export type WebhookPayload = {
  event:     string;
  userId?:   string;
  data:      Record<string, unknown>;
  timestamp: string;
};

export class WebhookSenderService {

  private endpoints: string[] = (process.env.WEBHOOK_URLS ?? "").split(",").filter(Boolean);

  async deliver(payload: WebhookPayload): Promise<void> {
    if (!this.endpoints.length) return;

    const body    = JSON.stringify(payload);
    const sig     = this._sign(body);
    const results: { url: string; ok: boolean; statusCode?: number }[] = [];

    for (const url of this.endpoints) {
      let ok = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(url, {
            method:  "POST",
            headers: {
              "Content-Type":       "application/json",
              "X-IGFXPRO-Signature": sig,
              "X-IGFXPRO-Event":     payload.event,
            },
            body,
            signal: AbortSignal.timeout(5_000),
          });
          if (res.ok) { ok = true; break; }
        } catch { /* retry */ }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
      results.push({ url: url.replace(/\/\/[^@]+@/, "//***@"), ok });
    }

    if (IS_PERSISTENT) {
      await (prisma as NonNullable<typeof prisma>).auditLog.create({
        data: {
          id:      randomUUID(),
          actor:   "WEBHOOK_SENDER",
          action:  `webhook.${payload.event}`,
          entity:  payload.userId ?? "SYSTEM",
          payload: { results, event: payload.event } as object,
        },
      });
    }
  }

  private _sign(body: string): string {
    const secret = process.env.WEBHOOK_SECRET ?? "igfxpro-webhook-dev";
    const { createHmac } = require("node:crypto");
    return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  }
}

export const webhookSender = new WebhookSenderService();
export default webhookSender;
