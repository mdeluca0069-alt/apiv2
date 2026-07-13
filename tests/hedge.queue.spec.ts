/**
 * hedge.queue.spec.ts
 *
 * FASE 3.8 — Internal Liquidity Engine (Group D: hedge scaffold).
 *
 * Proves HedgeQueue.runSweep():
 *   - creates a HedgeOrder row for each instrument crossing the policy
 *     threshold, skipping any already-open (SUBMITTED) recommendation
 *   - persists whatever the injected IExternalHedgeProvider actually returns
 *     (REJECTED today via the null provider, but the queue itself is
 *     provider-agnostic — a SUBMITTED result is persisted just as faithfully)
 *   - derives quantity from the live quote when available, leaves it
 *     undefined when no quote exists (never fabricates a price)
 *   - a single symbol's failure doesn't abort the whole sweep
 *   - no-ops entirely when the DB is not persistent (no in-memory fallback
 *     table exists for this scaffold — audit trail requires a real DB)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindFirst, mockCreate } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockCreate:    vi.fn().mockResolvedValue({}),
}));
const { mockIsPersistent } = vi.hoisted(() => ({ mockIsPersistent: { value: true } }));
vi.mock("../shared/db.js", () => ({
  get IS_PERSISTENT() { return mockIsPersistent.value; },
  prisma: { hedgeOrder: { findFirst: mockFindFirst, create: mockCreate } },
}));

const { mockGetAll } = vi.hoisted(() => ({ mockGetAll: vi.fn() }));
vi.mock("../risk-service/exposure.limits.js", () => ({
  exposureRegistry: { getAll: mockGetAll },
}));

const { mockQuoteGet } = vi.hoisted(() => ({ mockQuoteGet: vi.fn() }));
vi.mock("../market-data/quote.cache.js", () => ({
  quoteCache: { get: mockQuoteGet },
}));

const { HedgeQueue } = await import("../hedge-service/hedge.queue.js");

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "EURUSD", longNotional: 0, shortNotional: 0,
    grossNotional: 0, netNotional: 0, offsetNotional: 0,
    limitGross: 10_000_000, limitNet: 2_000_000, grossPct: 0, netPct: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsPersistent.value = true;
  mockFindFirst.mockResolvedValue(null);
  mockCreate.mockResolvedValue({});
  mockQuoteGet.mockReturnValue(undefined);
});

describe("HedgeQueue.runSweep()", () => {
  it("creates a HedgeOrder row for a symbol crossing the threshold", async () => {
    mockGetAll.mockReturnValue([snapshot({ symbol: "EURUSD", netNotional: 1_400_000, netPct: 70 })]);
    const mockProvider = { providerId: "TEST_PROVIDER", isConfigured: false, placeHedgeOrder: vi.fn().mockResolvedValue({ status: "REJECTED", reason: "no provider" }) };
    const queue = new HedgeQueue(mockProvider);

    const result = await queue.runSweep();

    expect(result).toEqual({ evaluated: 1, queued: 1 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.symbol).toBe("EURUSD");
    expect(data.side).toBe("BUY");
    expect(data.status).toBe("REJECTED");
    expect(data.providerId).toBe("TEST_PROVIDER");
  });

  it("skips symbols below the threshold entirely — no provider call, no row", async () => {
    mockGetAll.mockReturnValue([snapshot({ symbol: "EURUSD", netNotional: 100_000, netPct: 10 })]);
    const mockProvider = { providerId: "TEST_PROVIDER", isConfigured: false, placeHedgeOrder: vi.fn() };
    const queue = new HedgeQueue(mockProvider);

    const result = await queue.runSweep();

    expect(result).toEqual({ evaluated: 1, queued: 0 });
    expect(mockProvider.placeHedgeOrder).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("skips a symbol that already has an unresolved (SUBMITTED) HedgeOrder", async () => {
    mockGetAll.mockReturnValue([snapshot({ symbol: "EURUSD", netNotional: 1_400_000, netPct: 70 })]);
    mockFindFirst.mockResolvedValue({ id: "existing-hedge-order", status: "SUBMITTED" });
    const mockProvider = { providerId: "TEST_PROVIDER", isConfigured: false, placeHedgeOrder: vi.fn() };
    const queue = new HedgeQueue(mockProvider);

    const result = await queue.runSweep();

    expect(result).toEqual({ evaluated: 1, queued: 0 });
    expect(mockProvider.placeHedgeOrder).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("derives quantity from the live quote's mid price when available", async () => {
    mockGetAll.mockReturnValue([snapshot({ symbol: "EURUSD", netNotional: 108_700, netPct: 65 })]);
    mockQuoteGet.mockReturnValue({ symbol: "EURUSD", bid: 1.0868, ask: 1.0870, mid: 1.0870 });
    const mockProvider = { providerId: "TEST_PROVIDER", isConfigured: false, placeHedgeOrder: vi.fn().mockResolvedValue({ status: "REJECTED", reason: "x" }) };
    const queue = new HedgeQueue(mockProvider);

    await queue.runSweep();

    const data = mockCreate.mock.calls[0][0].data;
    expect(data.quantity).toBeCloseTo(108_700 / 1.0870, 4);
  });

  it("leaves quantity undefined (never fabricates a price) when no quote is available", async () => {
    mockGetAll.mockReturnValue([snapshot({ symbol: "EURUSD", netNotional: 1_400_000, netPct: 70 })]);
    mockQuoteGet.mockReturnValue(undefined);
    const mockProvider = { providerId: "TEST_PROVIDER", isConfigured: false, placeHedgeOrder: vi.fn().mockResolvedValue({ status: "REJECTED", reason: "x" }) };
    const queue = new HedgeQueue(mockProvider);

    await queue.runSweep();

    const data = mockCreate.mock.calls[0][0].data;
    expect(data.quantity).toBeNull();
  });

  it("persists a SUBMITTED result with its externalRef when the provider accepts", async () => {
    mockGetAll.mockReturnValue([snapshot({ symbol: "EURUSD", netNotional: 1_400_000, netPct: 70 })]);
    const mockProvider = { providerId: "REAL_LP", isConfigured: true, placeHedgeOrder: vi.fn().mockResolvedValue({ status: "SUBMITTED", externalRef: "lp-order-123" }) };
    const queue = new HedgeQueue(mockProvider);

    await queue.runSweep();

    const data = mockCreate.mock.calls[0][0].data;
    expect(data.status).toBe("SUBMITTED");
    expect(data.externalRef).toBe("lp-order-123");
  });

  it("one symbol's failure does not abort the sweep for the rest", async () => {
    mockGetAll.mockReturnValue([
      snapshot({ symbol: "EURUSD", netNotional: 1_400_000, netPct: 70 }),
      snapshot({ symbol: "XAUUSD", netNotional: 900_000, netPct: 80 }),
    ]);
    mockFindFirst
      .mockRejectedValueOnce(new Error("DB blip for EURUSD"))
      .mockResolvedValueOnce(null);
    const mockProvider = { providerId: "TEST_PROVIDER", isConfigured: false, placeHedgeOrder: vi.fn().mockResolvedValue({ status: "REJECTED", reason: "x" }) };
    const queue = new HedgeQueue(mockProvider);

    const result = await queue.runSweep();

    expect(result.evaluated).toBe(2);
    expect(result.queued).toBe(1); // only XAUUSD succeeded
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("no-ops entirely when the DB is not persistent", async () => {
    mockIsPersistent.value = false;
    mockGetAll.mockReturnValue([snapshot({ symbol: "EURUSD", netNotional: 1_400_000, netPct: 70 })]);
    const mockProvider = { providerId: "TEST_PROVIDER", isConfigured: false, placeHedgeOrder: vi.fn() };
    const queue = new HedgeQueue(mockProvider);

    const result = await queue.runSweep();

    expect(result).toEqual({ evaluated: 0, queued: 0 });
    expect(mockGetAll).not.toHaveBeenCalled();
    expect(mockProvider.placeHedgeOrder).not.toHaveBeenCalled();
  });
});
