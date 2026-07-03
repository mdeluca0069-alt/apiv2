import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { eventBus, type SignalGeneratedEvent } from "../events-bus/event.bus.js";

type Subscriber = {
  socketId: string;   // unique per connection, not per user
  userId: string;
  socket: WebSocket;
  symbols: Set<string>;
  minConfidence: number;
  connectedAt: number;
};

export class SignalDispatcher {
  // Keyed by socketId (not userId) — supports multiple tabs per user
  private readonly subscribers = new Map<string, Subscriber>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.wireEventBus();
    this.startPeriodicCleanup();
  }

  private wireEventBus(): void {
    eventBus.on("signal.generated", (event) => {
      this.dispatch(event);
    });
  }

  /** Periodic cleanup of subscribers whose sockets closed without firing "close" event. */
  private startPeriodicCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      for (const [socketId, sub] of this.subscribers) {
        if (sub.socket.readyState !== sub.socket.OPEN) {
          this.subscribers.delete(socketId);
        }
      }
    }, 30_000); // every 30s
    this.cleanupTimer.unref(); // don't block process exit
  }

  /** Register a WebSocket connection to receive signals. Returns the socketId. */
  subscribe(
    userId: string,
    socket: WebSocket,
    options: { symbols?: string[]; minConfidence?: number } = {}
  ): string {
    const socketId = randomUUID();
    const sub: Subscriber = {
      socketId,
      userId,
      socket,
      symbols:       new Set(options.symbols ?? []),
      minConfidence: options.minConfidence ?? 0,
      connectedAt:   Date.now(),
    };
    this.subscribers.set(socketId, sub);

    // Clean up this specific connection on close — does NOT affect other tabs
    socket.once("close", () => this.subscribers.delete(socketId));

    return socketId;
  }

  unsubscribeSocket(socketId: string): void {
    this.subscribers.delete(socketId);
  }

  unsubscribeUser(userId: string): void {
    for (const [socketId, sub] of this.subscribers) {
      if (sub.userId === userId) this.subscribers.delete(socketId);
    }
  }

  updateSubscription(
    socketId: string,
    update: { symbols?: string[]; minConfidence?: number }
  ): void {
    const sub = this.subscribers.get(socketId);
    if (!sub) return;
    if (update.symbols !== undefined)       sub.symbols = new Set(update.symbols);
    if (update.minConfidence !== undefined) sub.minConfidence = update.minConfidence;
  }

  private dispatch(event: SignalGeneratedEvent): void {
    const payload = JSON.stringify({ type: "signal.generated", payload: event });

    // Collect IDs to remove BEFORE mutating — never modify Map during iteration
    const toRemove: string[] = [];

    for (const [socketId, sub] of this.subscribers) {
      if (sub.socket.readyState !== sub.socket.OPEN) {
        toRemove.push(socketId);
        continue;
      }
      if (sub.symbols.size > 0 && !sub.symbols.has(event.symbol)) continue;
      if (event.confidence < sub.minConfidence) continue;

      try {
        sub.socket.send(payload);
      } catch {
        toRemove.push(socketId);
      }
    }

    for (const id of toRemove) this.subscribers.delete(id);
  }

  broadcastAll(type: string, data: unknown): void {
    const payload = JSON.stringify({ type, payload: data });
    const toRemove: string[] = [];

    for (const [socketId, sub] of this.subscribers) {
      if (sub.socket.readyState !== sub.socket.OPEN) {
        toRemove.push(socketId);
        continue;
      }
      try { sub.socket.send(payload); } catch { toRemove.push(socketId); }
    }

    for (const id of toRemove) this.subscribers.delete(id);
  }

  get subscriberCount(): number { return this.subscribers.size; }

  get uniqueUserCount(): number {
    return new Set([...this.subscribers.values()].map((s) => s.userId)).size;
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}

export const signalDispatcher = new SignalDispatcher();
export default signalDispatcher;
