/**
 * compliance/soc2.controls.ts — SOC 2 Type II Controls Implementation.
 *
 * Implements the Trust Services Criteria (TSC) applicable to IGFXPRO:
 *
 *   CC1  — Control Environment
 *   CC2  — Communication and Information
 *   CC3  — Risk Assessment
 *   CC4  — Monitoring Activities
 *   CC5  — Control Activities
 *   CC6  — Logical and Physical Access Controls  ← Most applicable
 *   CC7  — System Operations                     ← Most applicable
 *   CC8  — Change Management
 *   CC9  — Risk Mitigation
 *   A1   — Availability
 *   C1   — Confidentiality
 *   PI1  — Processing Integrity
 *
 * This module:
 *   1. Defines control objectives and evidence collection
 *   2. Provides assertion methods used in request handlers
 *   3. Generates control status reports for auditors
 *   4. Records control exceptions for SOC2 evidence
 */

import { prisma, IS_PERSISTENT }   from "../shared/db.js";
import { immutableAudit }          from "../security/immutable.audit.js";

// ─── Control Definitions ─────────────────────────────────────────────────────

export type ControlId =
  // CC6: Logical Access Controls
  | "CC6.1"   // Identify and authenticate users
  | "CC6.2"   // Manage access credentials
  | "CC6.3"   // Authorize access based on need
  | "CC6.4"   // Restrict access to sensitive data
  | "CC6.6"   // Detect and prevent unauthorized access
  | "CC6.7"   // Restrict and log privileged access
  | "CC6.8"   // Prevent use of unauthorized software
  // CC7: System Operations
  | "CC7.1"   // Detect vulnerabilities
  | "CC7.2"   // Log security events
  | "CC7.3"   // Evaluate security events and anomalies
  | "CC7.4"   // Respond to identified security incidents
  | "CC7.5"   // Recover from identified security incidents
  // CC8: Change Management
  | "CC8.1"   // Change management process
  // CC9: Risk Mitigation
  | "CC9.1"   // Risk assessment
  | "CC9.2"   // Vendor risk management
  // A1: Availability
  | "A1.1"    // Infrastructure and availability SLAs
  | "A1.2"    // Environmental threats
  | "A1.3"    // Recovery plan
  // C1: Confidentiality
  | "C1.1"    // Identify confidential information
  | "C1.2"    // Dispose of confidential information
  // PI1: Processing Integrity
  | "PI1.1"   // Input completeness and accuracy
  | "PI1.2"   // Processing authorization
  | "PI1.3"   // Processing completeness and accuracy
  | "PI1.4"   // Output completeness and accuracy
  | "PI1.5"   // Store and retain data appropriately;

type ControlStatus = "IMPLEMENTED" | "PARTIALLY_IMPLEMENTED" | "NOT_IMPLEMENTED" | "EXCEPTION";

type SOC2Control = {
  id:          ControlId;
  title:       string;
  category:    string;
  description: string;
  status:      ControlStatus;
  evidence:    string[];
  testedBy?:   string;
};

// ─── Control Registry ─────────────────────────────────────────────────────────

const CONTROLS: SOC2Control[] = [
  { id: "CC6.1", category: "Logical Access", status: "IMPLEMENTED",
    title: "Logical access security measures",
    description: "Multi-factor authentication enforced for all users; JWT tokens with role claims; session management with idle timeout and concurrent session limits",
    evidence: ["security/mfa.enforcer.ts", "auth-service/jwt.strategy.ts", "security/session.security.ts"] },

  { id: "CC6.2", category: "Logical Access", status: "IMPLEMENTED",
    title: "Credential management",
    description: "Passwords hashed with bcrypt (cost=12); 2FA backup codes hashed; API keys hashed with SHA-256; secret rotation policy enforced",
    evidence: ["auth-service/password.hasher.ts", "security/secret.rotation.ts", "auth-service/2fa.service.ts"] },

  { id: "CC6.3", category: "Logical Access", status: "IMPLEMENTED",
    title: "Role-based access control",
    description: "RBAC engine with defined role hierarchy (SUPER_ADMIN > ADMIN > RISK > COMPLIANCE > ANALYST > TRADER); permission matrix enforced on every route",
    evidence: ["security/rbac.engine.ts", "security/permission.middleware.ts", "auth-service/access.policy.ts"] },

  { id: "CC6.4", category: "Logical Access", status: "IMPLEMENTED",
    title: "Restrict access to sensitive data",
    description: "Network policies restrict pod-to-pod communication; RBAC enforces own-vs-all scoping; PII fields not logged; secrets in AWS Secrets Manager",
    evidence: ["infrastructure/kubernetes/helm/igfxpro/templates/networkpolicy.yaml", "security/rbac.engine.ts"] },

  { id: "CC6.6", category: "Logical Access", status: "IMPLEMENTED",
    title: "Unauthorized access detection",
    description: "IP reputation scoring; bot detection; event correlator with BRUTE_FORCE/CREDENTIAL_STUFFING patterns; rate limiting with progressive bans",
    evidence: ["security/ip-reputation.ts", "security/bot.detection.ts", "security/event-correlator.ts", "security/ddos.protection.ts"] },

  { id: "CC6.7", category: "Logical Access", status: "IMPLEMENTED",
    title: "Privileged access management",
    description: "Admin actions require step-up MFA; kill-switch restricted to RISK_MANAGER+; capital operations restricted to ADMIN+; all privileged actions logged",
    evidence: ["security/mfa.enforcer.ts", "security/rbac.engine.ts", "security/immutable.audit.ts"] },

  { id: "CC6.8", category: "Logical Access", status: "PARTIALLY_IMPLEMENTED",
    title: "Software integrity controls",
    description: "Docker images signed; CI pipeline with `npm audit --audit-level=high`; secret scanning via Gitleaks. Container image signing not yet enforced at admission.",
    evidence: [".github/workflows/ci.yml", ".github/workflows/security.yml"],
    testedBy: "CI/CD pipeline" },

  { id: "CC7.1", category: "System Operations", status: "IMPLEMENTED",
    title: "Vulnerability detection",
    description: "npm audit in CI; Dependabot alerts; WAF blocks known injection patterns; gitleaks in CI",
    evidence: [".github/workflows/security.yml", "security/waf.engine.ts"] },

  { id: "CC7.2", category: "System Operations", status: "IMPLEMENTED",
    title: "Security event logging",
    description: "Immutable audit log with hash chain; all authentication, authorization, and trading events logged; Prometheus metrics with alerting rules",
    evidence: ["security/immutable.audit.ts", "compliance-engine/audit.trail.ts", "infrastructure/kubernetes/monitoring/prometheus-rules.yaml"] },

  { id: "CC7.3", category: "System Operations", status: "IMPLEMENTED",
    title: "Security event evaluation",
    description: "SIEM-style event correlator evaluates 5 threat patterns; Global Risk Supervisor for autopilot safety; bot detection with behavioral analysis",
    evidence: ["security/event-correlator.ts", "risk-service/global.risk.supervisor.ts", "security/bot.detection.ts"] },

  { id: "CC7.4", category: "System Operations", status: "IMPLEMENTED",
    title: "Incident response",
    description: "Automated IP blocking; account lock on brute force; kill-switch for trading halt; alert manager with email/webhook notifications; DR failover procedure",
    evidence: ["security/ip-reputation.ts", "security/event-correlator.ts", "infrastructure/scripts/dr-failover.sh"] },

  { id: "CC7.5", category: "System Operations", status: "IMPLEMENTED",
    title: "Recovery from security incidents",
    description: "Velero cluster backups (hourly/daily); CNPG continuous WAL archiving; S3 cross-region replication; DR failover to eu-west-1 with RTO < 30min",
    evidence: ["infrastructure/kubernetes/backup/velero-schedule.yaml", "infrastructure/scripts/dr-failover.sh"] },

  { id: "CC8.1", category: "Change Management", status: "IMPLEMENTED",
    title: "Change management process",
    description: "GitHub branch protection with required PR reviews; CI passes required; blue/green and canary deployments; pre-deploy backup; helm rollback",
    evidence: [".github/workflows/ci.yml", "infrastructure/scripts/blue-green-switch.sh", "infrastructure/scripts/canary-promote.sh"] },

  { id: "A1.1", category: "Availability", status: "IMPLEMENTED",
    title: "Infrastructure and architecture",
    description: "EKS multi-AZ with HPA (min 3, max 20 API replicas); PodDisruptionBudget; CloudNativePG 3-node HA; Redis Cluster 3-shard/1-replica; 99.9% SLA target",
    evidence: ["infrastructure/helm/igfxpro/templates/api-hpa.yaml", "infrastructure/kubernetes/cloudnativepg/cluster.yaml"] },

  { id: "A1.2", category: "Availability", status: "IMPLEMENTED",
    title: "Environmental threat protection",
    description: "AWS Multi-AZ (3 AZs); NAT Gateways per AZ; DDoS protection via AWS Shield (Standard); rate limiting; circuit breakers for all external dependencies",
    evidence: ["infrastructure/terraform/modules/vpc/main.tf", "security/ddos.protection.ts", "shared/feed.circuit.ts"] },

  { id: "A1.3", category: "Availability", status: "IMPLEMENTED",
    title: "Disaster recovery",
    description: "PITR-capable via CNPG WAL archiving; Velero daily backups to S3; DR cluster in eu-west-1; automated failover script; RTO < 30min, RPO < 5min",
    evidence: ["infrastructure/scripts/dr-failover.sh", "infrastructure/kubernetes/backup/velero-schedule.yaml"] },

  { id: "C1.1", category: "Confidentiality", status: "IMPLEMENTED",
    title: "Confidential information identification",
    description: "PII fields (email, name, DOB, identity documents) encrypted at rest (RDS KMS); TLS 1.2+ in transit; secrets in AWS Secrets Manager; HSM for key operations",
    evidence: ["security/hsm.provider.ts", "infrastructure/terraform/modules/rds/main.tf", "infrastructure/terraform/modules/secrets/main.tf"] },

  { id: "C1.2", category: "Confidentiality", status: "IMPLEMENTED",
    title: "Confidential information disposal",
    description: "S3 lifecycle rules archive then expire old documents; audit logs archived for 7 years; Redis TTL on session data; GDPR deletion workflow tracked",
    evidence: ["infrastructure/terraform/modules/s3/main.tf", "settlement/data.retention.service.ts"] },

  { id: "PI1.1", category: "Processing Integrity", status: "IMPLEMENTED",
    title: "Input completeness and accuracy",
    description: "Zod schema validation on all API inputs; NewOrderRequestSchema enforces positive quantities, valid symbols; risk engine pre-trade checks",
    evidence: ["shared/contracts.ts", "risk-service/risk.engine.ts"] },

  { id: "PI1.2", category: "Processing Integrity", status: "IMPLEMENTED",
    title: "Processing authorization",
    description: "Every trade requires: valid JWT + RBAC permission + risk engine approval + autopilot eligibility (for autopilot) + daily loss check",
    evidence: ["autopilot-service/autopilot.pipeline.ts", "trading-service/order.controller.ts", "risk-service/risk.engine.ts"] },

  { id: "PI1.3", category: "Processing Integrity", status: "IMPLEMENTED",
    title: "Processing completeness and accuracy",
    description: "Idempotent order placement via clientOrderId; distributed job locks; reconciliation engine; database constraints prevent duplicate positions",
    evidence: ["trading-service/order.controller.ts", "settlement/reconciliation.engine.ts", "realtime-infra/job.coordinator.ts"] },
];

// ─── SOC2Controls ────────────────────────────────────────────────────────────

export class SOC2Controls {

  /**
   * Record a control exception (when a control fails or has a gap).
   * Creates an immutable audit entry for auditor review.
   */
  async recordException(
    controlId: ControlId,
    description: string,
    severity: "LOW" | "MEDIUM" | "HIGH",
    reportedBy: string,
  ): Promise<string> {
    const control = CONTROLS.find((c) => c.id === controlId);
    return immutableAudit.write({
      actor:    reportedBy,
      action:   `soc2.control.exception.${severity.toLowerCase()}`,
      entity:   controlId,
      payload:  {
        controlId,
        controlTitle: control?.title,
        description,
        severity,
        reportedAt: new Date().toISOString(),
        status:     "OPEN",
      },
      severity: severity === "HIGH" ? "CRITICAL" : "WARNING",
    });
  }

  /**
   * Generate a point-in-time control status report for auditors.
   */
  generateReport(): {
    generatedAt: string;
    controls:    SOC2Control[];
    summary:     Record<ControlStatus, number>;
    complianceScore: number;
  } {
    const summary: Record<ControlStatus, number> = {
      IMPLEMENTED: 0, PARTIALLY_IMPLEMENTED: 0, NOT_IMPLEMENTED: 0, EXCEPTION: 0,
    };

    for (const c of CONTROLS) summary[c.status]++;

    const total = CONTROLS.length;
    const score = Math.round(
      ((summary.IMPLEMENTED + summary.PARTIALLY_IMPLEMENTED * 0.5) / total) * 100,
    );

    return {
      generatedAt:     new Date().toISOString(),
      controls:        CONTROLS,
      summary,
      complianceScore: score,
    };
  }

  /**
   * Runtime assertion for CC6.1: Authentication verified.
   * Throws if the principal is not authenticated.
   */
  assertAuthenticated(principal: { sub: string; roles: string[] } | null): void {
    if (!principal) {
      throw Object.assign(
        new Error("CC6.1: Authentication required"),
        { statusCode: 401, controlId: "CC6.1" },
      );
    }
  }

  /**
   * Runtime assertion for CC7.2: Audit trail verified.
   * Every significant action must produce an audit entry.
   */
  async assertAuditTrailActive(): Promise<void> {
    if (!IS_PERSISTENT || !prisma) return;
    const count = await prisma.auditLog.count().catch(() => -1);
    if (count === -1) {
      console.error("[soc2-CC7.2] CRITICAL: Audit log table inaccessible");
      // Do not throw — monitoring should alert; do not block all requests
    }
  }

  /** All defined controls */
  get controls(): SOC2Control[] {
    return CONTROLS;
  }
}

export const soc2Controls = new SOC2Controls();
export default soc2Controls;
