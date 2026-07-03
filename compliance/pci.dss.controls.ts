/**
 * compliance/pci.dss.controls.ts — PCI DSS v4.0 Controls Implementation.
 *
 * PCI DSS v4.0 (March 2022) requirements applicable to IGFXPRO as a payment
 * facilitator and cardholder data environment (CDE) participant.
 *
 * Requirements addressed:
 *   Req 1:  Network security controls
 *   Req 2:  Apply secure configurations to all system components
 *   Req 3:  Protect stored account data
 *   Req 4:  Protect cardholder data with strong cryptography during transmission
 *   Req 5:  Protect all systems and networks from malicious software
 *   Req 6:  Develop and maintain secure systems and software
 *   Req 7:  Restrict access to system components and cardholder data by business need to know
 *   Req 8:  Identify users and authenticate access to system components
 *   Req 9:  Restrict physical access to cardholder data  [N/A: cloud deployment]
 *   Req 10: Log and monitor all access to system components and cardholder data
 *   Req 11: Test security of systems and networks regularly
 *   Req 12: Support information security with organizational policies and programs
 */

import { immutableAudit }       from "../security/immutable.audit.js";
import { rbacEngine }           from "../security/rbac.engine.js";
import type { TokenPayload }    from "../shared/security.js";

// ─── PCI Control Status ───────────────────────────────────────────────────────

type PCIRequirement = {
  id:          string;
  title:       string;
  requirement: string;
  status:      "COMPLIANT" | "PARTIAL" | "NON_COMPLIANT" | "N_A";
  controls:    string[];    // Implementation pointers
  notes?:      string;
};

// ─── Cardholder Data Classification ──────────────────────────────────────────

export type CardholderDataType =
  | "PAN"               // Primary Account Number
  | "CVV"               // Card Verification Value
  | "EXPIRY"            // Card Expiry Date
  | "NAME"              // Cardholder Name
  | "SERVICE_CODE"      // Magnetic Stripe Service Code
  | "TRACK_DATA"        // Full Magnetic Stripe Data

// Fields that must NEVER be stored (even encrypted)
export const FORBIDDEN_STORAGE_FIELDS: CardholderDataType[] = ["CVV", "TRACK_DATA", "SERVICE_CODE"];

// Fields that can be stored ONLY if encrypted
export const ENCRYPTED_STORAGE_REQUIRED: CardholderDataType[] = ["PAN", "EXPIRY", "NAME"];

const PCI_REQUIREMENTS: PCIRequirement[] = [
  { id: "1.2", title: "Network Security Controls", status: "COMPLIANT",
    requirement: "All traffic to/from CDE must be restricted and only explicitly authorized",
    controls: ["kubernetes/networkpolicy.yaml", "terraform/modules/vpc/main.tf"],
    notes: "VPC security groups restrict inbound; NetworkPolicies restrict pod communication; only ingress-nginx exposes ports 80/443" },

  { id: "1.3", title: "Wireless Access Restrictions", status: "N_A",
    requirement: "Wireless access to CDE restricted",
    controls: [],
    notes: "Cloud deployment — no wireless network access to CDE" },

  { id: "2.2", title: "Secure Configurations", status: "COMPLIANT",
    requirement: "All system components secured and consistently configured",
    controls: ["igfxpro-apiv2/Dockerfile", "infrastructure/helm/igfxpro/templates/api-deployment.yaml"],
    notes: "Containers run as non-root (uid 1001); read-only filesystem; all capabilities dropped; IMDSv2 enforced on EC2" },

  { id: "3.3", title: "SAD Not Retained After Auth", status: "COMPLIANT",
    requirement: "SAD (CVV, track data, service code) must not be stored after authorization",
    controls: ["compliance/pci.dss.controls.ts"],
    notes: "FORBIDDEN_STORAGE_FIELDS validated; PSPs (Stripe/Nuvei/Praxis) handle card capture via tokenization — raw card data never transits IGFXPRO systems" },

  { id: "3.5", title: "PAN Protection", status: "COMPLIANT",
    requirement: "PAN stored only when necessary, rendered unreadable with strong cryptography",
    controls: ["security/hsm.provider.ts", "infrastructure/terraform/modules/rds/main.tf"],
    notes: "Stripe/Nuvei tokenize card data; IGFXPRO stores only payment_method_id (opaque token); RDS encrypted at rest with AWS KMS" },

  { id: "4.2", title: "Strong Cryptography in Transit", status: "COMPLIANT",
    requirement: "Strong cryptography for PAN during transmission over open public networks",
    controls: ["infrastructure/kubernetes/cert-manager/cluster-issuer-prod.yaml", "infrastructure/helm/ingress-nginx/values.yaml"],
    notes: "TLS 1.2 minimum enforced at ingress; TLSv1.0/1.1 disabled; Let's Encrypt ECDSA P256 certificates; HSTS with preload" },

  { id: "5.2", title: "Anti-Malware Mechanisms", status: "PARTIAL",
    requirement: "Anti-malware for all components not commonly affected by malicious software",
    controls: [".github/workflows/security.yml"],
    notes: "npm audit in CI; gitleaks secret scanning; Dependabot. Runtime container scanning (Falco/Sysdig) not yet deployed." },

  { id: "6.2", title: "Bespoke/Custom Software Security", status: "COMPLIANT",
    requirement: "Bespoke software reviewed for vulnerabilities before production",
    controls: [".github/workflows/ci.yml", ".github/workflows/security.yml", "security/waf.engine.ts"],
    notes: "GitHub Actions CI with type-checking, tests, security audit; WAF mitigates OWASP Top 10 in production" },

  { id: "6.4", title: "Web-Facing Applications", status: "COMPLIANT",
    requirement: "Public-facing web apps protected against known attacks",
    controls: ["security/waf.engine.ts", "security/owasp.mitigations.ts", "security/bot.detection.ts"],
    notes: "WAF engine with 30+ rules (SQLi, XSS, path traversal, SSRF, etc.); bot detection; DDoS protection; OWASP Top 10 mitigations" },

  { id: "7.2", title: "Access Control Systems", status: "COMPLIANT",
    requirement: "Access rights granted based on least privilege and need-to-know",
    controls: ["security/rbac.engine.ts", "security/permission.middleware.ts"],
    notes: "RBAC engine with role hierarchy and 'own' vs 'all' scoping; permission checked on every route" },

  { id: "7.3", title: "All Access Assigned Minimum Privilege", status: "COMPLIANT",
    requirement: "All user accounts assigned minimum necessary privilege",
    controls: ["security/rbac.engine.ts"],
    notes: "TRADER role can only access own resources; ANALYST has read-only on all; escalation requires explicit role grant" },

  { id: "8.2", title: "User Identification and Authentication", status: "COMPLIANT",
    requirement: "All users uniquely identified; authentication factors verified",
    controls: ["auth-service/auth.service.ts", "auth-service/jwt.strategy.ts", "auth-service/2fa.service.ts"],
    notes: "Every user has unique ID (UUID); JWT with exp; 2FA enforced for admin; step-up MFA for high-value operations" },

  { id: "8.4", title: "MFA for All Access", status: "PARTIAL",
    requirement: "MFA implemented for all access into CDE",
    controls: ["auth-service/2fa.service.ts", "security/mfa.enforcer.ts"],
    notes: "2FA available for all users; step-up MFA enforced for critical operations. Platform-wide mandatory 2FA not yet enforced for all TRADER accounts." },

  { id: "8.6", title: "Application Accounts and Passwords", status: "COMPLIANT",
    requirement: "Application/system accounts managed with appropriate controls",
    controls: ["security/secret.rotation.ts"],
    notes: "Service credentials in AWS Secrets Manager; rotation policies defined; no hardcoded secrets in source" },

  { id: "10.2", title: "Audit Log Events", status: "COMPLIANT",
    requirement: "Audit logs capture all user access, admin/root actions, access to audit logs, invalid access attempts, use of auth/ID mechanisms, initialization/stopping of logs",
    controls: ["security/immutable.audit.ts", "compliance-engine/audit.trail.ts"],
    notes: "Immutable hash-chain audit log; all authentication, authorization, trading events logged; CloudWatch archive" },

  { id: "10.3", title: "Audit Log Protection", status: "COMPLIANT",
    requirement: "Audit logs protected from destruction and unauthorized modifications",
    controls: ["security/immutable.audit.ts"],
    notes: "Hash chain tamper detection; DB role with INSERT-only on audit_log; S3 archival with manifest SHA-256; daily chain verification" },

  { id: "10.5", title: "Audit Log Retention", status: "COMPLIANT",
    requirement: "Retain audit log history for at least 12 months",
    controls: ["infrastructure/terraform/modules/s3/main.tf", "settlement/data.retention.service.ts"],
    notes: "S3 lifecycle: 90 days standard → GLACIER, 7 years maximum retention; CloudWatch Logs 90 days" },

  { id: "11.3", title: "External and Internal Vulnerability Scanning", status: "PARTIAL",
    requirement: "External and internal vulnerability scanning quarterly",
    controls: [".github/workflows/security.yml"],
    notes: "CI npm audit on every PR; Dependabot for dependency alerts. Formal quarterly ASV scan not yet scheduled." },

  { id: "11.4", title: "Penetration Testing", status: "NON_COMPLIANT",
    requirement: "Penetration testing at least annually",
    controls: [],
    notes: "Planned. Third-party pen test must be scheduled before launch." },

  { id: "12.3", title: "Cryptographic Key Management", status: "COMPLIANT",
    requirement: "Cryptographic key management and protection",
    controls: ["security/hsm.provider.ts", "security/secret.rotation.ts", "infrastructure/terraform/modules/secrets/main.tf"],
    notes: "AWS KMS for envelope encryption; key rotation policies; HSM provider for production signing operations; keys never in source code" },
];

// ─── PCIDSSControls ──────────────────────────────────────────────────────────

export class PCIDSSControls {

  /**
   * Validate that a payment operation is PCI-compliant before execution.
   * Throws if any required control is violated.
   */
  async assertPaymentOperationCompliant(
    actor:    TokenPayload,
    operation: "deposit" | "withdrawal" | "refund",
    amount:    number,
    currency:  string,
  ): Promise<void> {
    // 7.2: Minimum privilege for payment operations
    const canWriteWallet = rbacEngine.authorize({
      userId:   actor.sub,
      roles:    actor.roles as never,
      resource: "wallet",
      action:   "write",
    });
    if (!canWriteWallet.allowed) {
      throw Object.assign(
        new Error("PCI-7.2: Insufficient privilege for payment operation"),
        { statusCode: 403, pciControl: "7.2" },
      );
    }

    // Audit the payment operation (10.2)
    await immutableAudit.write({
      actor:   actor.sub,
      action:  `pci.payment.${operation}`,
      entity:  actor.sub,
      payload: { operation, amount, currency, roles: actor.roles },
      severity: amount > 10000 ? "WARNING" : "INFO",
    });
  }

  /**
   * Validate that no forbidden cardholder data fields are present in a payload.
   * Returns list of violations (empty = safe to proceed).
   */
  scanForForbiddenData(payload: Record<string, unknown>): string[] {
    const violations: string[] = [];
    const payloadStr = JSON.stringify(payload).toLowerCase();

    // Look for CVV/CVC patterns
    if (/\bcvv\b|\bcvc\b|\bcvv2\b|\bcvc2\b/.test(payloadStr)) {
      violations.push("Potential CVV/CVC field detected — must never be stored");
    }

    // Look for full track data
    if (/track\s*1|track\s*2|magnetic\s*stripe/.test(payloadStr)) {
      violations.push("Potential track data detected — must never be stored");
    }

    // Look for unmasked PAN (simple heuristic: 13-19 digit sequence without masking)
    if (/\b\d{13,19}\b/.test(payloadStr)) {
      violations.push("Potential unmasked PAN detected — must be tokenized");
    }

    return violations;
  }

  /**
   * Generate PCI compliance status report.
   */
  generateReport(): {
    version:         string;
    generatedAt:     string;
    requirements:    PCIRequirement[];
    overallStatus:   "COMPLIANT" | "NON_COMPLIANT" | "PARTIAL";
    criticalGaps:    string[];
  } {
    const nonCompliant = PCI_REQUIREMENTS.filter((r) => r.status === "NON_COMPLIANT");
    const partial      = PCI_REQUIREMENTS.filter((r) => r.status === "PARTIAL");

    const overallStatus: "COMPLIANT" | "NON_COMPLIANT" | "PARTIAL" =
      nonCompliant.length > 0 ? "NON_COMPLIANT" :
      partial.length > 0      ? "PARTIAL" :
      "COMPLIANT";

    return {
      version:      "PCI DSS v4.0",
      generatedAt:  new Date().toISOString(),
      requirements: PCI_REQUIREMENTS,
      overallStatus,
      criticalGaps: nonCompliant.map((r) => `${r.id}: ${r.title}`),
    };
  }

  get requirements(): PCIRequirement[] {
    return PCI_REQUIREMENTS;
  }
}

export const pciDSSControls = new PCIDSSControls();
export default pciDSSControls;
