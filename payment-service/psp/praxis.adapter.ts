import { createHash, timingSafeEqual } from "node:crypto";
import type { PspAdapter, CreateSessionInput, CreateSessionResult, WebhookParseResult } from "./psp.adapter.js";

// Praxis Cashier API
// Docs: https://www.praxiscashier.com/docs

type PraxisSessionResponse = {
  status:     number; // 0 = success
  description?: string;
  data?: {
    session_token: string;
    redirect_url:  string;
    tid?:          string;
  };
};

type PraxisWebhookPayload = {
  merchant_id:       string;
  application_key:   string;
  timestamp:         string;
  transaction_id:    string;
  tid:               string;
  transaction_type:  string;  // deposit
  transaction_status: string; // approved | declined | pending | chargeback | error
  amount:            string;
  currency:          string;
  order_id:          string;  // our depositId
  pin:               string;  // signature
};

export class PraxisAdapter implements PspAdapter {
  readonly name = "PRAXIS" as const;

  private readonly merchantId:  string;
  private readonly appKey:      string;
  private readonly secretKey:   string;
  private readonly baseUrl:     string;

  constructor() {
    this.merchantId = process.env.PRAXIS_MERCHANT_ID  ?? "";
    this.appKey     = process.env.PRAXIS_APP_KEY      ?? "";
    this.secretKey  = process.env.PRAXIS_SECRET_KEY   ?? "";
    this.baseUrl    = process.env.PRAXIS_BASE_URL      ?? "https://cashier.praxiscashier.com";
    if (!this.merchantId || !this.appKey || !this.secretKey) {
      throw new Error("PRAXIS credentials not configured (PRAXIS_MERCHANT_ID / PRAXIS_APP_KEY / PRAXIS_SECRET_KEY)");
    }
  }

  // Praxis signature: MD5(merchant_id + application_key + timestamp + secretKey)
  private sessionPin(timestamp: string): string {
    return createHash("md5")
      .update(`${this.merchantId}${this.appKey}${timestamp}${this.secretKey}`)
      .digest("hex");
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const pin       = this.sessionPin(timestamp);

    const body = {
      merchant_id:     this.merchantId,
      application_key: this.appKey,
      timestamp,
      pin,
      order_id:        input.depositId,
      customer_id:     input.userId,
      amount:          (input.amount * 100).toFixed(0), // Praxis amounts in cents
      currency:        input.currency,
      return_url:      input.returnUrl,
      webhook_url:     input.webhookUrl,
      payment_method:  "CC",
    };

    const res = await fetch(`${this.baseUrl}/api/cashier/merchant/gateway/transfer/init`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`PRAXIS_SESSION_HTTP:${res.status}`);

    const data = await res.json() as PraxisSessionResponse;
    if (data.status !== 0 || !data.data) {
      throw new Error(`PRAXIS_SESSION_ERROR:${data.description}`);
    }

    return {
      sessionId:   data.data.session_token,
      redirectUrl: data.data.redirect_url,
      pspRef:      data.data.tid ?? undefined,
    };
  }

  // CRITICAL_REMEDIATION (C5, defense-in-depth): order_id (our own
  // depositId) was already present on every Praxis webhook payload but
  // never read -- correlation relied solely on pspRef (tid), which
  // createSession() only populates `?? undefined` (Praxis's tid may not be
  // assigned yet at session-creation time for the same reason Nuvei's
  // TransactionID isn't -- see nuvei.adapter.ts's parseWebhook()). Returning
  // order_id as `depositId` gives payment.service.ts a reliable correlation
  // path that doesn't depend on tid having been captured earlier.
  async parseWebhook(rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): Promise<WebhookParseResult> {
    const payload = JSON.parse(rawBody.toString()) as PraxisWebhookPayload;

    this.verifyPraxisSignature(payload);

    const status    = payload.transaction_status?.toLowerCase();
    const depositId = payload.order_id || undefined;

    if (status === "approved") {
      return {
        pspRef:   payload.tid || payload.transaction_id,
        depositId,
        status:   "CONFIRMED",
        amount:   parseFloat(payload.amount) / 100,
        currency: payload.currency,
      };
    }

    if (status === "declined" || status === "error" || status === "chargeback") {
      return {
        pspRef:     payload.tid || payload.transaction_id,
        depositId,
        status:     "FAILED",
        failReason: `Praxis status: ${status}`,
      };
    }

    throw new Error(`PRAXIS_UNHANDLED_STATUS:${status}`);
  }

  // CRITICAL_REMEDIATION (C4): replay window. Praxis's documented pin
  // formula -- MD5(merchant_id + application_key + timestamp + secretKey) --
  // does not bind transaction_id, order_id, amount, or transaction_status
  // (confirmed by reading the formula itself; an attempt to cross-check
  // against Praxis's own docs at https://www.praxiscashier.com/docs, the URL
  // already cited at the top of this file, failed with HTTP 522 at
  // verification time -- origin unreachable, so their exact spec could not
  // be authoritatively re-confirmed. Changing the signed-field set itself is
  // therefore NOT done here: if Praxis's real webhook signer only ever
  // signs over merchant_id+application_key+timestamp, altering the formula
  // client-side would reject every genuine webhook. This is flagged as a
  // residual risk in CRITICAL_REMEDIATION_REPORT.md pending confirmation
  // from Praxis integration support.)
  //
  // What IS fully within our control, and fixed here: without a freshness
  // check, any single valid (timestamp, pin) pair -- e.g. captured from one
  // real, legitimate webhook call for a small deposit -- remains a valid
  // signature FOREVER, since the pin never changes for that timestamp. That
  // pair can be replayed indefinitely with a forged order_id/amount/status
  // (the pin doesn't cover those fields) to fabricate approvals for other
  // deposits. Rejecting stale timestamps bounds that exposure window; it
  // does not by itself fix the missing payload binding (see above), which
  // is why deposit.state.machine.ts's transitionToCredit() (C4, second half)
  // additionally now refuses to credit any amount other than the
  // server-side dep.amount recorded when the deposit was originally
  // requested, regardless of what a webhook -- forged or genuine -- claims.
  private static readonly REPLAY_WINDOW_SECONDS = 15 * 60;

  // Praxis webhook signature: MD5(merchant_id + application_key + timestamp + secretKey)
  private verifyPraxisSignature(payload: PraxisWebhookPayload): void {
    const tsNum = Number(payload.timestamp);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > PraxisAdapter.REPLAY_WINDOW_SECONDS) {
      throw new Error("PRAXIS_TIMESTAMP_OUT_OF_WINDOW");
    }

    const expected = createHash("md5")
      .update(`${this.merchantId}${this.appKey}${payload.timestamp}${this.secretKey}`)
      .digest("hex");
    const received = payload.pin ?? "";
    const expBuf   = Buffer.from(expected);
    const rcvBuf   = Buffer.from(received.padEnd(expected.length).slice(0, expected.length));
    if (!timingSafeEqual(expBuf, rcvBuf)) {
      throw new Error("PRAXIS_SIGNATURE_INVALID");
    }
  }
}
