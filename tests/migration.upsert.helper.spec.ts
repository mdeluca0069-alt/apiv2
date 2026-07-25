/**
 * migration.upsert.helper.spec.ts
 *
 * PRODUCTION CUTOVER Stage 2 — proves the ETL's idempotency primitive:
 * diffFields()/upsertWithDiff() correctly distinguish CREATED (no existing
 * row) from UPDATED (existing row, at least one field actually differs)
 * from UNCHANGED (existing row, every field identical -- must be a true
 * no-op, zero writes). This is what makes re-running the whole migration
 * against unchanged source data cheap and safe instead of re-issuing a
 * write for every single row every time.
 */
import { describe, it, expect, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { diffFields, upsertWithDiff } from "../migration/upsert.helper.js";

describe("diffFields()", () => {
  it("reports changed=true with previous={} when there is no existing row (CREATE case)", () => {
    const result = diffFields(null, { a: 1, b: "x" });
    expect(result.changed).toBe(true);
    expect(result.previous).toEqual({});
  });

  it("reports changed=false when every field in `next` matches `existing`", () => {
    const result = diffFields({ a: 1, b: "x", extraTargetOnlyField: "ignored" }, { a: 1, b: "x" });
    expect(result.changed).toBe(false);
  });

  it("reports changed=true and captures only the differing field's prior value", () => {
    const result = diffFields({ a: 1, b: "old" }, { a: 1, b: "new" });
    expect(result.changed).toBe(true);
    expect(result.previous).toEqual({ b: "old" });
  });

  it("treats a target-only field absent from `next` as irrelevant -- never flags it as changed", () => {
    // e.g. Notification.sourceOutboxId / OutboxEvent.auditProcessed --
    // apiv2-only idempotency fields a v1-sourced row never sets.
    const result = diffFields({ a: 1, sourceOutboxId: "target-only-idempotency-key" }, { a: 1 });
    expect(result.changed).toBe(false);
  });

  it("compares Date objects by their ISO value, not by reference", () => {
    const d1 = new Date("2026-07-25T10:00:00.000Z");
    const d2 = new Date("2026-07-25T10:00:00.000Z"); // different object, same instant
    const result = diffFields({ createdAt: d1 }, { createdAt: d2 });
    expect(result.changed).toBe(false);
  });

  it("detects a real Date difference", () => {
    const result = diffFields(
      { closedAt: new Date("2026-07-25T10:00:00.000Z") },
      { closedAt: new Date("2026-07-25T11:00:00.000Z") },
    );
    expect(result.changed).toBe(true);
  });

  it("compares real Prisma Decimal instances (own toString(), not a plain object/array) by their string value", () => {
    // A plain object literal with a hand-rolled toString() is NOT a
    // faithful stand-in here -- its constructor is literally `Object`,
    // which normalize()'s own guard deliberately excludes (to avoid
    // treating an arbitrary plain object as a scalar). Only a REAL Decimal
    // instance (constructor name is a minified `"i"` from decimal.js, at
    // least in this Prisma version -- confirmed by direct inspection, not
    // assumed) exercises the branch this test claims to cover; a fake
    // plain-object stand-in silently fell through to a different code path
    // and let this test pass without ever touching the Decimal branch.
    const result = diffFields({ balance: new Decimal("100.00000000") }, { balance: new Decimal("100.00000000") });
    expect(result.changed).toBe(false);
  });

  it("treats a Decimal without trailing zeros as equal to the same value WITH trailing zeros -- the live-testing bug", () => {
    // Prisma's real Decimal.toString() drops trailing zeros ("15000.5"),
    // while this ETL's extractSql queries cast via Postgres `numeric::text`
    // which preserves the column's full scale ("15000.50000000"). Both
    // represent the identical value -- a naive string compare previously
    // flagged this as "changed" on every single re-run of the migration.
    const result = diffFields(
      { balance: new Decimal("15000.5") },          // what Prisma's findUnique() actually returns
      { balance: "15000.50000000" },                 // what this ETL's raw pg extraction actually returns
    );
    expect(result.changed).toBe(false);
  });

  it("still detects a REAL numeric difference regardless of trailing-zero formatting on either side", () => {
    const result = diffFields({ balance: new Decimal("15000.5") }, { balance: "15001.00000000" });
    expect(result.changed).toBe(true);
  });

  it("does not misinterpret a non-numeric string as numeric (ids/references are compared as plain strings)", () => {
    const result = diffFields({ reference: "ref-001" }, { reference: "ref-001" });
    expect(result.changed).toBe(false);
    const result2 = diffFields({ reference: "ref-001" }, { reference: "ref-002" });
    expect(result2.changed).toBe(true);
  });

  it("treats null and undefined as equivalent to each other but distinct from a real value", () => {
    expect(diffFields({ reviewedBy: null }, { reviewedBy: undefined }).changed).toBe(false);
    expect(diffFields({ reviewedBy: null }, { reviewedBy: "admin-1" }).changed).toBe(true);
  });
});

describe("upsertWithDiff()", () => {
  it("calls create() and reports CREATED when find() returns null", async () => {
    const find   = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue({});
    const update = vi.fn();

    const result = await upsertWithDiff(find, create, update, { a: 1 });

    expect(result.outcome).toBe("CREATED");
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("calls update() and reports UPDATED with the prior value when a field actually differs", async () => {
    const find   = vi.fn().mockResolvedValue({ a: 1, b: "old" });
    const create = vi.fn();
    const update = vi.fn().mockResolvedValue({});

    const result = await upsertWithDiff(find, create, update, { a: 1, b: "new" });

    expect(result.outcome).toBe("UPDATED");
    expect(result.previous).toEqual({ b: "old" });
    expect(update).toHaveBeenCalledWith({ b: "old" });
    expect(create).not.toHaveBeenCalled();
  });

  it("calls neither create() nor update() and reports UNCHANGED when the row already matches -- the idempotency guarantee", async () => {
    const find   = vi.fn().mockResolvedValue({ a: 1, b: "same" });
    const create = vi.fn();
    const update = vi.fn();

    const result = await upsertWithDiff(find, create, update, { a: 1, b: "same" });

    expect(result.outcome).toBe("UNCHANGED");
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
