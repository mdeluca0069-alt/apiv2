/**
 * SumsubProvider — production Sumsub API client.
 *
 * Sumsub API authentication:
 *   Every request is signed with HMAC-SHA256:
 *   signature = HMAC_SHA256(timestamp + method + path + body, SUMSUB_SECRET_KEY)
 *   Headers: App-Token, X-App-Access-Ts, X-App-Access-Sig
 *
 * Webhook verification:
 *   Sumsub sends X-Payload-Digest header = HMAC-SHA256(body, SUMSUB_WEBHOOK_SECRET)
 *
 * Environment variables required:
 *   SUMSUB_APP_TOKEN       — your App Token from Sumsub dashboard
 *   SUMSUB_SECRET_KEY      — your Secret Key from Sumsub dashboard
 *   SUMSUB_LEVEL_NAME      — verification level name (e.g. "basic-kyc-level")
 *   SUMSUB_WEBHOOK_SECRET  — webhook secret from Sumsub dashboard
 *
 * Sumsub review statuses:
 *   reviewAnswer: GREEN  → applicant approved
 *   reviewAnswer: RED    → applicant rejected
 *   reviewStatus: completed | init | pending | prechecked | queued | onHold
 */

import { createHmac } from "node:crypto";
import * as https     from "node:https";

const SUMSUB_BASE = "https://api.sumsub.com";
const APP_TOKEN   = () => process.env.SUMSUB_APP_TOKEN ?? "";
const SECRET_KEY  = () => process.env.SUMSUB_SECRET_KEY ?? "";
const LEVEL_NAME  = () => process.env.SUMSUB_LEVEL_NAME ?? "basic-kyc-level";
const WEBHOOK_SECRET = () => process.env.SUMSUB_WEBHOOK_SECRET ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SumsubApplicant = {
  id:             string;
  externalUserId: string;
  email?:         string;
  createdAt:      string;
  review?:        SumsubReview;
};

export type SumsubReview = {
  reviewId?:     string;
  attemptId?:    string;
  attemptCnt?:   number;
  elapsedSinceDateStarted?: string;
  elapsedSinceDateApplied?: string;
  reprocessing?: boolean;
  levelName?:    string;
  createDate?:   string;
  reviewStatus:  "init" | "pending" | "prechecked" | "queued" | "completed" | "onHold";
  reviewAnswer?: "GREEN" | "RED";
  rejectLabels?: string[];
  reviewRejectType?: string;
  clientComment?: string;
  moderationComment?: string;
};

export type SumsubAccessToken = {
  token:        string;
  userId?:      string;
};

// Webhook event types
export type SumsubWebhookEvent =
  | "applicantCreated"
  | "applicantPending"
  | "applicantReviewed"
  | "applicantOnHold"
  | "applicantPersonalDataChanged"
  | "applicantDeleted";

export type SumsubWebhookPayload = {
  applicantId:       string;
  inspectionId?:     string;
  correlationId?:    string;
  externalUserId?:   string;
  levelName?:        string;
  type:              SumsubWebhookEvent;
  reviewStatus?:     string;
  createdAt?:        string;
  reviewResult?: {
    reviewAnswer:      "GREEN" | "RED";
    label?:            string;
    rejectLabels?:     string[];
    reviewRejectType?: string;
    clientComment?:    string;
    moderationComment?: string;
    buttonIds?:        string[];
  };
};

// ─── HMAC signature ──────────────────────────────────────────────────────────

function sign(ts: number, method: string, path: string, body: string): string {
  const data = `${ts}${method.toUpperCase()}${path}${body}`;
  return createHmac("sha256", SECRET_KEY()).update(data).digest("hex");
}

function buildHeaders(method: string, path: string, body: string): Record<string, string> {
  const ts  = Math.floor(Date.now() / 1_000);
  const sig = sign(ts, method, path, body);
  return {
    "App-Token":          APP_TOKEN(),
    "X-App-Access-Ts":    String(ts),
    "X-App-Access-Sig":   sig,
    "Content-Type":       "application/json",
    "Accept":             "application/json",
  };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function request<T>(
  method: string,
  path:   string,
  body?:  object,
): Promise<T> {
  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = buildHeaders(method, path, bodyStr);
  const url     = new URL(path, SUMSUB_BASE);

  return new Promise((resolve, reject) => {
    const options = {
      method,
      hostname: url.hostname,
      path:     url.pathname + url.search,
      headers,
      timeout: 15_000,
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`Sumsub API ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw) as T);
        } catch {
          reject(new Error(`Sumsub API non-JSON response: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Sumsub API timeout")); });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── SumsubProvider ───────────────────────────────────────────────────────────

export class SumsubProvider {

  get isConfigured(): boolean {
    return Boolean(APP_TOKEN()) && Boolean(SECRET_KEY());
  }

  /**
   * Create a Sumsub applicant for the user (idempotent — returns existing if found).
   */
  async createApplicant(externalUserId: string, email?: string, country?: string): Promise<SumsubApplicant> {
    const body: Record<string, unknown> = {
      externalUserId,
      info: {
        country: country?.toUpperCase() ?? "IT",
        ...(email ? { email } : {}),
      },
    };
    return request<SumsubApplicant>(
      "POST",
      `/resources/applicants?levelName=${encodeURIComponent(LEVEL_NAME())}`,
      body,
    );
  }

  /**
   * Get existing applicant by externalUserId.
   * Returns null if not found (404).
   */
  async getApplicantByExternalId(externalUserId: string): Promise<SumsubApplicant | null> {
    try {
      return await request<SumsubApplicant>(
        "GET",
        `/resources/applicants/-;externalUserId=${encodeURIComponent(externalUserId)}/one`,
      );
    } catch (err) {
      if ((err as Error).message.includes("404")) return null;
      throw err;
    }
  }

  /**
   * Get applicant by Sumsub applicant ID.
   */
  async getApplicant(applicantId: string): Promise<SumsubApplicant> {
    return request<SumsubApplicant>("GET", `/resources/applicants/${applicantId}/one`);
  }

  /**
   * Generate an access token for the Sumsub Web SDK.
   * Token is valid for 10 minutes.
   */
  async generateAccessToken(externalUserId: string, ttlInSecs = 600): Promise<string> {
    const resp = await request<SumsubAccessToken>(
      "POST",
      `/resources/accessTokens?userId=${encodeURIComponent(externalUserId)}&ttlInSecs=${ttlInSecs}&levelName=${encodeURIComponent(LEVEL_NAME())}`,
    );
    return resp.token;
  }

  /**
   * Reset verification attempt (admin action — resets to "init" state).
   */
  async resetApplicant(applicantId: string): Promise<void> {
    await request("POST", `/resources/applicants/${applicantId}/reset`);
  }

  /**
   * Verify Sumsub webhook signature.
   * X-Payload-Digest: HMAC-SHA256(rawBody, SUMSUB_WEBHOOK_SECRET)
   */
  verifyWebhookSignature(rawBody: string, digestHeader: string): boolean {
    const secret = WEBHOOK_SECRET();
    if (!secret) {
      console.warn("[sumsub-webhook] SUMSUB_WEBHOOK_SECRET not set — skipping verification");
      return true; // allow in dev when no secret configured
    }
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    // Timing-safe comparison
    if (expected.length !== digestHeader.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ digestHeader.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * Map Sumsub reviewAnswer to KycCaseStatus.
   */
  mapReviewToStatus(reviewAnswer?: "GREEN" | "RED", reviewStatus?: string): string {
    if (reviewAnswer === "GREEN") return "APPROVED";
    if (reviewAnswer === "RED")   return "REJECTED";
    if (reviewStatus === "pending" || reviewStatus === "queued") return "MANUAL_REVIEW";
    if (reviewStatus === "onHold") return "MANUAL_REVIEW";
    return "DOCUMENT_CHECK";
  }
}

export const sumsubProvider = new SumsubProvider();
