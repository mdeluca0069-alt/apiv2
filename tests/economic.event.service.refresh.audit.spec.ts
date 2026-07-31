/**
 * economic.event.service.refresh.audit.spec.ts
 *
 * PHASE2_REMEDIATION (H16) — the admin route audit found that
 * POST /admin/olos/calendar/refresh (EconomicEventService.refresh()) had
 * zero call into the permanent, hash-chained AuditLog.
 *
 * refresh()'s new `actor` param is only supplied by the admin route --
 * main.ts's startup call and its own periodic scheduled call both omit it,
 * so only the manual admin trigger is written to the permanent audit trail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockUpsert, mockFindMany } = vi.hoisted(() => ({
  mockUpsert: vi.fn().mockResolvedValue({}),
  mockFindMany: vi.fn().mockResolvedValue([]),
}));
vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: { economicEvent: { upsert: mockUpsert, findMany: mockFindMany } },
}));

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("audit-id-1") }));
vi.mock("../security/immutable.audit.js", () => ({
  immutableAudit: { write: mockAuditWrite },
}));

vi.mock("../economic-calendar/economic.event.fetcher.js", () => ({
  fetchForexFactory:      vi.fn().mockResolvedValue([]),
  fetchTradingEconomics:  vi.fn().mockResolvedValue([]),
  fetchFRED:              vi.fn().mockResolvedValue([]),
}));

const { economicEventService } = await import("../economic-calendar/economic.event.service.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsert.mockResolvedValue({});
  mockFindMany.mockResolvedValue([]);
  mockAuditWrite.mockResolvedValue("audit-id-1");
});

describe("EconomicEventService.refresh() — PHASE2_REMEDIATION (H16): immutable audit trail", () => {
  it("writes an immutable audit entry when an actor is supplied (the admin route path)", async () => {
    await economicEventService.refresh("admin-1");

    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    const [entry] = mockAuditWrite.mock.calls[0]!;
    expect(entry).toMatchObject({
      actor:  "admin-1",
      action: "olos.calendar_refresh_triggered",
      entity: "platform",
    });
  });

  it("does not write an audit entry when no actor is supplied (startup/scheduled calls)", async () => {
    await economicEventService.refresh();

    expect(mockAuditWrite).not.toHaveBeenCalled();
  });
});
