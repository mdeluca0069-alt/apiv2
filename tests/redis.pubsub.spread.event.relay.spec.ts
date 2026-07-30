/**
 * redis.pubsub.spread.event.relay.spec.ts
 *
 * CRITICAL_REMEDIATION Phase 1 (C11) — dynamicSpreadEngine (liquidity-engine/
 * dynamic.spread.engine.ts) is, like quoteCache/InternalLiquidityCore, a
 * per-process singleton with its own in-memory `events` array. POST /admin/
 * spread/event previously called addEvent() only on whichever single
 * replica handled that HTTP request -- the other replicas' event calendars
 * never learned about it at all, so for the entire event window they
 * applied no event-driven spread widening while the one replica that
 * received the admin call did. Same symbol, same instant, deterministically
 * different bid/ask depending on which replica served a given request.
 *
 * Extends the existing RedisPubSub relay (already proven for igfx:market:
 * tick in redis.pubsub.tick.relay.spec.ts) with a fourth channel,
 * igfx:spread:event, using the identical pattern: workerId self-echo-skip,
 * one-hop-only, graceful no-op when Redis is unavailable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSubscriberOn      = vi.fn();
const mockSubscriberConnect = vi.fn().mockResolvedValue(undefined);
const mockSubscribe         = vi.fn().mockResolvedValue(undefined);
const mockSubscriberQuit    = vi.fn().mockResolvedValue(undefined);
const mockPublish           = vi.fn().mockResolvedValue(1);

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

function getMessageHandler(): (channel: string, raw: string) => void {
  const call = mockSubscriberOn.mock.calls.find((c) => c[0] === "message");
  if (!call) throw new Error("no 'message' handler was registered");
  return call[1] as (channel: string, raw: string) => void;
}

function sampleEvent() {
  return {
    name: "NFP", assetClasses: ["FX_MAJOR"], windowMinutes: 15,
    multiplier: 3.0, scheduledAt: new Date("2026-08-01T12:30:00.000Z"),
  };
}

describe("RedisPubSub — spread event relay (C11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedis.mockReturnValue(mockRedis);
    mockSubscriberConnect.mockResolvedValue(undefined);
    mockSubscribe.mockResolvedValue(undefined);
    mockPublish.mockResolvedValue(1);
  });

  it("publishSpreadEvent() sends a correctly-shaped envelope on the spread-event channel", async () => {
    const pubsub = new RedisPubSub();
    await pubsub.start(vi.fn(), vi.fn(), vi.fn(), vi.fn());

    await pubsub.publishSpreadEvent(sampleEvent());

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [channel, raw] = mockPublish.mock.calls[0]!;
    expect(channel).toBe("igfx:spread:event");
    const envelope = JSON.parse(raw as string);
    expect(envelope).toMatchObject({
      name: "NFP", assetClasses: ["FX_MAJOR"], windowMinutes: 15, multiplier: 3.0,
      scheduledAt: "2026-08-01T12:30:00.000Z",
    });
    expect(typeof envelope.workerId).toBe("string");
  });

  it("fires onSpreadEvent with a real Date, when an event arrives from another worker", async () => {
    const onSpreadEvent = vi.fn();
    const pubsub = new RedisPubSub();
    await pubsub.start(vi.fn(), vi.fn(), vi.fn(), onSpreadEvent);

    const handler = getMessageHandler();
    handler("igfx:spread:event", JSON.stringify({
      workerId: "other-worker-id", name: "NFP", assetClasses: ["FX_MAJOR"],
      windowMinutes: 15, multiplier: 3.0, scheduledAt: "2026-08-01T12:30:00.000Z",
    }));

    expect(onSpreadEvent).toHaveBeenCalledTimes(1);
    const received = onSpreadEvent.mock.calls[0]![0];
    expect(received).toMatchObject({ name: "NFP", assetClasses: ["FX_MAJOR"], windowMinutes: 15, multiplier: 3.0 });
    expect(received.scheduledAt).toBeInstanceOf(Date);
    expect(received.scheduledAt.toISOString()).toBe("2026-08-01T12:30:00.000Z");
  });

  it("skips an event tagged with this worker's own id (echo prevention)", async () => {
    const onSpreadEvent = vi.fn();
    const pubsub = new RedisPubSub();
    await pubsub.start(vi.fn(), vi.fn(), vi.fn(), onSpreadEvent);

    await pubsub.publishSpreadEvent(sampleEvent());
    const ownEnvelope = JSON.parse(mockPublish.mock.calls[0]![1] as string);

    const handler = getMessageHandler();
    handler("igfx:spread:event", JSON.stringify({ ...sampleEvent(), scheduledAt: sampleEvent().scheduledAt.toISOString(), workerId: ownEnvelope.workerId }));

    expect(onSpreadEvent).not.toHaveBeenCalled();
  });

  it("ignores malformed JSON on the spread-event channel instead of throwing", async () => {
    const onSpreadEvent = vi.fn();
    const pubsub = new RedisPubSub();
    await pubsub.start(vi.fn(), vi.fn(), vi.fn(), onSpreadEvent);

    const handler = getMessageHandler();
    expect(() => handler("igfx:spread:event", "{not valid json")).not.toThrow();
    expect(onSpreadEvent).not.toHaveBeenCalled();
  });

  it("publishSpreadEvent() is a safe no-op when Redis is unavailable", async () => {
    mockGetRedis.mockReturnValue(null);
    const pubsub = new RedisPubSub();

    await expect(pubsub.publishSpreadEvent(sampleEvent())).resolves.toBeUndefined();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("does not route a tick-channel message to onSpreadEvent, and vice versa", async () => {
    const onTickEvent   = vi.fn();
    const onSpreadEvent = vi.fn();
    const pubsub = new RedisPubSub();
    await pubsub.start(vi.fn(), vi.fn(), onTickEvent, onSpreadEvent);

    const handler = getMessageHandler();
    handler("igfx:market:tick", JSON.stringify({ workerId: "other", symbol: "EURUSD", mid: 1.1 }));

    expect(onTickEvent).toHaveBeenCalledTimes(1);
    expect(onSpreadEvent).not.toHaveBeenCalled();
  });
});
