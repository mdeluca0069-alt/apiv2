/**
 * kill.switch.cluster.spec.ts
 *
 * Milestone 1 / Fix #6 — the kill switch and global risk supervisor used to
 * be per-process in-memory caches with no cross-worker propagation: an
 * admin's emergency stop only took effect on the one worker that handled
 * the HTTP request. Proves KillSwitch now (a) publishes its state on every
 * activate()/deactivate() via the shared control channel, and (b) a
 * simulated update arriving FROM another worker (via startSync()'s
 * subscription callback) updates isActive()/getState() immediately, exactly
 * as if this worker had made the change itself.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockUpsert, mockKillSwitchActivated, mockPublish, mockSubscribe } = vi.hoisted(() => ({
  mockUpsert: vi.fn().mockResolvedValue({}),
  mockKillSwitchActivated: vi.fn().mockResolvedValue(undefined),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockSubscribe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../shared/db.js", () => ({
  prisma: { brokerSetting: { upsert: mockUpsert, findUnique: vi.fn().mockResolvedValue(null) } },
}));
vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { killSwitchActivated: mockKillSwitchActivated },
}));
vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn() },
}));

// Captures the handler startSync() registers, so the test can simulate an
// update arriving from another worker without touching real Redis.
let capturedHandler: ((payload: unknown) => void) | null = null;
vi.mock("../shared/control.channel.js", () => ({
  publishControlChannel: mockPublish,
  subscribeControlChannel: vi.fn(async (_name: string, handler: (payload: unknown) => void) => {
    capturedHandler = handler;
    mockSubscribe();
  }),
}));

const { KillSwitch } = await import("../risk-service/kill.switch.js");

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandler = null;
});

describe("KillSwitch — cross-worker propagation", () => {
  it("publishes the new state to the control channel on activate()", async () => {
    const ks = new KillSwitch();
    await ks.activate("Emergency stop", "admin-1");

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [channel, payload] = mockPublish.mock.calls[0]!;
    expect(channel).toBe("kill-switch");
    expect(payload).toMatchObject({ active: true, activatedBy: "admin-1" });
  });

  it("publishes on deactivate() too", async () => {
    const ks = new KillSwitch();
    await ks.activate("x", "admin-1");
    mockPublish.mockClear();

    await ks.deactivate("admin-2");
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [, payload] = mockPublish.mock.calls[0]!;
    expect(payload).toMatchObject({ active: false });
  });

  it("applies a state update that arrives from another worker via startSync()", async () => {
    // Note: KillSwitch's cache is module-scoped (matches the real singleton
    // pattern — there is truly only one kill switch per process), so we
    // don't assert on the pre-existing state here, only on the change this
    // test itself causes via the simulated remote message.
    const ks = new KillSwitch();
    await ks.startSync();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(capturedHandler).toBeTruthy();

    // Simulate: a DIFFERENT worker activated the kill switch and published it.
    capturedHandler!({ active: true, reason: "Remote worker activated this", activatedBy: "admin-3", activatedAt: new Date().toISOString() });

    // This worker never called activate() itself, yet must now report active.
    expect(ks.isActive()).toBe(true);
    expect(ks.getState().activatedBy).toBe("admin-3");
  });

  it("a remote deactivate() also propagates", async () => {
    const ks = new KillSwitch();
    await ks.activate("local activation", "admin-1");
    expect(ks.isActive()).toBe(true);

    await ks.startSync();
    capturedHandler!({ active: false, reason: "Deactivated remotely" });

    expect(ks.isActive()).toBe(false);
  });
});
