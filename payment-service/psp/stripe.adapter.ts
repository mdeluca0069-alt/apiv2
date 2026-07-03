import { createHmac, timingSafeEqual } from "node:crypto";
import type { PspAdapter, CreateSessionInput, CreateSessionResult, WebhookParseResult } from "./psp.adapter.js";

const STRIPE_API = "https://api.stripe.com/v1";

function stripePost(path: string, secretKey: string, params: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams(params).toString();
  return fetch(`${STRIPE_API}${path}`, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

export class StripeAdapter implements PspAdapter {
  readonly name = "STRIPE" as const;

  private readonly secretKey:      string;
  private readonly webhookSecret:  string;

  constructor() {
    this.secretKey     = process.env.STRIPE_SECRET_KEY     ?? "";
    this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
    if (!this.secretKey)     throw new Error("STRIPE_SECRET_KEY not configured");
    if (!this.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET not configured");
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const amountCents = Math.round(input.amount * 100).toString();

    // Create a Stripe Checkout Session (hosted payment page).
    // We embed the depositId so we can correlate the webhook.
    const res = await stripePost("/checkout/sessions", this.secretKey, {
      "payment_method_types[]":     "card",
      "line_items[0][price_data][currency]":              input.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]":           amountCents,
      "line_items[0][price_data][product_data][name]":   "Account Deposit",
      "line_items[0][quantity]":    "1",
      "mode":                       "payment",
      "success_url":                `${input.returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
      "cancel_url":                 `${input.returnUrl}?cancelled=true`,
      "metadata[deposit_id]":       input.depositId,
      "metadata[user_id]":          input.userId,
      "client_reference_id":        input.depositId,
    });

    if (!res.ok) {
      const err = await res.json() as { error?: { message?: string } };
      throw new Error(`STRIPE_SESSION_ERROR:${err.error?.message ?? res.status}`);
    }

    const session = await res.json() as { id: string; url: string; payment_intent?: string };
    return {
      sessionId:   session.id,
      redirectUrl: session.url,
      pspRef:      session.payment_intent ?? undefined,
    };
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookParseResult> {
    const sigHeader = headers["stripe-signature"];
    const sig       = Array.isArray(sigHeader) ? sigHeader[0] : (sigHeader ?? "");

    this.verifyStripeSignature(rawBody, sig);

    const event = JSON.parse(rawBody.toString()) as {
      type: string;
      data: { object: Record<string, unknown> };
    };

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as {
        payment_status: string;
        payment_intent?: string;
        amount_total?: number;
        currency?: string;
      };
      if (session.payment_status === "paid") {
        return {
          pspRef:   String(session.payment_intent ?? ""),
          status:   "CONFIRMED",
          amount:   session.amount_total ? session.amount_total / 100 : undefined,
          currency: session.currency?.toUpperCase(),
        };
      }
    }

    if (event.type === "payment_intent.payment_failed") {
      const pi = event.data.object as { id: string; last_payment_error?: { message?: string } };
      return {
        pspRef:     pi.id,
        status:     "FAILED",
        failReason: pi.last_payment_error?.message,
      };
    }

    throw new Error(`STRIPE_UNHANDLED_EVENT:${event.type}`);
  }

  // Stripe webhook signature: HMAC-SHA256 over "t=<timestamp>.<body>"
  private verifyStripeSignature(payload: Buffer, sigHeader: string): void {
    const parts = Object.fromEntries(
      sigHeader.split(",").map((p) => p.split("=") as [string, string])
    );
    const t       = parts["t"];
    const v1      = parts["v1"];
    const signed  = Buffer.from(`${t}.${payload.toString()}`);
    const mac     = createHmac("sha256", this.webhookSecret).update(signed).digest("hex");
    const macBuf  = Buffer.from(mac,  "hex");
    const v1Buf   = Buffer.from(v1 ?? "", "hex");
    if (macBuf.length !== v1Buf.length || !timingSafeEqual(macBuf, v1Buf)) {
      throw new Error("STRIPE_SIGNATURE_INVALID");
    }
    // Replay protection: reject events older than 5 minutes
    if (Math.abs(Date.now() / 1000 - Number(t)) > 300) {
      throw new Error("STRIPE_SIGNATURE_EXPIRED");
    }
  }
}
