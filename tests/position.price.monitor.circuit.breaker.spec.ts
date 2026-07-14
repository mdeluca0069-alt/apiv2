/**
 * position.price.monitor.circuit.breaker.spec.ts
 *
 * FASE 4.2 (Risk Engine, Bug #3) — PositionPriceMonitor's tick-level SL/TP
 * handler used to force-close a position the instant its stop-loss/take-
 * profit level was crossed, even if that symbol is currently halted by the
 * circuit breaker (or an admin) — closing at exactly the anomalous price
 * the halt exists to flag as untrustworthy. Fix: a hit SL/TP on a halted
 * symbol falls through to the normal P&L cache update instead of
 * triggering settlement; the position stays open, still tracked live, and
 * will close normally the moment the symbol is no longer halted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockFindUnique, mockFindMany } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockFindMany:   vi.fn().mockResolvedValue([]),
}));
vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: { position: { findUnique: mockFindUnique, findMany: mockFindMany }, walletAccount: { findMany: vi.fn().mockResolvedValue([]) } },
}));

const { mockOn, mockEmit, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (evt: unknown) => void>();
  return {
    handlers,
    mockOn:   vi.fn((event: string, cb: (evt: unknown) => void) => { handlers.set(event, cb); }),
    mockEmit: vi.fn(),
  };
});
vi.mock("../events-bus/event.bus.js", () => ({ eventBus: { on: mockOn, emit: mockEmit } }));

const { mockSettle } = vi.hoisted(() => ({ mockSettle: vi.fn().mockResolvedValue({}) }));
vi.mock("../settlement/settlement.engine.js", () => ({
  settlementEngine: { settle: mockSettle },
  PositionAlreadyClosedError: class PositionAlreadyClosedError extends Error {},
}));

vi.mock("../trading-service/stopout.engine.js", () => ({
  stopOutEngine: { checkUser: vi.fn().mockResolvedValue({ action: "NONE" }) },
}));

vi.mock("../gateway/metrics.js", () => ({ metrics: { inc: vi.fn() } }));

const { mockIsEnabled } = vi.hoisted(() => ({ mockIsEnabled: vi.fn() }));
vi.mock("../liquidity-engine/broker.spread.config.js", () => ({
  brokerSpreadConfig: { isEnabled: mockIsEnabled },
}));

const { PositionPriceMonitor } = await import("../trading-service/position.price.monitor.js");

function decimalLike(n: number) {
  return { toNumber: () => n } as unknown as Decimal;
}

async function makeMonitorWithPosition(overrides: Record<string, unknown> = {}) {
  const monitor = new PositionPriceMonitor();
  mockFindUnique.mockResolvedValue({
    id: "pos-1", userId: "user-1", symbol: "EURUSD", side: "BUY",
    quantity: decimalLike(100_000), entryPrice: decimalLike(1.1000), markPrice: decimalLike(1.1000),
    pnl: decimalLike(0), pnlPercent: decimalLike(0), marginUsed: decimalLike(1_000), leverage: 10,
    stopLoss: decimalLike(1.0900), takeProfit: null, openedAt: new Date(), status: "OPEN",
    ...overrides,
  });
  await monitor.start();
  await monitor.addPosition("pos-1");
  return monitor;
}

function fireQuote(symbol: string, bid: number, ask: number) {
  handlers.get("market.quote")?.({ symbol, bid, ask });
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  mockFindMany.mockResolvedValue([]);
  mockIsEnabled.mockReturnValue(true);
});

describe("PositionPriceMonitor — circuit breaker position protection", () => {
  it("triggers settlement as normal when the symbol is not halted", async () => {
    const monitor = await makeMonitorWithPosition();

    fireQuote("EURUSD", 1.0850, 1.0852); // bid 1.0850 <= SL 1.0900 → hit
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSettle).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it("does NOT trigger settlement when the SL is hit but the symbol is currently halted", async () => {
    const monitor = await makeMonitorWithPosition();
    mockIsEnabled.mockReturnValue(false);

    fireQuote("EURUSD", 1.0850, 1.0852); // bid 1.0850 <= SL 1.0900 → would hit
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSettle).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("still updates the position's live P&L cache while the halt defers its liquidation", async () => {
    const monitor = await makeMonitorWithPosition();
    mockIsEnabled.mockReturnValue(false);

    fireQuote("EURUSD", 1.0850, 1.0852);
    await new Promise((r) => setTimeout(r, 0));

    // pnl_updated should still have been emitted for the position (fallthrough path).
    const pnlEmits = mockEmit.mock.calls.filter((c) => c[0] === "position.pnl_updated");
    expect(pnlEmits.length).toBeGreaterThan(0);
    monitor.stop();
  });

  it("triggers settlement once the symbol is no longer halted on a later tick", async () => {
    const monitor = await makeMonitorWithPosition();
    mockIsEnabled.mockReturnValue(false);

    fireQuote("EURUSD", 1.0850, 1.0852); // halted, deferred
    await new Promise((r) => setTimeout(r, 0));
    expect(mockSettle).not.toHaveBeenCalled();

    mockIsEnabled.mockReturnValue(true); // halt clears
    fireQuote("EURUSD", 1.0850, 1.0852); // same crossed price, next tick
    await new Promise((r) => setTimeout(r, 0));

    expect(mockSettle).toHaveBeenCalledTimes(1);
    monitor.stop();
  });
});
