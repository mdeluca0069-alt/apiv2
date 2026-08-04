/**
 * security/production.env.validator.ts — comprehensive production
 * dependency validation, run once at startup.
 *
 * CUTOVER REMEDIATION (Task 4). Prior to this, main.ts's own inline
 * startup check (validateRequiredSecrets()) only covered JWT/DATABASE_URL/
 * TWELVEDATA_API_KEY/CORS_ORIGIN/ANTHROPIC_API_KEY. Every other integration
 * this platform depends on (Sumsub, Stripe, Nuvei, Praxis, SMTP, AWS, Redis
 * auth) could be left partially configured -- e.g. STRIPE_SECRET_KEY set
 * but STRIPE_WEBHOOK_SECRET forgotten -- and the gap would surface only
 * the first time a real user tried to deposit, not at boot.
 *
 * Design principle, deliberately NOT "every integration is mandatory":
 * PRODUCTION_DEPLOYMENT_CHECKLIST.md's own documented design is that PSP
 * adapters (and Sumsub, SMTP, AWS) are "only enabled when their vars are
 * present" -- a broker can legitimately launch with only Stripe active, or
 * with manual-review-only KYC and no Sumsub at all. Forcing every optional
 * integration to be configured would be a real product regression, not a
 * safety improvement. What this module actually guards against is the
 * failure mode the "Never allow partial production startup" directive is
 * really about: an integration that is PARTIALLY configured -- some of its
 * required variables set, others silently missing -- which behaves fine at
 * boot and then fails unpredictably (or, worse, silently degrades to an
 * insecure fallback, as Sumsub's webhook verification used to, see Task 1)
 * the first time it's actually exercised. Every optional integration below
 * is therefore all-or-nothing: fully configured, or fully absent, never
 * in between.
 *
 * Two integrations this platform depends on operationally (Alertmanager
 * delivery credentials, offsite backup S3) are informational-only here:
 * neither is read by this Node process at all -- Alertmanager's webhook
 * URLs are consumed by the alertmanager container's own config template,
 * and BACKUP_S3_BUCKET is consumed by scripts/backup.sh, a separate cron
 * container. Hard-failing apiv2's own boot on variables it never reads
 * would be dishonest; they're still surfaced as warnings because an
 * incomplete production deployment is worth knowing about even when this
 * specific process isn't the one affected by it.
 */

export type EnvLike = Record<string, string | undefined>;

export type ValidationIssue = {
  severity: "error" | "warning";
  integration: string;
  message: string;
};

export type ValidationReport = {
  ok: boolean; // true iff there are zero "error"-severity issues
  issues: ValidationIssue[];
};

/** All-or-nothing check: either every listed var is set, or none are. */
function checkAllOrNothing(
  env: EnvLike,
  integration: string,
  vars: string[],
  issues: ValidationIssue[],
): void {
  const present = vars.filter((v) => Boolean(env[v]));
  if (present.length === 0 || present.length === vars.length) return;

  const missing = vars.filter((v) => !env[v]);
  issues.push({
    severity: "error",
    integration,
    message:
      `${integration} is PARTIALLY configured -- ${present.join(", ")} ${present.length === 1 ? "is" : "are"} set, ` +
      `but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Either configure all of ` +
      `${vars.join(", ")}, or none of them (the integration stays disabled/manual-fallback until configured).`,
  });
}

/**
 * Runs every production-dependency check and returns a full report
 * (never throws, never exits -- the caller, main.ts, decides what to do
 * with a non-ok report). Pure and side-effect-free so it's independently
 * testable without spawning a process.
 */
export function validateProductionEnvironment(env: EnvLike, isProduction: boolean): ValidationReport {
  const issues: ValidationIssue[] = [];

  if (!isProduction) {
    return { ok: true, issues };
  }

  // ── Core / already-required elsewhere, re-asserted here for a single
  //    comprehensive report (main.ts's own JWT_SECRET-or-RSA and
  //    JWT_CUTOVER_MODE checks stay separate -- see jwt.cutover.guard.ts). ──
  if (!env.DATABASE_URL) {
    issues.push({ severity: "error", integration: "PostgreSQL", message: "DATABASE_URL is required in production." });
  }
  if (!env.TWELVEDATA_API_KEY) {
    issues.push({ severity: "error", integration: "Market data", message: "TWELVEDATA_API_KEY is required in production (without it, most instruments show stale data and orders against them are correctly rejected)." });
  }

  // ── TLS (this process's own scope: it sits behind nginx/Cloudflare, which
  //    actually terminate TLS -- see deployment/nginx/nginx.conf and
  //    FINAL_PRODUCTION_READINESS_REPORT.md §2.1 for the real cert chain.
  //    What THIS process can and must verify is that it isn't configured to
  //    trust a plaintext origin for CORS in production.) ─────────────────
  if (!env.CORS_ORIGIN) {
    issues.push({ severity: "error", integration: "TLS/CORS", message: "CORS_ORIGIN is required in production (must not default to a localhost dev URL)." });
  } else if (!env.CORS_ORIGIN.startsWith("https://")) {
    issues.push({ severity: "error", integration: "TLS/CORS", message: `CORS_ORIGIN="${env.CORS_ORIGIN}" does not use https:// -- a production frontend origin must be served over TLS.` });
  }

  // ── Redis auth (Redis itself is optional by design -- this codebase
  //    degrades gracefully everywhere Redis is used, per shared/redis.ts
  //    and every distributed-lock/pubsub consumer. If it IS configured for
  //    production, it must be authenticated.) ─────────────────────────────
  if (env.REDIS_URL) {
    const hasEmbeddedAuth = /redis:\/\/[^:@/]*:[^@/]+@/.test(env.REDIS_URL);
    if (!hasEmbeddedAuth && !env.REDIS_PASSWORD) {
      issues.push({
        severity: "error",
        integration: "Redis",
        message: "REDIS_URL is configured for production but carries no embedded credentials and REDIS_PASSWORD is not set -- an unauthenticated Redis instance in production is a real security gap (job-lock, rate-limit, and session-cache data would be readable/writable by anything that can reach the port).",
      });
    }
  }

  // ── KYC (Sumsub) -- all 3 or none. SUMSUB_LEVEL_NAME is deliberately
  //    excluded from this consistency check: sumsub.provider.ts's own
  //    LEVEL_NAME() falls back to a working default ("basic-kyc-level"),
  //    so its absence isn't a partial-configuration bug the way a missing
  //    APP_TOKEN/SECRET_KEY/WEBHOOK_SECRET would be. ───────────────────────
  checkAllOrNothing(env, "Sumsub", ["SUMSUB_APP_TOKEN", "SUMSUB_SECRET_KEY", "SUMSUB_WEBHOOK_SECRET"], issues);

  // ── PSPs -- each independently all-or-nothing. At least one PSP being
  //    configured is NOT required (manual-admin-approved deposits remain a
  //    valid launch configuration, matching v1's own historical design). ──
  checkAllOrNothing(env, "Stripe", ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], issues);
  checkAllOrNothing(env, "Nuvei", ["NUVEI_MERCHANT_ID", "NUVEI_MERCHANT_SITE", "NUVEI_SECRET_KEY"], issues);
  checkAllOrNothing(env, "Praxis", ["PRAXIS_MERCHANT_ID", "PRAXIS_APP_KEY", "PRAXIS_SECRET_KEY"], issues);

  // ── SMTP -- all 3 required-for-real-delivery vars or none (SMTP_PORT/
  //    SMTP_FROM have working defaults so aren't part of the consistency
  //    check itself). ────────────────────────────────────────────────────
  checkAllOrNothing(env, "SMTP", ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"], issues);

  // ── AWS (used by document-storage's R2/S3 backend and the compliance
  //    audit-archive endpoint) -- both credential halves or neither. ──────
  checkAllOrNothing(env, "AWS", ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"], issues);

  // ── Informational-only: neither of these is read by this Node process.
  //    Alertmanager's webhooks are consumed by the alertmanager container's
  //    own config template; BACKUP_S3_BUCKET by scripts/backup.sh's own
  //    cron container. Surfaced as warnings, never block this process's
  //    own boot on variables it never actually reads. ─────────────────────
  if (!env.ALERTMANAGER_SLACK_WEBHOOK && !env.ALERTMANAGER_PAGERDUTY_KEY) {
    issues.push({
      severity: "warning",
      integration: "Alertmanager",
      message: "Neither ALERTMANAGER_SLACK_WEBHOOK nor ALERTMANAGER_PAGERDUTY_KEY is set -- the alerting pipeline is functional but has nowhere real to deliver to yet (not read by this process; consumed by the alertmanager container).",
    });
  }
  if (!env.BACKUP_S3_BUCKET) {
    issues.push({
      severity: "warning",
      integration: "Backup",
      message: "BACKUP_S3_BUCKET is not set -- local backups still run, but there is no offsite copy (not read by this process; consumed by the backup cron container's scripts/backup.sh).",
    });
  }

  const ok = !issues.some((i) => i.severity === "error");
  return { ok, issues };
}
