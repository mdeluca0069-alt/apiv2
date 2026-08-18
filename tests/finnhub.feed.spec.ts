/**
 * finnhub.feed.spec.ts
 *
 * STAGING ONLY — unit coverage for market-data/feeds/finnhub.feed.ts:
 *   - connects to wss://ws.finnhub.io with the configured API key as token
 *   - sends one "subscribe" message PER symbol (Finnhub has no comma-joined
 *     batch subscribe, unlike TwelveData)
 *   - normalizes trade frames into NormalizedQuote (half-spread synthesis,
 *     90/10 smoothing, isRealSpread: false — Finnhub free trades carry no
 *     bid/ask field)
 *   - reconnects with the same exponential-backoff contract as
 *     twelvedata.feed.ts / binance.feed.ts, and never reconnects after stop()
 *   - ignores malformed / non-trade frames safely, redacts the token from
 *     WS error messages
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock(...) factories are hoisted above ALL other module-level
// statements, including a top-level `class` declaration — a plain
// `class FakeWebSocket {...}` declared before this vi.mock() call would
// still be referenced before initialization once hoisted. vi.hoisted()
// runs its own initializer during that same hoist pass, so the class
// exists by the time the factory below needs it.
//
// The class deliberately does NOT extend Node's EventEmitter: a
// vi.hoisted() callback cannot reference a binding imported from another
// module (imports are themselves compiled into hoisted accessors that are
// only initialized AFTER vi.hoisted() runs) — referencing an imported
// EventEmitter here reproduces the exact same "used before initialization"
// failure one layer deeper. FinnhubFeed only ever calls `.on(event, cb)`
// and this file only ever calls `.emit(event, ...args)` on the fake, so a
// minimal hand-rolled listener registry covers the full surface actually
// used, with identical on()/emit() semantics to EventEmitter for that
// surface.
const { FakeWebSocket } = vi.hoisted(() => {
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    public sent: string[] = [];
    public closed = false;
    constructor(public url: string, public opts?: unknown) {
      FakeWebSocket.instances.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void): this {
      (this.listeners[event] ??= []).push(cb);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.listeners[event] ?? []) cb(...args);
    }
    send(data: string): void { this.sent.push(data); }
    close(): void { this.closed = true; }
  }
  return { FakeWebSocket };
});

vi.mock("ws", () => ({ WebSocket: FakeWebSocket }));

import { FinnhubFeed } from "../market-data/feeds/finnhub.feed.js";

const SYMBOLS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"];

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FinnhubFeed — connection & subscription", () => {
  it("connects to wss://ws.finnhub.io with the API key as a token query param", () => {
    const feed = new FinnhubFeed({ apiKey: "test-key", symbols: SYMBOLS, onQuote: vi.fn() });
    feed.start();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe("wss://ws.finnhub.io?token=test-key");

    feed.stop();
  });

  it("sends one subscribe message PER symbol on open — not a comma-joined batch", () => {
    const feed = new FinnhubFeed({ apiKey: "test-key", symbols: SYMBOLS, onQuote: vi.fn() });
    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    expect(ws.sent).toHaveLength(5);
    for (const symbol of SYMBOLS) {
      expect(ws.sent).toContainEqual(JSON.stringify({ type: "subscribe", symbol }));
    }

    feed.stop();
  });

  it("does not open a connection at all when given an empty symbol list", () => {
    const feed = new FinnhubFeed({ apiKey: "test-key", symbols: [], onQuote: vi.fn() });
    feed.start();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe("FinnhubFeed — tick normalization", () => {
  it("normalizes a trade frame into NormalizedQuote with isRealSpread: false", () => {
    const onQuote = vi.fn();
    const feed = new FinnhubFeed({ apiKey: "test-key", symbols: SYMBOLS, onQuote });
    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    ws.emit("message", Buffer.from(JSON.stringify({
      type: "trade",
      data: [{ s: "AAPL", p: 230.5, t: Date.now(), v: 10 }],
    })));

    expect(onQuote).toHaveBeenCalledTimes(1);
    const quote = onQuote.mock.calls[0][0];
    expect(quote.symbol).toBe("AAPL");
    expect(quote.mid).toBeCloseTo(230.5, 2);
    expect(quote.isRealSpread).toBe(false);
    expect(quote.bid).toBeLessThan(quote.mid);
    expect(quote.ask).toBeGreaterThan(quote.mid);

    feed.stop();
  });

  it("handles a trade frame carrying multiple symbols in one message", () => {
    const onQuote = vi.fn();
    const feed = new FinnhubFeed({ apiKey: "test-key", symbols: SYMBOLS, onQuote });
    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    ws.emit("message", Buffer.from(JSON.stringify({
      type: "trade",
      data: [
        { s: "AAPL", p: 230.5, t: 1, v: 1 },
        { s: "MSFT", p: 465.2, t: 2, v: 1 },
      ],
    })));

    expect(onQuote).toHaveBeenCalledTimes(2);
    expect(onQuote.mock.calls.map((c) => c[0].symbol)).toEqual(["AAPL", "MSFT"]);

    feed.stop();
  });

  it("ignores non-trade frames (e.g. Finnhub's own ping/keepalive) without emitting a quote or error", () => {
    const onQuote = vi.fn();
    const onError = vi.fn();
    const feed = new FinnhubFeed({ apiKey: "test-key", symbols: SYMBOLS, onQuote, onError });
    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    ws.emit("message", Buffer.from(JSON.stringify({ type: "ping" })));

    expect(onQuote).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    feed.stop();
  });

  it("surfaces a Finnhub error frame via onError", () => {
    const onError = vi.fn();
    const feed = new FinnhubFeed({ apiKey: "test-key", symbols: SYMBOLS, onQuote: vi.fn(), onError });
    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    ws.emit("message", Buffer.from(JSON.stringify({ type: "error", msg: "invalid symbol" })));

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toContain("finnhub-ws error");

    feed.stop();
  });

  it("ignores malformed (non-JSON) frames without throwing", () => {
    const onQuote = vi.fn();
    const feed = new FinnhubFeed({ apiKey: "test-key", symbols: SYMBOLS, onQuote });
    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    expect(() => ws.emit("message", Buffer.from("not json"))).not.toThrow();
    expect(onQuote).not.toHaveBeenCalled();

    feed.stop();
  });

  it("ignores a trade entry with a non-numeric price", () => {
    const onQuote = vi.fn();
    const feed = new FinnhubFeed({ apiKey: "test-key", symbols: SYMBOLS, onQuote });
    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    ws.emit("message", Buffer.from(JSON.stringify({
      type: "trade",
      data: [{ s: "AAPL", p: "not-a-number", t: 1 }],
    })));

    expect(onQuote).not.toHaveBeenCalled();
    feed.stop();
  });
});

describe("FinnhubFeed — reconnect backoff", () => {
  it("schedules a reconnect on close (not stopped) and calls onReconnect", () => {
    const onReconnect = vi.fn();
    const feed = new FinnhubFeed({ apiKey: "test-key", symbols: SYMBOLS, onQuote: vi.fn(), onReconnect });
    feed.start();
    const ws1 = FakeWebSocket.instances[0];

    ws1.emit("close");
    expect(onReconnect).toHaveBeenCalledWith(1);

    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    feed.stop();
  });

  it("does NOT reconnect after stop() is called", () => {
    const onReconnect = vi.fn();
    const feed = new FinnhubFeed({ apiKey: "test-key", symbols: SYMBOLS, onQuote: vi.fn(), onReconnect });
    feed.start();
    const ws1 = FakeWebSocket.instances[0];

    feed.stop();
    ws1.emit("close");

    expect(onReconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("redacts the token from a WS error message", () => {
    const onError = vi.fn();
    const feed = new FinnhubFeed({ apiKey: "super-secret-key", symbols: SYMBOLS, onQuote: vi.fn(), onError });
    feed.start();
    const ws = FakeWebSocket.instances[0];

    ws.emit("error", new Error("connect failed for wss://ws.finnhub.io?token=super-secret-key"));

    expect(onError).toHaveBeenCalledTimes(1);
    const msg = (onError.mock.calls[0][0] as Error).message;
    expect(msg).not.toContain("super-secret-key");
    expect(msg).toContain("token=REDACTED");

    feed.stop();
  });
});
