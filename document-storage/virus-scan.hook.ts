// Virus scan integration via HTTP.
//
// Upload flow:
//   1. File is stored under quarantine/{id} in S3/R2.
//   2. triggerScan() POSTs file metadata to the configured scanner endpoint.
//   3. The scanner (e.g. clamav-rest, VirusTotal, CrowdStrike) calls back to
//      POST /api/v1/documents/scan-result with a ScanCallbackPayload, signed
//      with HMAC-SHA256 over the raw body using VIRUS_SCAN_WEBHOOK_SECRET,
//      sent in the X-Scan-Signature header. verifyWebhookSignature() below
//      checks it (Milestone 1 / Fix #5 — this used to not exist at all,
//      despite gateway/routes.ts's comment claiming it did).
//   4. documentStorageService.handleScanResult() moves the file or deletes it.
//
// Compatible scanners (any that support HTTP webhooks):
//   - clamav-rest  (https://github.com/benzino77/clamav-rest)
//   - VirusTotal API v3
//   - Custom internal scanner

import { createHmac, timingSafeEqual } from "node:crypto";

export type ScanTriggerPayload = {
  documentId:  string;
  storageKey:  string;   // quarantine key
  bucket:      string;
  fileName:    string;
  mimeType:    string;
  sizeBytes:   number;
  callbackUrl: string;   // where the scanner POSTs the result
};

export type ScanStatus = "CLEAN" | "INFECTED" | "ERROR";

export type ScanCallbackPayload = {
  documentId: string;
  status:     ScanStatus;
  threats?:   string[];    // e.g. ["Eicar-Test-Signature"]
  scannedAt:  string;      // ISO 8601
  scanner?:   string;      // scanner name/version
};

/**
 * Verifies the HMAC-SHA256 signature the scanner must send on its callback,
 * over the exact raw request bytes. Fails closed: no configured secret, no
 * signature header, or a mismatch are all rejections, never a silent allow.
 */
export function verifyWebhookSignature(
  rawBody:   Buffer,
  signature: string | undefined,
  secret:    string | undefined,
): boolean {
  if (!secret || !signature) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature.trim();

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}

export class VirusScanHook {
  private readonly url: string;
  private readonly token?: string;
  private readonly callbackBase: string;
  readonly enabled: boolean;

  constructor(url?: string, token?: string, callbackBase = "") {
    this.url          = url ?? "";
    this.token        = token;
    this.callbackBase = callbackBase.replace(/\/$/, "");
    this.enabled      = !!url;
  }

  // Sends scan request to the external scanner. Fire-and-forget from the
  // caller's perspective; the result arrives via webhook callback.
  async triggerScan(payload: Omit<ScanTriggerPayload, "callbackUrl">): Promise<void> {
    if (!this.enabled) return;

    const body: ScanTriggerPayload = {
      ...payload,
      callbackUrl: `${this.callbackBase}/api/v1/documents/scan-result`,
    };

    const res = await fetch(this.url, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw Object.assign(
        new Error(`Virus scanner rejected scan request (${res.status}): ${detail}`),
        { statusCode: 503 },
      );
    }
  }

  // Parses and validates the inbound webhook payload from the scanner.
  // Throws on malformed input so the route can return 400.
  parseScanCallback(raw: unknown): ScanCallbackPayload {
    if (!raw || typeof raw !== "object") {
      throw Object.assign(new Error("Scan callback body must be a JSON object"), { statusCode: 400 });
    }
    const r = raw as Record<string, unknown>;

    if (typeof r.documentId !== "string" || !r.documentId) {
      throw Object.assign(new Error("Scan callback missing documentId"), { statusCode: 400 });
    }
    const validStatuses: ScanStatus[] = ["CLEAN", "INFECTED", "ERROR"];
    if (typeof r.status !== "string" || !validStatuses.includes(r.status as ScanStatus)) {
      throw Object.assign(
        new Error(`Scan callback status must be one of: ${validStatuses.join(", ")}`),
        { statusCode: 400 },
      );
    }

    return {
      documentId: r.documentId,
      status:     r.status as ScanStatus,
      threats:    Array.isArray(r.threats) ? (r.threats as string[]) : undefined,
      scannedAt:  typeof r.scannedAt === "string" ? r.scannedAt : new Date().toISOString(),
      scanner:    typeof r.scanner === "string" ? r.scanner : undefined,
    };
  }
}
