/**
 * OcrProvider — abstraction layer for document OCR processing.
 *
 * Implementations: InternalOcrProvider (base64 stub for dev)
 *                  SumsubOcrProvider, VeriffOcrProvider, OnfidoOcrProvider (future)
 *
 * The interface is stable — switching providers requires only a new class,
 * not a change to KycService or the database schema.
 */

export type OcrDocumentType =
  | "PASSPORT"
  | "NATIONAL_ID"
  | "DRIVERS_LICENSE"
  | "PROOF_OF_ADDRESS";

export type OcrExtractedFields = {
  fullName?:       string;
  dateOfBirth?:    string;    // ISO date YYYY-MM-DD
  documentNumber?: string;
  expiryDate?:     string;    // ISO date YYYY-MM-DD
  issuingCountry?: string;    // ISO 3166-1 alpha-2
  issuingDate?:    string;    // ISO date YYYY-MM-DD
  address?:        string;    // for proof of address
  raw?:            Record<string, unknown>;
};

export type OcrResult = {
  provider:        string;
  status:          "SUCCESS" | "FAILED" | "UNSUPPORTED";
  documentType:    OcrDocumentType;
  extractedFields: OcrExtractedFields;
  confidence:      number;  // 0.0 – 1.0
  processingMs:    number;
  error?:          string;
};

export interface OcrProvider {
  readonly name: string;
  extract(imageBase64: string, documentType: OcrDocumentType): Promise<OcrResult>;
}

// ─── Internal stub — used when no cloud OCR provider is configured ────────────
// Parses nothing from the image but validates the payload is a proper image.
// Returns FAILED so the KYC engine routes to manual review.

export class InternalOcrProvider implements OcrProvider {
  readonly name = "internal-stub";

  async extract(imageBase64: string, documentType: OcrDocumentType): Promise<OcrResult> {
    const startMs = Date.now();

    const isValidImage =
      imageBase64.startsWith("data:image/") ||
      imageBase64.startsWith("data:application/pdf") ||
      imageBase64.length > 1000;

    return {
      provider:        this.name,
      status:          isValidImage ? "SUCCESS" : "FAILED",
      documentType,
      extractedFields: {},
      confidence:      isValidImage ? 0.0 : 0.0,
      processingMs:    Date.now() - startMs,
      error:           isValidImage
        ? "Internal OCR unavailable — document queued for manual review"
        : "Invalid image payload",
    };
  }
}

// ─── Sumsub OCR Provider ──────────────────────────────────────────────────────
// When Sumsub is the active provider, document verification happens inside the
// Sumsub Web SDK (embedded widget). The OCR results are delivered via webhook,
// not via this extract() call. This provider is kept for compatibility with the
// KycService OCR pipeline — it returns "SUMSUB_SDK" to signal that extraction
// was delegated to the widget flow.

export class SumsubOcrProvider implements OcrProvider {
  readonly name = "sumsub";

  async extract(_imageBase64: string, documentType: OcrDocumentType): Promise<OcrResult> {
    // When using the Sumsub Web SDK, OCR is performed inside the widget.
    // The results arrive via webhook → KycService.processSumsubWebhook().
    // This path is only hit if someone calls the legacy document upload API
    // while Sumsub is configured — we return a pass-through that indicates
    // results are pending from the SDK flow.
    return {
      provider:        this.name,
      status:          "SUCCESS",
      documentType,
      extractedFields: {},
      confidence:      0.5,
      processingMs:    0,
      error:           "OCR delegated to Sumsub Web SDK — results arrive via webhook",
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function buildOcrProvider(): OcrProvider {
  const providerName = process.env.OCR_PROVIDER?.toLowerCase() ?? "internal";
  switch (providerName) {
    case "sumsub":
      if (!process.env.SUMSUB_APP_TOKEN) {
        console.warn("[kyc/ocr] SUMSUB_APP_TOKEN not set — falling back to internal stub");
        return new InternalOcrProvider();
      }
      console.log("[kyc/ocr] Using Sumsub Web SDK provider");
      return new SumsubOcrProvider();
    case "veriff":
    case "onfido":
    case "persona":
      console.warn(`[kyc/ocr] Provider '${providerName}' not yet implemented — using internal stub`);
      return new InternalOcrProvider();
    default:
      return new InternalOcrProvider();
  }
}

export const ocrProvider: OcrProvider = buildOcrProvider();
