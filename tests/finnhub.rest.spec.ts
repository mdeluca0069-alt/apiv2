/**
 * finnhub.rest.spec.ts
 *
 * STAGING ONLY — unit coverage for market-data/feeds/finnhub.rest.ts:
 *   - one HTTP request PER symbol (Finnhub free has no batch /quote,
 *     unlike TwelveData's comma-joined /quote and /price)
 *   - requests are issued SEQUENTIALLY — never more than one in flight at
 *     once, i.e. never Promise.all-style parallel burst
 *   - one symbol's failure does not abort the rest of the sequential batch
 *
 * MOCKING STRATEGY: mocks the whole "node:https" module via vi.mock()
 * rather than vi.spyOn(https, "get"). In this environment,
 * `import * as https from "node:https"` yields a namespace object whose
 * `get` property has a non-configurable descriptor — vi.spyOn(https,
 * "get") throws "TypeError: Cannot redefine property: get" even on the
 * very first call in the very first test, not just on a second/uncleaned
 * spy. vi.mock("node:https", ...) replaces module RESOLUTION instead of
 * mutating a property on the resolved namespace object, which sidesteps
 * that entirely. getMock is created via vi.hoisted() (required — vi.mock's
 * factory is hoisted above ordinary module-level `const`s) and reset to a
 * fresh implementation in beforeEach, giving every test clean mock state
 * without relying on mockRestore() (which only applies to real spies on
 * existing objects, not a manufactured vi.fn()).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock("node:https", () => ({ get: getMock }));

type FakeReq = EventEmitter & { destroy: () => void };
type FakeRes = EventEmitter & { statusCode: number };

function fakeRequest(): FakeReq {
  const req = new EventEmitter() as FakeReq;
  req.destroy = () => { /* no-op */ };
  return req;
}

describe("finnhub.rest.ts — fetchCurrentPrices", () => {
  let callOrder: string[];
  let inFlight: number;
  let maxInFlight: number;

  beforeEach(() => {
    vi.resetModules();
    getMock.mockReset();
    callOrder    = [];
    inFlight     = 0;
    maxInFlight  = 0;

    getMock.mockImplementation((url: unknown, _opts: unknown, cb: unknown) => {
      const urlStr = String(url);
      const symbol = /symbol=([^&]+)/.exec(urlStr)?.[1] ?? "?";
      callOrder.push(symbol);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);

      const req = fakeRequest();
      // Defer invoking the callback to a LATER microtask than the one that
      // constructs the response, so httpsGet's own `res.on("data", ...)` /
      // `res.on("end", ...)` listeners are attached (inside the callback)
      // BEFORE the fake response emits anything — otherwise the events
      // would fire with no listener attached and the call would hang.
      queueMicrotask(() => {
        const res = new EventEmitter() as FakeRes;
        res.statusCode = 200;
        (cb as (res: FakeRes) => void)(res);
        inFlight--;
        queueMicrotask(() => {
          res.emit("data", Buffer.from(JSON.stringify({ c: 100 + callOrder.length })));
          res.emit("end");
        });
      });

      return req;
    });
  });

  it("issues exactly one HTTP request per symbol, in order", async () => {
    const { fetchCurrentPrices } = await import("../market-data/feeds/finnhub.rest.js");
    const symbols = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"];

    await fetchCurrentPrices("test-key", symbols);

    expect(callOrder).toEqual(symbols);
    expect(getMock).toHaveBeenCalledTimes(5);
  });

  it("never has more than one request in flight at a time (sequential, no Promise.all burst)", async () => {
    const { fetchCurrentPrices } = await import("../market-data/feeds/finnhub.rest.js");
    await fetchCurrentPrices("test-key", ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"]);

    expect(maxInFlight).toBe(1);
  });

  it("returns a Map of IGFX symbol -> current price for every successful symbol", async () => {
    const { fetchCurrentPrices } = await import("../market-data/feeds/finnhub.rest.js");
    const result = await fetchCurrentPrices("test-key", ["AAPL", "MSFT"]);

    expect(result.size).toBe(2);
    expect(result.get("AAPL")).toBeGreaterThan(0);
    expect(result.get("MSFT")).toBeGreaterThan(0);
  });

  it("continues to the next symbol when one symbol's request errors out", async () => {
    getMock.mockImplementation((url: unknown, _opts: unknown, cb: unknown) => {
      const urlStr = String(url);
      const req = fakeRequest();
      if (urlStr.includes("symbol=MSFT")) {
        queueMicrotask(() => req.emit("error", new Error("network error")));
      } else {
        queueMicrotask(() => {
          const res = new EventEmitter() as FakeRes;
          res.statusCode = 200;
          (cb as (res: FakeRes) => void)(res);
          queueMicrotask(() => {
            res.emit("data", Buffer.from(JSON.stringify({ c: 200 })));
            res.emit("end");
          });
        });
      }
      return req;
    });

    const { fetchCurrentPrices } = await import("../market-data/feeds/finnhub.rest.js");
    const result = await fetchCurrentPrices("test-key", ["AAPL", "MSFT", "NVDA"]);

    expect(result.has("MSFT")).toBe(false);
    expect(result.get("AAPL")).toBe(200);
    expect(result.get("NVDA")).toBe(200);
  });

  it("returns an empty Map for an empty symbol list without making any request", async () => {
    const { fetchCurrentPrices } = await import("../market-data/feeds/finnhub.rest.js");
    const result = await fetchCurrentPrices("test-key", []);

    expect(result.size).toBe(0);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("never logs the API key/token in a thrown or console error path", async () => {
    getMock.mockImplementation((_url: unknown, _opts: unknown, _cb: unknown) => {
      const req = fakeRequest();
      queueMicrotask(() => req.emit("error", new Error("boom")));
      return req;
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetchCurrentPrices } = await import("../market-data/feeds/finnhub.rest.js");
    await fetchCurrentPrices("super-secret-token", ["AAPL"]);

    for (const call of errSpy.mock.calls) {
      expect(call.join(" ")).not.toContain("super-secret-token");
    }
    errSpy.mockRestore();
  });
});
