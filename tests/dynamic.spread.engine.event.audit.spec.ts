/**
 * dynamic.spread.engine.event.audit.spec.ts
 *
 * PHASE2_REMEDIATION (H16) — the admin route audit found that
 * POST /admin/spread/event (DynamicSpreadEngine.addEvent()) had zero call
 * into the permanent, hash-chained AuditLog. A scheduled spread-widening
 * event affects every trader's effective spread on the named symbols for
 * the whole window.
 *
 * addEvent()'s new `actor` param is only supplied by the admin route --
 * this proves the write only happens when an actor is actually provided
 * (no internal/system caller of addEvent() currently exists).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("audit-id-1") }));
vi.mock("../security/immutable.audit.js", () => ({
  immutableAudit: { write: mockAuditWrite },
}));
vi.mock("../shared/db.js", () => ({ prisma: null, IS_PERSISTENT: false }));

const { DynamicSpreadEngine } = await import("../liquidity-engine/dynamic.spread.engine.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditWrite.mockResolvedValue("audit-id-1");
});

describe("DynamicSpreadEngine.addEvent() — PHASE2_REMEDIATION (H16): immutable audit trail", () => {
  it("writes an immutable audit entry when an actor is supplied (the admin route path)", async () => {
    const engine = new DynamicSpreadEngine();
    const ev = {
      name: "NFP", assetClasses: ["FX_MAJOR"], windowMinutes: 30,
      multiplier: 2.5, scheduledAt: new Date("2026-08-01T12:30:00.000Z"),
    };

    engine.addEvent(ev, "admin-1");
    await vi.waitFor(() => expect(mockAuditWrite).toHaveBeenCalledTimes(1));

    const [entry] = mockAuditWrite.mock.calls[0]!;
    expect(entry).toMatchObject({
      actor:  "admin-1",
      action: "spread.event_added",
      entity: "NFP",
      payload: expect.objectContaining({ multiplier: 2.5, windowMinutes: 30 }),
    });
  });

  it("does not write an audit entry when no actor is supplied (no admin trigger)", () => {
    const engine = new DynamicSpreadEngine();
    const ev = {
      // Relative to "now" (not a hardcoded absolute timestamp): getEvents()
      // filters out events whose scheduledAt + windowMinutes has already
      // passed (dynamic.spread.engine.ts:188) -- a fixed past-dated
      // fixture goes stale and starts failing the instant real wall-clock
      // time crosses it, regardless of this test's own logic.
      name: "CPI", assetClasses: ["ALL"], windowMinutes: 15,
      multiplier: 1.8, scheduledAt: new Date(Date.now() + 30 * 60_000),
    };

    engine.addEvent(ev);

    expect(mockAuditWrite).not.toHaveBeenCalled();
    expect(engine.getEvents().some((e) => e.name === "CPI")).toBe(true);
  });
});
