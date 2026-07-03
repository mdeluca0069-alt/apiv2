import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { eventBus } from "../events-bus/event.bus.js";

type WsSession = {
  ws:     WebSocket;
  userId: string;
};

// userId → list of open WS connections (multiple tabs / devices)
const sessions = new Map<string, WsSession[]>();

// symbol → list of sessions subscribed to market data
const marketSubs = new Map<string, Set<string>>(); // symbol → Set<userId>

// Last-value coalescing for high-frequency market quotes.
// Under heavy tick load a slow client would otherwise queue stale ticks;
// instead, consecutive ticks within the same event-loop macro-task are merged
// and only the latest is delivered once per setImmediate drain.
const _quoteLastValue = new Map<string, string>();
const _quoteTimers    = new Map<string, ReturnType<typeof setImmediate>>();

function addSession(userId: string, ws: WebSocket): void {
  const list = sessions.get(userId) ?? [];
  list.push({ ws, userId });
  sessions.set(userId, list);
}

function removeSession(userId: string, ws: WebSocket): void {
  const list = sessions.get(userId)?.filter((s) => s.ws !== ws) ?? [];
  if (list.length === 0) sessions.delete(userId);
  else sessions.set(userId, list);
}

/**
 * Prune dead (closed/closing) connections from a user's session list lazily.
 * Called before each per-user push so stale handles don't accumulate.
 */
function pruneUser(userId: string): WsSession[] {
  const list = sessions.get(userId);
  if (!list) return [];
  const alive = list.filter(
    (s) => s.ws.readyState === WebSocket.OPEN || s.ws.readyState === WebSocket.CONNECTING,
  );
  if (alive.length === 0) { sessions.delete(userId); return []; }
  if (alive.length !== list.length) sessions.set(userId, alive);
  return alive;
}

function pushToUser(userId: string, payload: object): void {
  const list = pruneUser(userId);
  if (!list.length) return;
  const msg = JSON.stringify(payload);
  for (const { ws } of list) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch { /* ignore broken pipe */ }
    }
  }
}

function broadcast(payload: object): void {
  const msg = JSON.stringify(payload);
  for (const [userId, list] of sessions) {
    const alive = list.filter(
      (s) => s.ws.readyState === WebSocket.OPEN || s.ws.readyState === WebSocket.CONNECTING,
    );
    if (alive.length !== list.length) {
      if (alive.length === 0) sessions.delete(userId);
      else sessions.set(userId, alive);
    }
    for (const { ws } of alive) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch { /* ignore */ }
      }
    }
  }
}

/**
 * Coalesced market-quote push: if multiple ticks arrive for the same symbol
 * within a single event-loop tick, only the latest is sent. This prevents
 * slow clients from building up a backlog of stale ticks.
 */
function pushQuoteCoalesced(symbol: string, payload: object): void {
  _quoteLastValue.set(symbol, JSON.stringify(payload));
  if (_quoteTimers.has(symbol)) return;
  _quoteTimers.set(symbol, setImmediate(() => {
    _quoteTimers.delete(symbol);
    const latest = _quoteLastValue.get(symbol);
    _quoteLastValue.delete(symbol);
    if (!latest) return;
    const userIds = marketSubs.get(symbol);
    if (!userIds?.size) return;
    for (const userId of userIds) {
      const list = pruneUser(userId);
      for (const { ws } of list) {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(latest); } catch { /* ignore */ }
        }
      }
    }
  }));
}

export function attachWebSocketServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    let authedUserId: string | null = null;

    ws.on("message", (raw) => {
      let msg: { type: string; userId?: string; symbols?: string[] };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }

      // ── AUTH ──────────────────────────────────────────────────────────
      if (msg.type === "AUTH" && msg.userId) {
        authedUserId = msg.userId;
        addSession(authedUserId, ws);
        ws.send(JSON.stringify({ type: "AUTH_OK", userId: authedUserId }));
        return;
      }

      if (!authedUserId) {
        ws.send(JSON.stringify({ type: "ERROR", message: "Not authenticated" }));
        return;
      }

      // ── SUBSCRIBE to market data ──────────────────────────────────────
      if (msg.type === "SUBSCRIBE" && Array.isArray(msg.symbols)) {
        for (const sym of msg.symbols) {
          const s = sym.toUpperCase();
          if (!marketSubs.has(s)) marketSubs.set(s, new Set());
          marketSubs.get(s)!.add(authedUserId);
        }
        ws.send(JSON.stringify({ type: "SUBSCRIBED", symbols: msg.symbols }));
        return;
      }

      // ── UNSUBSCRIBE ───────────────────────────────────────────────────
      if (msg.type === "UNSUBSCRIBE" && Array.isArray(msg.symbols)) {
        for (const sym of msg.symbols) {
          marketSubs.get(sym.toUpperCase())?.delete(authedUserId);
        }
        return;
      }

      // ── PING ──────────────────────────────────────────────────────────
      if (msg.type === "PING") {
        ws.send(JSON.stringify({ type: "PONG", ts: Date.now() }));
      }
    });

    ws.on("close", () => {
      if (authedUserId) removeSession(authedUserId, ws);
    });

    ws.on("error", (err) => {
      console.error("[ws] socket error:", err.message);
    });
  });

  // ── Wire event bus → WebSocket push ──────────────────────────────────────

  eventBus.on("order.filled", (evt) => {
    pushToUser(evt.userId, { type: "order.filled", data: evt });
  });

  eventBus.on("order.rejected", (evt) => {
    pushToUser(evt.userId, { type: "order.rejected", data: evt });
  });

  eventBus.on("order.status_changed", (evt) => {
    pushToUser(evt.userId, { type: "order.status_changed", data: evt });
  });

  eventBus.on("position.opened", (evt) => {
    pushToUser(evt.userId, { type: "position.opened", data: evt });
  });

  eventBus.on("position.closed", (evt) => {
    pushToUser(evt.userId, { type: "position.closed", data: evt });
  });

  eventBus.on("position.pnl_updated", (evt) => {
    pushToUser(evt.userId, { type: "position.pnl_updated", data: evt });
  });

  eventBus.on("risk.warning", (evt) => {
    pushToUser(evt.userId, { type: "risk.warning", data: evt });
  });

  eventBus.on("margin.warning", (evt) => {
    pushToUser(evt.userId, { type: "margin.warning", data: evt });
  });

  eventBus.on("wallet.event", (evt) => {
    pushToUser(evt.userId, { type: "wallet.event", data: evt });
  });

  // Market data: coalesced delivery — rapid ticks are merged per symbol
  eventBus.on("market.quote", (evt) => {
    pushQuoteCoalesced(evt.symbol, { type: "market.quote", data: evt });
  });

  console.log("[ws-broadcaster] WebSocket server attached on /ws");
  return wss;
}

export { pushToUser, broadcast };
