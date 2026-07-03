import type { IncomingMessage, ServerResponse } from "node:http";
import { PaymentService }  from "./payment.service.js";
import { type PspName }   from "./psp/psp.adapter.js";

const VALID_PSPS: PspName[] = ["STRIPE", "NUVEI", "PRAXIS"];

// Read the raw body as a Buffer — required for signature verification.
// The body must NOT be pre-parsed (no JSON.parse before this runs).
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end",  ()         => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, code: number, body: object): void {
  const json = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(json);
}

export function createWebhookRouter(paymentService: PaymentService) {
  // Route: POST /api/v1/payments/webhooks/:psp
  return async function webhookRouter(
    req:     IncomingMessage,
    res:     ServerResponse,
    pspRaw:  string,
  ): Promise<void> {
    const psp = pspRaw.toUpperCase() as PspName;

    if (!VALID_PSPS.includes(psp)) {
      send(res, 404, { error: `Unknown PSP: ${pspRaw}` });
      return;
    }

    if (req.method !== "POST") {
      send(res, 405, { error: "Method not allowed" });
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req);
    } catch {
      send(res, 400, { error: "Cannot read request body" });
      return;
    }

    const headers = req.headers as Record<string, string | string[] | undefined>;

    try {
      const result = await paymentService.processWebhookConfirmation(psp, rawBody, headers);
      // All PSPs expect HTTP 200 to stop retrying
      send(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code    = (err as { statusCode?: number }).statusCode;

      if (message.includes("SIGNATURE_INVALID") || message.includes("SIGNATURE_EXPIRED")) {
        // Return 400 — PSP will not retry, and alert us to a misconfiguration or attack
        send(res, 400, { error: message });
        return;
      }

      if (message.startsWith("WEBHOOK_NO_DEPOSIT")) {
        // Unknown deposit ref — could be a test event or a race; return 200 to stop PSP retries
        // but log for investigation
        console.warn("[webhook] No deposit found for pspRef:", message);
        send(res, 200, { ok: true, note: "unknown_ref" });
        return;
      }

      if (message.includes("UNHANDLED_EVENT") || message.includes("UNHANDLED_STATUS")) {
        // Ignore event types we don't care about — return 200 so PSP stops retrying
        send(res, 200, { ok: true, note: "event_ignored" });
        return;
      }

      console.error("[webhook] Error processing PSP webhook:", psp, message);
      // Return 500 — PSP will retry, which is the correct behavior for transient errors
      send(res, 500, { error: "Internal error — will retry" });
    }
  };
}
