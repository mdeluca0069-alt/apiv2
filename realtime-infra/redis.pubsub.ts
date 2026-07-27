/**
 * RedisPubSub — cross-node WebSocket event propagation.
 *
 * Architecture:
 *
 *   Each worker process publishes user-specific and broadcast events to Redis
 *   channels. Every worker subscribes and delivers received messages to its
 *   locally-connected WebSocket clients.
 *
 *   Publisher side (event fires on Worker-N):
 *     1. Push to locally-connected sessions  ← zero-latency for on-node clients
 *     2. Publish to Redis channel            ← notifies all other nodes
 *
 *   Subscriber side (other workers receive):
 *     1. Check workerId != origin            ← skip echo from own publish
 *     2. Push to locally-connected sessions
 *     3. If outboxId in message, mark it published in DB
 *
 *   Channels:
 *     igfx:ws:user       — per-user events (fills, positions, wallet, warnings)
 *     igfx:ws:broadcast  — platform-wide events (signals, system notices)
 *
 *   Graceful degradation:
 *     When Redis is unavailable, both publishUser() and publishBroadcast() are
 *     no-ops. Single-node delivery still works; cross-node sync is disabled.
 *     The outbox background sweep covers eventual replay for offline users.
 *
 *   Subscriber client:
 *     Redis subscribers can ONLY subscribe — they cannot issue other commands.
 *     We therefore duplicate the main connection for the subscriber.
 */

import { Redis }     from "ioredis";
import { getRedis }  from "../shared/redis.js";
import { randomUUID } from "node:crypto";

// ── Channels ──────────────────────────────────────────────────────────────────
const CH_USER      = "igfx:ws:user";
const CH_BROADCAST = "igfx:ws:broadcast";
// MARKET_DATA_FREEZE.md §0.10: quoteCache/InternalLiquidityCore are
// per-process singletons with no cross-node sync -- in a horizontally
// scaled deployment, a client's WS connection pinned to one worker and an
// order routed to another could read genuinely different quoteCache
// contents (not just latency-delayed, independently derived). Reuses this
// same relay class/pattern (workerId self-echo-skip, graceful degradation
// when Redis is unavailable) rather than a new mechanism.
const CH_TICK       = "igfx:market:tick";

// ── Worker identity ────────────────────────────────────────────────────────────
// PM2 sets PM2_INSTANCE_ID or cluster ID. Fall back to a random UUID suffix.
export const WORKER_ID: string =
  process.env.PM2_INSTANCE_ID ??
  process.env.WORKER_ID        ??
  randomUUID().slice(0, 8);

// ── Message envelope ──────────────────────────────────────────────────────────
export type WsEnvelope = {
  workerId:  string;               // originating worker — receivers skip this worker
  userId:    string | null;        // null for broadcast messages
  eventType: string;
  payload:   Record<string, unknown>;
};

export type TickEnvelope = {
  workerId: string;
  symbol:   string;
  mid:      number;
  bid?:     number;
  ask?:     number;
};

// ── Callbacks ─────────────────────────────────────────────────────────────────
export type OnUserEvent      = (userId: string, eventType: string, payload: Record<string, unknown>) => void;
export type OnBroadcastEvent = (eventType: string, payload: Record<string, unknown>) => void;
export type OnTickEvent      = (symbol: string, mid: number, bid?: number, ask?: number) => void;

// ─────────────────────────────────────────────────────────────────────────────

export class RedisPubSub {
  private subscriber: Redis | null = null;
  private connected   = false;

  private onUserEvent?:      OnUserEvent;
  private onBroadcastEvent?: OnBroadcastEvent;
  private onTickEvent?:      OnTickEvent;

  /**
   * Start the subscriber connection and register delivery callbacks.
   * Call once at startup, after initRedis() succeeds.
   */
  async start(
    onUserEvent:      OnUserEvent,
    onBroadcastEvent: OnBroadcastEvent,
    onTickEvent?:     OnTickEvent,
  ): Promise<void> {
    const redis = getRedis();
    if (!redis) {
      console.warn(`[redis-pubsub] worker=${WORKER_ID} Redis unavailable — cross-node WS sync disabled`);
      return;
    }

    this.onUserEvent      = onUserEvent;
    this.onBroadcastEvent = onBroadcastEvent;
    this.onTickEvent      = onTickEvent;

    // Duplicate the shared client — subscriber connections cannot issue
    // non-subscribe commands (SET, GET, PUBLISH, etc.) on the same connection.
    this.subscriber = redis.duplicate();

    this.subscriber.on("error", (err) => {
      console.warn("[redis-pubsub] subscriber error:", err.message);
    });

    this.subscriber.on("connect", () => {
      this.connected = true;
    });

    this.subscriber.on("close", () => {
      this.connected = false;
    });

    // PRODUCTION CUTOVER Stage 3 — live-confirmed (docker-compose.prod.yml
    // shadow deployment): duplicate() inherits the base client's
    // lazyConnect:true, so without an explicit connect() the socket is never
    // opened and subscribe() fails immediately with enableOfflineQueue false.
    // The caller's try/catch mislabeled this as "single-node mode" -- it was
    // never a deliberate fallback, it silently broke cross-node WS relay on
    // every boot with a real Redis configured.
    await this.subscriber.connect();
    await this.subscriber.subscribe(CH_USER, CH_BROADCAST, CH_TICK);

    this.subscriber.on("message", (channel, raw) => {
      if (channel === CH_TICK) {
        let tick: TickEnvelope;
        try {
          tick = JSON.parse(raw) as TickEnvelope;
        } catch {
          return;
        }
        if (tick.workerId === WORKER_ID) return; // skip echo
        this.onTickEvent?.(tick.symbol, tick.mid, tick.bid, tick.ask);
        return;
      }

      let envelope: WsEnvelope;
      try {
        envelope = JSON.parse(raw) as WsEnvelope;
      } catch {
        return;
      }

      // Skip echo — this worker already pushed locally when it published.
      if (envelope.workerId === WORKER_ID) return;

      if (channel === CH_USER && envelope.userId) {
        this.onUserEvent?.(envelope.userId, envelope.eventType, envelope.payload);
      } else if (channel === CH_BROADCAST) {
        this.onBroadcastEvent?.(envelope.eventType, envelope.payload);
      }
    });

    this.connected = true;
    console.log(`[redis-pubsub] worker=${WORKER_ID} subscribed to ${CH_USER} + ${CH_BROADCAST} + ${CH_TICK}`);
  }

  /** Whether the subscriber connection is active. */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Publish a per-user event to all other nodes.
   *
   * The payload may include `__outboxId` so receiving nodes can mark the
   * outbox entry published after successful WS delivery — preventing the
   * background sweep from issuing a duplicate push.
   */
  async publishUser(
    userId:    string,
    eventType: string,
    payload:   Record<string, unknown>,
  ): Promise<void> {
    await this._publish(CH_USER, { workerId: WORKER_ID, userId, eventType, payload });
  }

  /** Publish a platform-wide broadcast to all other nodes. */
  async publishBroadcast(
    eventType: string,
    payload:   Record<string, unknown>,
  ): Promise<void> {
    await this._publish(CH_BROADCAST, { workerId: WORKER_ID, userId: null, eventType, payload });
  }

  /**
   * MARKET_DATA_FREEZE.md §0.10 — publish a real market tick this worker's
   * OWN feed connections just accepted, so every other worker's
   * InternalLiquidityCore/quoteCache can apply it too. Only ever called
   * from the feed-ingestion path for a LOCALLY-sourced tick (never from
   * the onTickEvent receive callback) -- publishing a relayed tick back
   * out would create an infinite cross-node echo.
   */
  async publishTick(symbol: string, mid: number, bid?: number, ask?: number): Promise<void> {
    await this._publish(CH_TICK, { workerId: WORKER_ID, symbol, mid, bid, ask });
  }

  async stop(): Promise<void> {
    this.connected = false;
    if (this.subscriber) {
      try { await this.subscriber.quit(); } catch { /* ignore */ }
      this.subscriber = null;
    }
    console.log(`[redis-pubsub] worker=${WORKER_ID} stopped`);
  }

  private async _publish(channel: string, envelope: Record<string, unknown>): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.publish(channel, JSON.stringify(envelope));
    } catch (err) {
      // Non-fatal — single-node delivery already happened; only cross-node sync fails.
      console.warn("[redis-pubsub] publish failed (non-fatal):", (err as Error).message);
    }
  }
}

export const redisPubSub = new RedisPubSub();
export default redisPubSub;
