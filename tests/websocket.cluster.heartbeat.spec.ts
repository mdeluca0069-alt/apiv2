/**
 * websocket.cluster.heartbeat.spec.ts
 *
 * PHASE2_REMEDIATION (H9): the node-registry heartbeat had two distinct,
 * silent failure modes:
 *
 *   1. _heartbeat() called redis.expire() (extend-TTL-if-exists) instead of
 *      rewriting the key. EXPIRE on a key that's already gone server-side
 *      (e.g. after a Redis outage >= NODE_TTL_SECONDS) returns 0, throws
 *      nothing, and the old bare `catch {}` never engaged -- the interval
 *      kept "succeeding" forever against a key that was never coming back,
 *      permanently dropping this node out of getClusterStats()/
 *      findUserNode() routing even once Redis and the process were both
 *      healthy again.
 *   2. register()'s heartbeat timer was only created AFTER the initial
 *      setex calls succeeded. A transient failure during boot meant
 *      heartbeatTimer was never created at all -- the node ran its entire
 *      lifetime never having joined the cluster, with no retry.
 *
 * Fix: _heartbeat() now unconditionally re-writes (setex) both keys every
 * tick (self-healing -- recreates the key if it's missing, refreshes it if
 * it's present), and register() starts the heartbeat timer regardless of
 * whether the initial write succeeded, so a boot-time Redis blip is
 * recovered from on the very next tick instead of never.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../realtime-infra/redis.pubsub.js", () => ({ WORKER_ID: "test-node-1" }));

const mockRedis = {
  setex:  vi.fn(),
  expire: vi.fn(),
  del:    vi.fn(),
  get:    vi.fn(),
  mget:   vi.fn(),
  scan:   vi.fn(),
};

vi.mock("../shared/redis.js", () => ({ getRedis: vi.fn(() => mockRedis) }));

const { wsCluster } = await import("../realtime-infra/websocket.cluster.js");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockRedis.setex.mockResolvedValue("OK");
  mockRedis.expire.mockResolvedValue(1);
  mockRedis.del.mockResolvedValue(1);
});

afterEach(async () => {
  await wsCluster.deregister();
  vi.useRealTimers();
});

describe("WsClusterManager — PHASE2_REMEDIATION (H9): self-healing heartbeat", () => {
  it("heartbeat renewal calls setex (rewrite), never expire (extend-only)", async () => {
    await wsCluster.register();
    mockRedis.setex.mockClear();

    await vi.advanceTimersByTimeAsync(10_000); // one HEARTBEAT_INTERVAL_MS tick

    expect(mockRedis.setex).toHaveBeenCalled();
    expect(mockRedis.expire).not.toHaveBeenCalled();
    const nodeKeyCall = mockRedis.setex.mock.calls.find((c) => (c[0] as string).includes("igfx:cluster:node:"));
    expect(nodeKeyCall?.[1]).toBe(25); // NODE_TTL_SECONDS
  });

  it("self-heals: a heartbeat tick recreates the node key even after it was already gone server-side", async () => {
    await wsCluster.register();
    // Simulate the node key having expired server-side between ticks --
    // under the OLD expire()-based implementation this would be a
    // permanent, silent no-op; setex() must recreate it unconditionally.
    mockRedis.setex.mockClear();

    await vi.advanceTimersByTimeAsync(10_000);

    const nodeKeyCall = mockRedis.setex.mock.calls.find((c) => (c[0] as string).includes("igfx:cluster:node:"));
    expect(nodeKeyCall).toBeDefined();
    const written = JSON.parse(nodeKeyCall![2] as string);
    expect(written.nodeId).toBe("test-node-1");
  });

  it("logs a warning (not a silent swallow) when a heartbeat write fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await wsCluster.register();
    mockRedis.setex.mockRejectedValueOnce(new Error("ECONNRESET"));

    await vi.advanceTimersByTimeAsync(10_000);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("heartbeat renewal failed"),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it("starts the heartbeat timer even when the INITIAL registration write fails, and recovers on the next tick", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRedis.setex.mockRejectedValueOnce(new Error("boot-time Redis blip"));
    mockRedis.setex.mockRejectedValueOnce(new Error("boot-time Redis blip"));

    await wsCluster.register(); // both initial writes fail

    // Old bug: heartbeatTimer was only created inside the try after these
    // writes succeeded -- a boot failure meant it was NEVER created, so
    // advancing time would produce zero further writes, forever.
    mockRedis.setex.mockClear();
    mockRedis.setex.mockResolvedValue("OK"); // Redis has recovered

    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockRedis.setex).toHaveBeenCalled(); // the node rejoined on its own
    warnSpy.mockRestore();
  });

  it("deregister() clears the heartbeat timer so no further writes occur", async () => {
    await wsCluster.register();
    await wsCluster.deregister();
    mockRedis.setex.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockRedis.setex).not.toHaveBeenCalled();
  });
});
