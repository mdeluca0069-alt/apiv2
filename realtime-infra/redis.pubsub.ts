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

// ── Callbacks ─────────────────────────────────────────────────────────────────
export type OnUserEvent      = (userId: string, eventType: string, payload: Record<string, unknown>) => void;
export type OnBroadcastEvent = (eventType: string, payload: Record<string, unknown>) => void;

// ─────────────────────────────────────────────────────────────────────────────

export class RedisPubSub {
  private subscriber: Redis | null = null;
  private connected   = false;

  private onUserEvent?:      OnUserEvent;
  private onBroadcastEvent?: OnBroadcastEvent;

  /**
   * Start the subscriber connection and register delivery callbacks.
   * Call once at startup, after initRedis() succeeds.
   */
  async start(
    onUserEvent:      OnUserEvent,
    onBroadcastEvent: OnBroadcastEvent,
  ): Promise<void> {
    const redis = getRedis();
    if (!redis) {
      console.warn(`[redis-pubsub] worker=${WORKER_ID} Redis unavailable — cross-node WS sync disabled`);
      return;
    }

    this.onUserEvent      = onUserEvent;
    this.onBroadcastEvent = onBroadcastEvent;

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

    await this.subscriber.subscribe(CH_USER, CH_BROADCAST);

    this.subscriber.on("message", (channel, raw) => {
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
    console.log(`[redis-pubsub] worker=${WORKER_ID} subscribed to ${CH_USER} + ${CH_BROADCAST}`);
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

  async stop(): Promise<void> {
    this.connected = false;
    if (this.subscriber) {
      try { await this.subscriber.quit(); } catch { /* ignore */ }
      this.subscriber = null;
    }
    console.log(`[redis-pubsub] worker=${WORKER_ID} stopped`);
  }

  private async _publish(channel: string, envelope: WsEnvelope): Promise<void> {
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
