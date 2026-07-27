/**
 * redis.pubsub.tick.relay.spec.ts
 *
 * MARKET_DATA_FREEZE.md §0.10 — quoteCache/InternalLiquidityCore are
 * per-process singletons with no cross-node sync. In a horizontally
 * scaled deployment, a client's WS connection pinned to one worker and an
 * order routed to another could read genuinely different quoteCache
 * contents. Extends the existing RedisPubSub relay (already used for
 * cross-node WS event delivery, igfx:ws:user/igfx:ws:broadcast) with a
 * third channel, igfx:market:tick, so every worker's own local feed ticks
 * reach every other worker.
 *
 * Proves: publishTick() sends a correctly-shaped envelope on the tick
 * channel; the onTickEvent callback fires with the right arguments when a
 * message arrives from ANOTHER worker; a message tagged with THIS
 * worker's own id is skipped (echo prevention, same mechanism already
 * proven for the WS channels); malformed JSON on the tick channel is
 * ignored, not thrown; and Redis being unavailable makes publishTick() a
 * safe no-op (graceful degradation, matching every other method on this
 * class).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSubscriberOn  = vi.fn();
const mockSubscriberConnect = vi.fn().mockResolvedValue(undefined);
const mockSubscribe     = vi.fn().mockResolvedValue(undefined);
const mockSubscriberQuit = vi.fn().mockResolvedValue(undefined);
const mockPublish       = vi.fn().mockResolvedValue(1);

const mockSubscriberClient = {
  on:        mockSubscriberOn,
  connect:   mockSubscriberConnect,
  subscribe: mockSubscribe,
  quit:      mockSubscriberQuit,
};

const mockRedis = {
  duplicate: vi.fn(() => mockSubscriberClient),
  publish:   mockPublish,
};

const { mockGetRedis } = vi.hoisted(() => ({ mockGetRedis: vi.fn() }));
vi.mock("../shared/redis.js", () => ({ getRedis: mockGetRedis }));

const { RedisPubSub } = await import("../realtime-infra/redis.pubsub.js");

/** Finds the "message" handler registered via subscriber.on("message", cb). */
function getMessageHandler(): (channel: string, raw: string) => void {
  const call = mockSubscriberOn.mock.calls.find((c) => c[0] === "message");
  if (!call) throw new Error("no 'message' handler was registered");
  return call[1] as (channel: string, raw: string) => void;
}

describe("RedisPubSub — market tick relay (MARKET_DATA_FREEZE.md §0.10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedis.mockReturnValue(mockRedis);
    mockSubscriberConnect.mockResolvedValue(undefined);
    mockSubscribe.mockResolvedValue(undefined);
    mockPublish.mockResolvedValue(1);
  });

  it("subscribes to the tick channel alongside the existing WS channels", async () => {
    const pubsub = new RedisPubSub();
    await pubsub.start(vi.fn(), vi.fn(), vi.fn());

    expect(mockSubscribe).toHaveBeenCalledWith("igfx:ws:user", "igfx:ws:broadcast", "igfx:market:tick");
  });

  it("connects the duplicated subscriber before subscribing -- PRODUCTION CUTOVER Stage 3 regression guard: duplicate() inherits lazyConnect:true from the base client, so subscribe() must not be called before an explicit connect() resolves, or it fails immediately with enableOfflineQueue false", async () => {
    const pubsub = new RedisPubSub();
    await pubsub.start(vi.fn(), vi.fn(), vi.fn());

    expect(mockSubscriberConnect).toHaveBeenCalledTimes(1);
    const connectOrder   = mockSubscriberConnect.mock.invocationCallOrder[0];
    const subscribeOrder = mockSubscribe.mock.invocationCallOrder[0];
    expect(connectOrder).toBeLessThan(subscribeOrder);
  });

  it("publishTick() sends a correctly-shaped envelope on the tick channel", async () => {
    const pubsub = new RedisPubSub();
    await pubsub.start(vi.fn(), vi.fn(), vi.fn());

    await pubsub.publishTick("EURUSD", 1.1000, 1.0999, 1.1001);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [channel, raw] = mockPublish.mock.calls[0]!;
    expect(channel).toBe("igfx:market:tick");
    const envelope = JSON.parse(raw as string);
    expect(envelope).toMatchObject({ symbol: "EURUSD", mid: 1.1000, bid: 1.0999, ask: 1.1001 });
    expect(typeof envelope.workerId).toBe("string");
  });

  it("fires onTickEvent when a tick arrives from another worker", async () => {
    const onTickEvent = vi.fn();
    const pubsub = new RedisPubSub();
    await pubsub.start(vi.fn(), vi.fn(), onTickEvent);

    const handler = getMessageHandler();
    handler("igfx:market:tick", JSON.stringify({
      workerId: "other-worker-id", symbol: "EURUSD", mid: 1.1050, bid: 1.1049, ask: 1.1051,
    }));

    expect(onTickEvent).toHaveBeenCalledWith("EURUSD", 1.1050, 1.1049, 1.1051);
  });

  it("skips a tick tagged with this worker's own id (echo prevention)", async () => {
    const onTickEvent = vi.fn();
    const pubsub = new RedisPubSub();
    await pubsub.start(vi.fn(), vi.fn(), onTickEvent);

    // Publish first to learn this instance's own workerId from the envelope it sends.
    await pubsub.publishTick("EURUSD", 1.1000);
    const ownEnvelope = JSON.parse(mockPublish.mock.calls[0]![1] as string);

    const handler = getMessageHandler();
    handler("igfx:market:tick", JSON.stringify({
      workerId: ownEnvelope.workerId, symbol: "EURUSD", mid: 1.2000,
    }));

    expect(onTickEvent).not.toHaveBeenCalled();
  });

  it("ignores malformed JSON on the tick channel instead of throwing", async () => {
    const onTickEvent = vi.fn();
    const pubsub = new RedisPubSub();
    await pubsub.start(vi.fn(), vi.fn(), onTickEvent);

    const handler = getMessageHandler();
    expect(() => handler("igfx:market:tick", "{not valid json")).not.toThrow();
    expect(onTickEvent).not.toHaveBeenCalled();
  });

  it("publishTick() is a safe no-op when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValue(null);
    const pubsub = new RedisPubSub();

    await expect(pubsub.publishTick("EURUSD", 1.1000)).resolves.toBeUndefined();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("does not route a WS-channel message to onTickEvent, and vice versa", async () => {
    const onUserEvent = vi.fn();
    const onTickEvent = vi.fn();
    const pubsub = new RedisPubSub();
    await pubsub.start(onUserEvent, vi.fn(), onTickEvent);

    const handler = getMessageHandler();
    handler("igfx:ws:user", JSON.stringify({
      workerId: "other", userId: "user-1", eventType: "order.filled", payload: {},
    }));

    expect(onUserEvent).toHaveBeenCalledTimes(1);
    expect(onTickEvent).not.toHaveBeenCalled();
  });
});
