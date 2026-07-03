// Retention policies govern how long documents are stored before deletion.
//
// Regulatory context:
//   - KYC / AML documents: 5–7 years post-relationship-end (FATF / EU 5AMLD)
//   - Trade records:        5 years (MiFID II / ESMA)
//   - General compliance:   3 years minimum
//   - Temp/support files:   30 days

export type RetentionPolicyName =
  | "SHORT_TERM"   // 30 days   — temp uploads, support screenshots
  | "STANDARD"     // 3 years   — general documents
  | "EXTENDED"     // 7 years   — KYC / AML / trade records (regulatory)
  | "PERMANENT";   // never     — legal hold, signed agreements

export type DocumentCategory =
  | "KYC_DOCUMENT"
  | "COMPLIANCE"
  | "TRADE_EVIDENCE"
  | "SUPPORT_ATTACHMENT"
  | "TEMP";

export type RetentionPolicy = {
  name:          RetentionPolicyName;
  retentionDays: number | null;   // null = keep forever
  description:   string;
};

const POLICIES: Record<RetentionPolicyName, RetentionPolicy> = {
  SHORT_TERM: {
    name:          "SHORT_TERM",
    retentionDays: 30,
    description:   "Temporary files — auto-deleted after 30 days",
  },
  STANDARD: {
    name:          "STANDARD",
    retentionDays: 365 * 3,     // 1095 days
    description:   "General compliance documents — 3-year retention",
  },
  EXTENDED: {
    name:          "EXTENDED",
    retentionDays: 365 * 7,     // 2555 days
    description:   "KYC / AML / trade records — 7-year regulatory retention",
  },
  PERMANENT: {
    name:          "PERMANENT",
    retentionDays: null,
    description:   "Legal hold — never deleted automatically",
  },
};

// Default retention policy per document category
const CATEGORY_DEFAULTS: Record<DocumentCategory, RetentionPolicyName> = {
  KYC_DOCUMENT:        "EXTENDED",
  COMPLIANCE:          "EXTENDED",
  TRADE_EVIDENCE:      "EXTENDED",
  SUPPORT_ATTACHMENT:  "STANDARD",
  TEMP:                "SHORT_TERM",
};

export class RetentionPolicyEngine {
  getPolicy(name: RetentionPolicyName): RetentionPolicy {
    return POLICIES[name];
  }

  defaultForCategory(category: string): RetentionPolicyName {
    return CATEGORY_DEFAULTS[category as DocumentCategory] ?? "STANDARD";
  }

  // Computes the absolute expiry date from the policy and an optional anchor.
  computeExpiresAt(policy: RetentionPolicyName, from: Date = new Date()): Date | null {
    const p = POLICIES[policy];
    if (!p.retentionDays) return null;
    const d = new Date(from.getTime());
    d.setDate(d.getDate() + p.retentionDays);
    return d;
  }

  isExpired(retentionUntil: Date | null | undefined): boolean {
    if (!retentionUntil) return false;
    return retentionUntil < new Date();
  }

  allPolicies(): RetentionPolicy[] {
    return Object.values(POLICIES);
  }
}

export const retentionPolicyEngine = new RetentionPolicyEngine();
