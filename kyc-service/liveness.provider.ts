/**
 * LivenessProvider — abstraction layer for selfie / liveness verification.
 *
 * Future integrations: Sumsub, Veriff, Onfido, Persona, iProov
 * All providers implement the same interface — no lock-in.
 */

export type LivenessResult = {
  provider:        string;
  status:          "PASSED" | "FAILED" | "INCONCLUSIVE";
  livenessScore:   number;    // 0.0 – 1.0
  spoofAttempt:    boolean;
  faceMatchScore?: number;    // 0.0 – 1.0 (vs ID document face)
  processingMs:    number;
  error?:          string;
};

export interface LivenessProvider {
  readonly name: string;
  verify(selfieBase64: string, documentFaceBase64?: string): Promise<LivenessResult>;
}

// ─── Internal stub ────────────────────────────────────────────────────────────

export class InternalLivenessProvider implements LivenessProvider {
  readonly name = "internal-stub";

  async verify(selfieBase64: string): Promise<LivenessResult> {
    const startMs   = Date.now();
    const hasImage  = selfieBase64.length > 1000;

    return {
      provider:      this.name,
      status:        hasImage ? "INCONCLUSIVE" : "FAILED",
      livenessScore: 0,
      spoofAttempt:  false,
      processingMs:  Date.now() - startMs,
      error:         hasImage
        ? "Liveness check unavailable — queued for manual review"
        : "Invalid selfie payload",
    };
  }
}

// When Sumsub is the active provider, liveness is handled inside the Web SDK widget.
// This stub returns a pass-through for the legacy selfie upload path.
class SumsubLivenessProvider implements LivenessProvider {
  readonly name = "sumsub";

  async verify(_selfieBase64: string): Promise<LivenessResult> {
    return {
      provider:      this.name,
      status:        "INCONCLUSIVE",
      livenessScore: 0,
      spoofAttempt:  false,
      processingMs:  0,
      error:         "Liveness delegated to Sumsub Web SDK — result arrives via webhook",
    };
  }
}

export function buildLivenessProvider(): LivenessProvider {
  const providerName = process.env.LIVENESS_PROVIDER?.toLowerCase()
    ?? process.env.OCR_PROVIDER?.toLowerCase()
    ?? "internal";

  switch (providerName) {
    case "sumsub":
      if (!process.env.SUMSUB_APP_TOKEN) {
        console.warn("[kyc/liveness] SUMSUB_APP_TOKEN not set — using internal stub");
        return new InternalLivenessProvider();
      }
      console.log("[kyc/liveness] Using Sumsub Web SDK provider");
      return new SumsubLivenessProvider();
    case "veriff":
    case "onfido":
    case "persona":
    case "iproov":
      console.warn(`[kyc/liveness] Provider '${providerName}' not yet wired — using internal stub`);
      return new InternalLivenessProvider();
    default:
      return new InternalLivenessProvider();
  }
}

export const livenessProvider: LivenessProvider = buildLivenessProvider();
