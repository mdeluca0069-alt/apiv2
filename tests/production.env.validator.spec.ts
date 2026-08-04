/**
 * production.env.validator.spec.ts
 *
 * CUTOVER REMEDIATION (Task 4) — validateProductionEnvironment() is the
 * comprehensive production-dependency check wired into main.ts's startup
 * sequence. Design principle under test throughout: optional integrations
 * (Sumsub, Stripe, Nuvei, Praxis, SMTP, AWS) are all-or-nothing, not
 * individually mandatory -- a launch with zero PSPs configured (manual-
 * admin-approved deposits only, matching v1's own historical design) must
 * still be a valid, non-blocking configuration; what must be blocked is a
 * PARTIALLY configured integration that would fail unpredictably the
 * first time it's actually used.
 */
import { describe, it, expect } from "vitest";
import { validateProductionEnvironment, type EnvLike } from "../security/production.env.validator.js";

function baseValidEnv(): EnvLike {
  return {
    DATABASE_URL: "postgresql://user:pass@host:5432/db",
    TWELVEDATA_API_KEY: "td-key",
    CORS_ORIGIN: "https://www.igfxpro.com",
  };
}

describe("validateProductionEnvironment() — non-production mode", () => {
  it("is always ok with zero issues when isProduction is false, regardless of how empty the env is", () => {
    const result = validateProductionEnvironment({}, false);
    expect(result).toEqual({ ok: true, issues: [] });
  });
});

describe("validateProductionEnvironment() — core required vars", () => {
  it("passes with just the 3 core vars set and nothing else configured (a legitimate minimal launch)", () => {
    const result = validateProductionEnvironment(baseValidEnv(), true);
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("fails when DATABASE_URL is missing", () => {
    const env = baseValidEnv();
    delete env.DATABASE_URL;
    const result = validateProductionEnvironment(env, true);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.integration === "PostgreSQL")).toBe(true);
  });

  it("fails when TWELVEDATA_API_KEY is missing", () => {
    const env = baseValidEnv();
    delete env.TWELVEDATA_API_KEY;
    const result = validateProductionEnvironment(env, true);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.integration === "Market data")).toBe(true);
  });

  it("fails when CORS_ORIGIN is missing", () => {
    const env = baseValidEnv();
    delete env.CORS_ORIGIN;
    const result = validateProductionEnvironment(env, true);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.integration === "TLS/CORS")).toBe(true);
  });

  it("fails when CORS_ORIGIN is not https:// (the TLS check)", () => {
    const env = { ...baseValidEnv(), CORS_ORIGIN: "http://www.igfxpro.com" };
    const result = validateProductionEnvironment(env, true);
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.integration === "TLS/CORS")?.message).toContain("https://");
  });

  it("fails when CORS_ORIGIN is a bare localhost dev URL", () => {
    const env = { ...baseValidEnv(), CORS_ORIGIN: "http://localhost:5173" };
    const result = validateProductionEnvironment(env, true);
    expect(result.ok).toBe(false);
  });
});

describe("validateProductionEnvironment() — Redis auth", () => {
  it("passes when REDIS_URL is not set at all (Redis is optional by design)", () => {
    const result = validateProductionEnvironment(baseValidEnv(), true);
    expect(result.ok).toBe(true);
  });

  it("fails when REDIS_URL is set with no embedded credentials and REDIS_PASSWORD is also unset", () => {
    const env = { ...baseValidEnv(), REDIS_URL: "redis://prod-redis-host:6379" };
    const result = validateProductionEnvironment(env, true);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.integration === "Redis")).toBe(true);
  });

  it("passes when REDIS_URL has embedded credentials", () => {
    const env = { ...baseValidEnv(), REDIS_URL: "redis://:supersecret@prod-redis-host:6379" };
    const result = validateProductionEnvironment(env, true);
    expect(result.ok).toBe(true);
  });

  it("passes when REDIS_URL has no embedded credentials but REDIS_PASSWORD is set separately", () => {
    const env = { ...baseValidEnv(), REDIS_URL: "redis://prod-redis-host:6379", REDIS_PASSWORD: "supersecret" };
    const result = validateProductionEnvironment(env, true);
    expect(result.ok).toBe(true);
  });
});

describe("validateProductionEnvironment() — optional integrations are all-or-nothing", () => {
  const cases: Array<{ integration: string; allVars: string[] }> = [
    { integration: "Sumsub", allVars: ["SUMSUB_APP_TOKEN", "SUMSUB_SECRET_KEY", "SUMSUB_WEBHOOK_SECRET"] },
    { integration: "Stripe", allVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] },
    { integration: "Nuvei", allVars: ["NUVEI_MERCHANT_ID", "NUVEI_MERCHANT_SITE", "NUVEI_SECRET_KEY"] },
    { integration: "Praxis", allVars: ["PRAXIS_MERCHANT_ID", "PRAXIS_APP_KEY", "PRAXIS_SECRET_KEY"] },
    { integration: "SMTP", allVars: ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"] },
    { integration: "AWS", allVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
  ];

  for (const { integration, allVars } of cases) {
    it(`${integration}: passes when NONE of its vars are set (a valid minimal launch)`, () => {
      const result = validateProductionEnvironment(baseValidEnv(), true);
      expect(result.ok).toBe(true);
      expect(result.issues.some((i) => i.integration === integration)).toBe(false);
    });

    it(`${integration}: passes when ALL of its vars are set`, () => {
      const env = { ...baseValidEnv() };
      for (const v of allVars) env[v] = "configured-value";
      const result = validateProductionEnvironment(env, true);
      expect(result.ok).toBe(true);
      expect(result.issues.some((i) => i.integration === integration)).toBe(false);
    });

    it(`${integration}: FAILS when only the first of its vars is set (partial configuration)`, () => {
      const env = { ...baseValidEnv(), [allVars[0]!]: "configured-value" };
      const result = validateProductionEnvironment(env, true);
      expect(result.ok).toBe(false);
      const issue = result.issues.find((i) => i.integration === integration);
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe("error");
    });

    it(`${integration}: FAILS when all but the last of its vars is set (partial configuration)`, () => {
      if (allVars.length < 2) return;
      const env = { ...baseValidEnv() };
      for (const v of allVars.slice(0, -1)) env[v] = "configured-value";
      const result = validateProductionEnvironment(env, true);
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.integration === integration)).toBe(true);
    });
  }

  it("Sumsub: SUMSUB_LEVEL_NAME is NOT part of the consistency check (has a working code-level default)", () => {
    const env = {
      ...baseValidEnv(),
      SUMSUB_APP_TOKEN: "token", SUMSUB_SECRET_KEY: "secret", SUMSUB_WEBHOOK_SECRET: "webhook-secret",
      // SUMSUB_LEVEL_NAME deliberately omitted
    };
    const result = validateProductionEnvironment(env, true);
    expect(result.ok).toBe(true);
  });
});

describe("validateProductionEnvironment() — informational-only warnings never block startup", () => {
  it("reports a warning (not an error) when neither Alertmanager credential is set, and stays ok:true", () => {
    const result = validateProductionEnvironment(baseValidEnv(), true);
    expect(result.ok).toBe(true);
    const warning = result.issues.find((i) => i.integration === "Alertmanager");
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");
  });

  it("reports a warning (not an error) when BACKUP_S3_BUCKET is not set, and stays ok:true", () => {
    const result = validateProductionEnvironment(baseValidEnv(), true);
    expect(result.ok).toBe(true);
    const warning = result.issues.find((i) => i.integration === "Backup");
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");
  });

  it("no Alertmanager warning when at least one delivery credential is configured", () => {
    const env = { ...baseValidEnv(), ALERTMANAGER_SLACK_WEBHOOK: "https://hooks.slack.com/..." };
    const result = validateProductionEnvironment(env, true);
    expect(result.issues.some((i) => i.integration === "Alertmanager")).toBe(false);
  });
});

describe("validateProductionEnvironment() — a genuinely fully-configured production environment passes clean", () => {
  it("ok:true with zero errors when every integration is fully (not partially) configured", () => {
    const env: EnvLike = {
      ...baseValidEnv(),
      REDIS_URL: "redis://:secret@prod-redis:6379",
      SUMSUB_APP_TOKEN: "t", SUMSUB_SECRET_KEY: "s", SUMSUB_WEBHOOK_SECRET: "w",
      STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh",
      NUVEI_MERCHANT_ID: "m", NUVEI_MERCHANT_SITE: "ms", NUVEI_SECRET_KEY: "sk2",
      PRAXIS_MERCHANT_ID: "pm", PRAXIS_APP_KEY: "pk", PRAXIS_SECRET_KEY: "ps",
      SMTP_HOST: "smtp.example.com", SMTP_USER: "u", SMTP_PASS: "p",
      AWS_ACCESS_KEY_ID: "ak", AWS_SECRET_ACCESS_KEY: "sak",
      ALERTMANAGER_SLACK_WEBHOOK: "https://hooks.slack.com/...",
      BACKUP_S3_BUCKET: "igfxpro-backups",
    };
    const result = validateProductionEnvironment(env, true);
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.issues.filter((i) => i.severity === "warning")).toEqual([]);
  });
});
