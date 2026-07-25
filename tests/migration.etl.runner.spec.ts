/**
 * migration.etl.runner.spec.ts
 *
 * PRODUCTION CUTOVER Stage 2 — proves the ETL runner's three-mode control
 * flow against a single fake domain (not the real 10 -- those are
 * integration-tested end-to-end in migration.etl.live.spec.ts against real
 * local Postgres databases; this file isolates the ORCHESTRATION logic
 * itself: batching, mode gating, error handling, and rollback-manifest
 * generation).
 *
 * DOMAIN_ORDER is mocked to a single controllable fake domain so this test
 * doesn't depend on any real schema/table.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DomainMigrator } from "../migration/types.js";

// The rollback manifest write is a real filesystem side effect
// (writeFile/mkdir) that this orchestration-logic test has no reason to
// perform for real -- mocked so the test suite never leaves files behind
// under migration/runs/ and stays fast/hermetic.
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir     = vi.fn().mockResolvedValue(undefined);
vi.mock("node:fs/promises", () => ({ writeFile: mockWriteFile, mkdir: mockMkdir }));

type FakeSource = { id: string; value: string };

const mockTransform = vi.fn((row: FakeSource) => ({ id: row.id, value: row.value }));
const mockValidate   = vi.fn().mockResolvedValue([]);
const mockUpsert     = vi.fn().mockResolvedValue({ pk: { id: "x" }, outcome: "CREATED" });

const fakeDomain: DomainMigrator<FakeSource, { id: string; value: string }> = {
  name: "fake",
  countSql: "SELECT count(*)",
  extractSql: (offset, limit) => `SELECT * OFFSET ${offset} LIMIT ${limit}`,
  transform: mockTransform,
  validate: mockValidate,
  upsert: mockUpsert,
};

vi.mock("../migration/domains/index.js", () => ({ DOMAIN_ORDER: [fakeDomain] }));

const { runMigration } = await import("../migration/etl.runner.js");

function makeSourceRows(n: number): FakeSource[] {
  return Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, value: `v${i}` }));
}

function mockSourceClient(rows: FakeSource[]) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("count(*)")) return { rows: [{ count: rows.length }] };
      // Parse the fake OFFSET/LIMIT the extractSql template produces.
      const offsetMatch = /OFFSET (\d+)/.exec(sql);
      const limitMatch  = /LIMIT (\d+)/.exec(sql);
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
      const limit  = limitMatch ? Number(limitMatch[1]) : rows.length;
      return { rows: rows.slice(offset, offset + limit) };
    }),
  };
}

const mockTarget = {} as never; // never actually dereferenced -- the fake domain's validate/upsert are mocked directly

beforeEach(() => {
  vi.clearAllMocks();
  mockTransform.mockImplementation((row: FakeSource) => ({ id: row.id, value: row.value }));
  mockValidate.mockResolvedValue([]);
  mockUpsert.mockResolvedValue({ pk: { id: "x" }, outcome: "CREATED" });
});

describe("runMigration() — dry-run mode", () => {
  it("extracts and transforms every row but never calls validate() or upsert()", async () => {
    const source = mockSourceClient(makeSourceRows(5));

    const summary = await runMigration({ source: source as never, target: mockTarget },
      { mode: "dry-run", batchSize: 10, limit: 0 });

    expect(summary.domains[0].sourceRowCount).toBe(5);
    expect(summary.domains[0].extracted).toBe(5);
    expect(summary.domains[0].loaded).toBe(0);
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(summary.rollbackManifestPath).toBeUndefined();
  });

  it("counts a transform() throw as transformFailed and records a validation issue, without stopping the batch", async () => {
    const source = mockSourceClient(makeSourceRows(3));
    mockTransform.mockImplementation((row: FakeSource) => {
      if (row.id === "row-1") throw new Error("bad row");
      return { id: row.id, value: row.value };
    });

    const summary = await runMigration({ source: source as never, target: mockTarget },
      { mode: "dry-run", batchSize: 10, limit: 0 });

    expect(summary.domains[0].extracted).toBe(2);
    expect(summary.domains[0].transformFailed).toBe(1);
    expect(summary.validationIssues).toHaveLength(1);
    expect(summary.validationIssues[0].message).toContain("bad row");
  });
});

describe("runMigration() — validate mode", () => {
  it("calls validate() for every extracted row but never calls upsert()", async () => {
    const source = mockSourceClient(makeSourceRows(4));

    const summary = await runMigration({ source: source as never, target: mockTarget },
      { mode: "validate", batchSize: 10, limit: 0 });

    expect(mockValidate).toHaveBeenCalledTimes(4);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(summary.domains[0].loaded).toBe(0);
  });

  it("counts an ERROR-severity validation issue and excludes that row from being loadable, but a WARNING does not block it", async () => {
    const source = mockSourceClient(makeSourceRows(2));
    mockValidate.mockImplementation(async (row: { id: string }) =>
      row.id === "row-0"
        ? [{ domain: "fake", sourceId: row.id, severity: "ERROR" as const, message: "blocking" }]
        : [{ domain: "fake", sourceId: row.id, severity: "WARNING" as const, message: "just a heads up" }],
    );

    const summary = await runMigration({ source: source as never, target: mockTarget },
      { mode: "validate", batchSize: 10, limit: 0 });

    expect(summary.domains[0].validationErrors).toBe(1);
    expect(summary.validationIssues).toHaveLength(2);
  });
});

describe("runMigration() — apply mode", () => {
  it("calls upsert() only for rows with no blocking ERROR, and writes a rollback manifest for every CREATED/UPDATED row", async () => {
    const source = mockSourceClient(makeSourceRows(3));
    mockValidate.mockImplementation(async (row: { id: string }) =>
      row.id === "row-1" ? [{ domain: "fake", sourceId: row.id, severity: "ERROR" as const, message: "skip me" }] : []);

    const summary = await runMigration({ source: source as never, target: mockTarget },
      { mode: "apply", batchSize: 10, limit: 0 });

    expect(mockUpsert).toHaveBeenCalledTimes(2); // row-0 and row-2 only
    expect(summary.domains[0].loaded).toBe(2);
    expect(summary.domains[0].validationErrors).toBe(1);
    expect(summary.rollbackManifestPath).toBeDefined();
  });

  it("reports UNCHANGED rows as skippedIdempotent, not loaded, and does not add them to the rollback manifest", async () => {
    const source = mockSourceClient(makeSourceRows(2));
    mockUpsert.mockResolvedValue({ pk: { id: "x" }, outcome: "UNCHANGED" });

    const summary = await runMigration({ source: source as never, target: mockTarget },
      { mode: "apply", batchSize: 10, limit: 0 });

    expect(summary.domains[0].loaded).toBe(0);
    expect(summary.domains[0].skippedIdempotent).toBe(2);
    // Nothing was ever CREATED/UPDATED, so no manifest is written at all.
    expect(summary.rollbackManifestPath).toBeUndefined();
  });

  it("counts an upsert() throw as failed without aborting the rest of the batch", async () => {
    const source = mockSourceClient(makeSourceRows(3));
    mockUpsert.mockImplementation(async (row: { id: string }) => {
      if (row.id === "row-1") throw new Error("DB write failed");
      return { pk: { id: row.id }, outcome: "CREATED" as const };
    });

    const summary = await runMigration({ source: source as never, target: mockTarget },
      { mode: "apply", batchSize: 10, limit: 0 });

    expect(summary.domains[0].loaded).toBe(2);
    expect(summary.domains[0].failed).toBe(1);
    expect(summary.validationIssues.some((i) => i.message.includes("DB write failed"))).toBe(true);
  });

  it("respects a --limit smaller than the total source row count", async () => {
    const source = mockSourceClient(makeSourceRows(10));

    const summary = await runMigration({ source: source as never, target: mockTarget },
      { mode: "apply", batchSize: 3, limit: 4 });

    expect(summary.domains[0].sourceRowCount).toBe(10); // the real total, for visibility
    expect(summary.domains[0].extracted).toBe(4);       // but only `limit` rows actually processed
    expect(mockUpsert).toHaveBeenCalledTimes(4);
  });

  it("batches extraction according to batchSize (multiple extractSql calls, not one giant page)", async () => {
    const source = mockSourceClient(makeSourceRows(10));

    await runMigration({ source: source as never, target: mockTarget },
      { mode: "apply", batchSize: 4, limit: 0 });

    // 1 count query + ceil(10/4) = 3 paginated extract queries.
    expect(source.query).toHaveBeenCalledTimes(4);
  });
});
