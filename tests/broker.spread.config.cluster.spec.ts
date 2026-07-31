/**
 * broker.spread.config.cluster.spec.ts
 *
 * RISK_ENGINE_FREEZE.md §5.2 — BrokerSpreadConfig's halt state (including
 * the per-symbol circuit breaker's automated setEnabled() calls) had no
 * cross-worker sync, unlike kill.switch.ts (Fix #6) and
 * global.risk.supervisor.ts, which both already use the shared control
 * channel for exactly this problem. A PM2/Docker-replica worker other than
 * the one that tripped a halt kept accepting new orders on that symbol, and
 * could still force-close an existing position against the halted price
 * (the exact FASE 4.2 Bug #3 scenario) if that worker never saw the halt.
 *
 * Proves BrokerSpreadConfig now (a) publishes its state on every update()/
 * setEnabled() via the shared control channel, and (b) a simulated update
 * arriving FROM another worker (via startSync()'s subscription callback)
 * updates isEnabled()/getSpread() immediately, exactly as if this worker
 * had made the change itself. Same test shape as kill.switch.cluster.spec.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockUpsert, mockPublish, mockSubscribe } = vi.hoisted(() => ({
  mockUpsert: vi.fn().mockResolvedValue({}),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockSubscribe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../shared/db.js", () => ({
  // PHASE2_REMEDIATION (H16): BrokerSpreadConfig.update() now also calls
  // immutableAudit.write(), which itself imports { prisma, IS_PERSISTENT }
  // from this same module and needs auditLog.create + $transaction to no
  // longer throw. This spec is about cross-worker propagation, not audit
  // content -- see broker.spread.config.update.audit.spec.ts for that.
  IS_PERSISTENT: true,
  prisma: {
    brokerSetting: { upsert: mockUpsert, findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([]),
    })),
  },
}));

let capturedHandler: ((payload: unknown) => void) | null = null;
vi.mock("../shared/control.channel.js", () => ({
  publishControlChannel: mockPublish,
  subscribeControlChannel: vi.fn(async (_name: string, handler: (payload: unknown) => void) => {
    capturedHandler = handler;
    mockSubscribe();
  }),
}));

const { BrokerSpreadConfig } = await import("../liquidity-engine/broker.spread.config.js");

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandler = null;
});

describe("BrokerSpreadConfig — cross-worker propagation (RISK_ENGINE_FREEZE.md §5.2)", () => {
  it("publishes the new state to the control channel on update()", async () => {
    const config = new BrokerSpreadConfig();
    await config.update("EURUSD", 0.0002, false, "admin-1");

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [channel, payload] = mockPublish.mock.calls[0]!;
    expect(channel).toBe("broker-spread");
    expect(payload).toMatchObject({ symbol: "EURUSD", enabled: false, updatedBy: "admin-1" });
  });

  it("publishes on setEnabled() too (the circuit breaker's own call path)", async () => {
    const config = new BrokerSpreadConfig();
    await config.setEnabled("EURUSD", false, "system:circuit-breaker");

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [, payload] = mockPublish.mock.calls[0]! as [string, { enabled: boolean; updatedBy: string }];
    expect(payload.enabled).toBe(false);
    expect(payload.updatedBy).toBe("system:circuit-breaker");
  });

  it("applies a halt that arrives from another worker via startSync() -- isEnabled() reflects it immediately", async () => {
    const config = new BrokerSpreadConfig();
    await config.startSync();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(capturedHandler).toBeTruthy();

    // Symbol is untouched locally -> defaults to enabled=true.
    expect(config.isEnabled("EURUSD")).toBe(true);

    // Simulate: a DIFFERENT worker's circuit breaker tripped and published a halt.
    capturedHandler!({
      symbol: "EURUSD", spread: 0.00013, enabled: false,
      updatedAt: new Date().toISOString(), updatedBy: "system:circuit-breaker",
    });

    // This worker never called setEnabled() itself, yet must now see the halt --
    // the exact gap that let a position be force-closed at a crashed price on
    // a worker that never observed the trip (FASE 4.2 Bug #3's scenario,
    // reintroduced at the cluster level without this sync).
    expect(config.isEnabled("EURUSD")).toBe(false);
  });

  it("a remote re-enable also propagates and preserves the synced spread", async () => {
    const config = new BrokerSpreadConfig();
    await config.startSync();

    capturedHandler!({ symbol: "GBPUSD", spread: 0.0005, enabled: false, updatedAt: new Date().toISOString(), updatedBy: "admin-1" });
    expect(config.isEnabled("GBPUSD")).toBe(false);

    capturedHandler!({ symbol: "GBPUSD", spread: 0.0005, enabled: true, updatedAt: new Date().toISOString(), updatedBy: "system:circuit-breaker" });
    expect(config.isEnabled("GBPUSD")).toBe(true);
    expect(config.getSpread("GBPUSD")).toBe(0.0005);
  });
});
