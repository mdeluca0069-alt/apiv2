import { createHash, timingSafeEqual } from "node:crypto";
import type { PspAdapter, CreateSessionInput, CreateSessionResult, WebhookParseResult } from "./psp.adapter.js";

// Nuvei Simply Connect / PPP API
// Docs: https://docs.nuvei.com

type NuveiOrderResponse = {
  status:    string;
  errCode?:  string;
  reason?:   string;
  sessionToken: string;
  userTokenId?: string;
};

type NuveiWebhookPayload = {
  ppp_status:      string;  // OK | FAIL
  Status:          string;  // APPROVED | DECLINED | PENDING | ERROR
  TransactionID:   string;
  totalAmount:     string;
  currency:        string;
  merchant_unique_id: string; // our depositId
  advanceResponseChecksum?: string;
};

export class NuveiAdapter implements PspAdapter {
  readonly name = "NUVEI" as const;

  private readonly merchantId:   string;
  private readonly merchantSite: string;
  private readonly secretKey:    string;
  private readonly env:          string; // int | prod

  constructor() {
    this.merchantId   = process.env.NUVEI_MERCHANT_ID   ?? "";
    this.merchantSite = process.env.NUVEI_MERCHANT_SITE ?? "";
    this.secretKey    = process.env.NUVEI_SECRET_KEY    ?? "";
    this.env          = process.env.NUVEI_ENV           ?? "int";
    if (!this.merchantId || !this.merchantSite || !this.secretKey) {
      throw new Error("NUVEI credentials not configured (NUVEI_MERCHANT_ID / NUVEI_MERCHANT_SITE / NUVEI_SECRET_KEY)");
    }
  }

  private get baseUrl(): string {
    return this.env === "prod"
      ? "https://secure.safecharge.com/ppp"
      : "https://ppp-test.nuvei.com/ppp";
  }

  // Nuvei requires SHA-256 checksum: merchantId + merchantSite + clientRequestId + amount + currency + timeStamp + secretKey
  private openOrderChecksum(clientRequestId: string, amount: string, currency: string, ts: string): string {
    const raw = `${this.merchantId}${this.merchantSite}${clientRequestId}${amount}${currency}${ts}${this.secretKey}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const ts       = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    const amount   = input.amount.toFixed(2);
    const checksum = this.openOrderChecksum(input.depositId, amount, input.currency, ts);

    const body = {
      merchantId:        this.merchantId,
      merchantSiteId:    this.merchantSite,
      clientRequestId:   input.depositId,
      amount,
      currency:          input.currency,
      timeStamp:         ts,
      checksum,
      clientUniqueId:    input.userId,
      successUrl:        input.returnUrl,
      failureUrl:        `${input.returnUrl}?status=failed`,
      pendingUrl:        `${input.returnUrl}?status=pending`,
      notificationUrl:   input.webhookUrl,
      userTokenId:       input.userId,
    };

    const res = await fetch(`${this.baseUrl}/api/v1/openOrder.do`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`NUVEI_OPEN_ORDER_HTTP:${res.status}`);

    const data = await res.json() as NuveiOrderResponse;
    if (data.status !== "SUCCESS") {
      throw new Error(`NUVEI_OPEN_ORDER_ERROR:${data.errCode}:${data.reason}`);
    }

    const redirectUrl = `${this.baseUrl}/purchase.do?sessionToken=${data.sessionToken}`;
    return {
      sessionId:   data.sessionToken,
      redirectUrl,
    };
  }

  async parseWebhook(rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): Promise<WebhookParseResult> {
    const payload = Object.fromEntries(new URLSearchParams(rawBody.toString())) as unknown as NuveiWebhookPayload;

    this.verifyNuveiChecksum(payload);

    const transactionId = payload.TransactionID;
    const status        = payload.Status?.toUpperCase();

    if (status === "APPROVED") {
      return {
        pspRef:   transactionId,
        status:   "CONFIRMED",
        amount:   parseFloat(payload.totalAmount),
        currency: payload.currency,
      };
    }

    if (status === "DECLINED" || status === "ERROR") {
      return {
        pspRef:     transactionId,
        status:     "FAILED",
        failReason: `Nuvei status: ${status}`,
      };
    }

    throw new Error(`NUVEI_UNHANDLED_STATUS:${status}`);
  }

  // Nuvei advanceResponseChecksum: SHA-256 of secretKey + totalAmount + currency + ppp_status + Status + TransactionID
  private verifyNuveiChecksum(payload: NuveiWebhookPayload): void {
    const raw      = `${this.secretKey}${payload.totalAmount}${payload.currency}${payload.ppp_status}${payload.Status}${payload.TransactionID}`;
    const expected = createHash("sha256").update(raw).digest("hex");
    const received = payload.advanceResponseChecksum ?? "";
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(received.padEnd(expected.length, " ").slice(0, expected.length)))) {
      throw new Error("NUVEI_CHECKSUM_INVALID");
    }
  }
}
