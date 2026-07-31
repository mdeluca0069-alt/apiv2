/**
 * broker.spread.config.update.audit.spec.ts
 *
 * PHASE2_REMEDIATION (H16) — the admin route audit found that
 * POST /admin/broker/spread (BrokerSpreadConfig.update(), the admin-facing
 * entry point) had zero call into the permanent, hash-chained AuditLog.
 * This control sets client-facing pricing for a symbol on every trade —
 * only the mutable BrokerSetting row (overwritten on each change) and a
 * console.log recorded who changed it.
 *
 * setEnabled() (see broker.spread.config.setEnabled.spec.ts) forwards into
 * this same update() method, so its automated circuit-breaker callers also
 * get an audit entry, attributed to their own "system:circuit-breaker"
 * actor -- a wider net than the admin gap alone, not excluded here.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockAuditWrite, mockUpsert } = vi.hoisted(() => ({
  mockAuditWrite: vi.fn().mockResolvedValue("audit-id-1"),
  mockUpsert: vi.fn().mockResolvedValue({}),
}));

vi.mock("../shared/db.js", () => ({
  prisma: { brokerSetting: { upsert: mockUpsert } },
  IS_PERSISTENT: true,
}));
vi.mock("../security/immutable.audit.js", () => ({
  immutableAudit: { write: mockAuditWrite },
}));
vi.mock("../shared/control.channel.js", () => ({
  publishControlChannel: vi.fn().mockResolvedValue(undefined),
  subscribeControlChannel: vi.fn().mockResolvedValue(undefined),
}));

const { BrokerSpreadConfig } = await import("../liquidity-engine/broker.spread.config.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditWrite.mockResolvedValue("audit-id-1");
  mockUpsert.mockResolvedValue({});
});

describe("BrokerSpreadConfig.update() — PHASE2_REMEDIATION (H16): immutable audit trail", () => {
  it("writes an immutable audit entry with actor, action, entity, and the new spread/enabled state", async () => {
    const config = new BrokerSpreadConfig();

    await config.update("EURUSD", 0.0004, true, "admin-1");

    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    const [entry] = mockAuditWrite.mock.calls[0]!;
    expect(entry).toMatchObject({
      actor:  "admin-1",
      action: "broker.spread_updated",
      entity: "EURUSD",
      payload: { spread: 0.0004, enabled: true },
    });
  });

  it("audits every update call, attributing each to its own actor", async () => {
    const config = new BrokerSpreadConfig();

    await config.update("EURUSD", 0.0004, true, "admin-1");
    await config.update("GBPUSD", 0.0006, false, "admin-2");

    expect(mockAuditWrite).toHaveBeenCalledTimes(2);
    expect(mockAuditWrite.mock.calls[0]![0]).toMatchObject({ entity: "EURUSD", actor: "admin-1" });
    expect(mockAuditWrite.mock.calls[1]![0]).toMatchObject({ entity: "GBPUSD", actor: "admin-2" });
  });

  it("still returns the updated entry even though it now also awaits the audit write", async () => {
    const config = new BrokerSpreadConfig();

    const entry = await config.update("EURUSD", 0.0004, true, "admin-1");

    expect(entry).toMatchObject({ symbol: "EURUSD", spread: 0.0004, enabled: true, updatedBy: "admin-1" });
  });
});
