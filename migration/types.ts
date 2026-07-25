/**
 * migration/types.ts — shared types for the igfxpro-api (v1) -> igfxpro-apiv2
 * production-cutover ETL (PRODUCTION_CUTOVER_REPORT.md, Stage 2).
 */
import type { Pool as PgPool } from "pg";
import type { PrismaClient } from "@prisma/client";

/** Every domain migrator receives the same source/target handles. */
export type MigrationClients = {
  source: PgPool;
  target: PrismaClient;
};

export type RunMode = "dry-run" | "validate" | "apply";

export type RunOptions = {
  mode:      RunMode;
  domains?:  string[];   // subset of DOMAIN_ORDER names; defaults to all
  batchSize: number;
  /** Caps how many source rows a domain will process — 0 means unlimited. Intended for smoke-testing against a large source without a full run. */
  limit:     number;
};

export type ValidationIssue = {
  domain:  string;
  sourceId: string;
  severity: "ERROR" | "WARNING";
  message:  string;
};

/** One row of the rollback manifest — exactly enough to reverse a single write. */
export type RollbackEntry = {
  domain:    string;
  targetPk:  Record<string, string>; // e.g. {id: "..."} or {id: "...", createdAt: "..."} for composite keys
  action:    "CREATED" | "UPDATED";
  /** Only set for UPDATED rows -- the exact prior field values, so a rollback can restore them verbatim instead of just deleting. */
  previous?: Record<string, unknown>;
};

export type DomainStats = {
  domain:           string;
  sourceRowCount:   number;
  extracted:        number;
  transformFailed:  number;
  validationErrors: number;
  loaded:           number;
  skippedIdempotent: number; // already present in target with identical data -- upsert was a no-op
  failed:           number;
  durationMs:       number;
};

export type MigrationRunSummary = {
  runId:       string;
  mode:        RunMode;
  startedAt:   string;
  finishedAt:  string;
  domains:     DomainStats[];
  validationIssues: ValidationIssue[];
  rollbackManifestPath?: string;
};

/**
 * A domain migrator is intentionally data-shaped, not class-based: the
 * generic runner (etl.runner.ts) is the only place that knows HOW to
 * batch/upsert/record-rollback/validate -- each domain just describes WHAT
 * to extract and HOW to map one source row to one target upsert call.
 */
export type DomainMigrator<TSource = Record<string, unknown>, TTarget = Record<string, unknown>> = {
  /** Must match DOMAIN_ORDER's dependency order -- e.g. "users" before "wallets". */
  name: string;
  /** Raw SQL run once at the start to determine total row count (for stats/progress only). */
  countSql: string;
  /**
   * Raw, paginated SQL against the SOURCE (v1) database. Must be stable
   * under repeated calls with the same offset/limit (ORDER BY a real,
   * unique, monotonic column -- never rely on default row order).
   */
  extractSql: (offset: number, limit: number) => string;
  /** Pure transform: source row -> target row shape. May throw -- caught by the runner and counted as transformFailed. */
  transform: (row: TSource) => TTarget;
  /**
   * Structural validation beyond what transform() already guarantees --
   * e.g. FK targets that must already exist in the TARGET database (an
   * Order referencing a User not yet migrated). Return [] when clean.
   * Only consulted in "validate" and "apply" modes (dry-run skips DB
   * reads entirely, by design -- see etl.runner.ts).
   */
  validate: (row: TTarget, clients: MigrationClients) => Promise<ValidationIssue[]>;
  /**
   * Idempotent upsert against the TARGET (apiv2) database via Prisma.
   * Must key on the row's real, stable identity (never a generated ID)
   * so re-running the same source row twice never creates a duplicate.
   * Returns the target primary-key fields actually written, and whether
   * this call created a new row, updated an existing (different) one, or
   * was a no-op because target already matched (skippedIdempotent).
   */
  upsert: (row: TTarget, clients: MigrationClients) => Promise<{
    pk: Record<string, string>;
    outcome: "CREATED" | "UPDATED" | "UNCHANGED";
    previous?: Record<string, unknown>;
  }>;
};
