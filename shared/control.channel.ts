/**
 * control.channel.ts — small generic Redis pub/sub helper for cluster-wide
 * control-plane state (kill switch, global risk supervisor mode, and any
 * future admin-facing safety toggle).
 *
 * Milestone 1 / Fix #6. Distinct from realtime-infra/redis.pubsub.ts, which
 * is specifically the WebSocket user/broadcast event fan-out — this module
 * is for small, infrequent, authoritative state snapshots that every worker
 * must converge on quickly (an admin's kill-switch activation, a risk
 * supervisor mode change), not high-frequency application events.
 *
 * Same degrade-to-local-only behaviour as the rest of the realtime-infra
 * stack: with no Redis configured, publish() is a no-op and subscribe()
 * simply never receives anything — each worker only sees changes it makes
 * itself, which is the pre-existing (single-worker-safe) behaviour this fix
 * improves on for multi-worker deployments, not a regression for
 * single-worker ones.
 */

import type { Redis } from "ioredis";
import { getRedis } from "./redis.js";

const PREFIX = "igfx:control:";

type Handler = (payload: unknown) => void;

let subscriber: Redis | null = null;
let subscriberReady: Promise<Redis | null> | null = null;
const handlers = new Map<string, Handler[]>();

async function ensureSubscriber(): Promise<Redis | null> {
  if (subscriber) return subscriber;
  if (subscriberReady) return subscriberReady;

  subscriberReady = (async () => {
    const redis = getRedis();
    if (!redis) return null;

    const sub = redis.duplicate();
    sub.on("error", (err) => console.warn("[control-channel] subscriber error:", err.message));
    sub.on("message", (channel: string, raw: string) => {
      const list = handlers.get(channel);
      if (!list || list.length === 0) return;
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      for (const h of list) h(payload);
    });

    subscriber = sub;
    return sub;
  })();

  return subscriberReady;
}

/** Subscribes to a named control channel; onMessage fires for updates from OTHER workers. */
export async function subscribeControlChannel(name: string, onMessage: Handler): Promise<void> {
  const sub = await ensureSubscriber();
  if (!sub) return; // no Redis — this worker only ever sees its own local state

  const channel = PREFIX + name;
  const list = handlers.get(channel) ?? [];
  list.push(onMessage);
  handlers.set(channel, list);

  await sub.subscribe(channel).catch((err) =>
    console.warn(`[control-channel] subscribe(${channel}) failed:`, (err as Error).message),
  );
}

/** Publishes the current state on a named control channel to every other worker. */
export async function publishControlChannel(name: string, payload: unknown): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.publish(PREFIX + name, JSON.stringify(payload));
  } catch (err) {
    // Non-fatal — this worker already applied the change locally; only
    // cross-worker propagation failed.
    console.warn(`[control-channel] publish(${name}) failed (non-fatal):`, (err as Error).message);
  }
}
