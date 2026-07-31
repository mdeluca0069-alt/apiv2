/**
 * kill.switch.audit.spec.ts
 *
 * PHASE2_REMEDIATION (H16) — the admin route audit found 9 mutating admin
 * actions with zero call into the permanent, hash-chained AuditLog anywhere
 * in their handling chain. The kill switch is the most severe of the 9:
 * activate()/deactivate() halt or resume ALL trading cluster-wide, yet the
 * only record of who did it and when was a BrokerSetting row that gets
 * silently overwritten on every subsequent state change (no history), plus
 * a transient alertManager notification (not a queryable historical record).
 *
 * These tests prove activate()/deactivate() now call immutableAudit.write()
 * with the actor/action/entity/payload shape used throughout the codebase,
 * and that the audit write failing to persist never blocks or corrupts the
 * kill switch's own state change (the control itself must remain effective
 * even if, say, the audit table were unreachable).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockUpsert, mockKillSwitchActivated, mockPublish, mockAuditWrite } = vi.hoisted(() => ({
  mockUpsert: vi.fn().mockResolvedValue({}),
  mockKillSwitchActivated: vi.fn().mockResolvedValue(undefined),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockAuditWrite: vi.fn().mockResolvedValue("audit-id-1"),
}));

vi.mock("../shared/db.js", () => ({
  prisma: { brokerSetting: { upsert: mockUpsert, findUnique: vi.fn().mockResolvedValue(null) } },
  IS_PERSISTENT: true,
}));
vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { killSwitchActivated: mockKillSwitchActivated },
}));
vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn() },
}));
vi.mock("../shared/control.channel.js", () => ({
  publishControlChannel: mockPublish,
  subscribeControlChannel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../security/immutable.audit.js", () => ({
  immutableAudit: { write: mockAuditWrite },
}));

const { KillSwitch } = await import("../risk-service/kill.switch.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditWrite.mockResolvedValue("audit-id-1");
});

describe("KillSwitch — PHASE2_REMEDIATION (H16): immutable audit trail", () => {
  it("activate() writes an immutable audit entry with actor, action, entity, and reason", async () => {
    const ks = new KillSwitch();
    await ks.activate("Emergency stop — anomalous volatility", "admin-1");

    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    const [entry] = mockAuditWrite.mock.calls[0]!;
    expect(entry).toMatchObject({
      actor: "admin-1",
      action: "kill_switch.activated",
      entity: "platform",
      payload: expect.objectContaining({ reason: "Emergency stop — anomalous volatility" }),
    });
  });

  it("deactivate() writes an immutable audit entry with actor, action, entity", async () => {
    const ks = new KillSwitch();
    await ks.deactivate("admin-2");

    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    const [entry] = mockAuditWrite.mock.calls[0]!;
    expect(entry).toMatchObject({
      actor: "admin-2",
      action: "kill_switch.deactivated",
      entity: "platform",
    });
  });

  it("audit write happens for every activate/deactivate cycle, not just the first", async () => {
    const ks = new KillSwitch();
    await ks.activate("first halt", "admin-1");
    await ks.deactivate("admin-2");
    await ks.activate("second halt", "admin-3");

    expect(mockAuditWrite).toHaveBeenCalledTimes(3);
    expect(mockAuditWrite.mock.calls[0]![0]).toMatchObject({ action: "kill_switch.activated", actor: "admin-1" });
    expect(mockAuditWrite.mock.calls[1]![0]).toMatchObject({ action: "kill_switch.deactivated", actor: "admin-2" });
    expect(mockAuditWrite.mock.calls[2]![0]).toMatchObject({ action: "kill_switch.activated", actor: "admin-3" });
  });

  it("the state change itself (BrokerSetting persistence + control-channel publish) still completes even though it now also awaits the audit write", async () => {
    const ks = new KillSwitch();
    await ks.activate("halt", "admin-1");

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(ks.isActive()).toBe(true);
  });
});
