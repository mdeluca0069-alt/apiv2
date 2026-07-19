/**
 * ledger.service.swap.history.spec.ts
 *
 * LEDGER_FREEZE.md §3 (open question, resolved 2026-07-19) — swap accrual's
 * richer per-position detail (nights, annualised rate, position/symbol
 * breakdown) was only reachable via the generic ledger query filtered to
 * type=SWAP, which exposes only the flat LedgerEntry shape. LedgerService
 * .getSwapHistory() is a dedicated History surface directly over the
 * SwapAccrual table.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockCount, mockFindMany, mockAggregate } = vi.hoisted(() => ({
  mockCount:    vi.fn(),
  mockFindMany: vi.fn(),
  mockAggregate: vi.fn(),
}));
vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: { swapAccrual: { count: mockCount, findMany: mockFindMany, aggregate: mockAggregate } },
}));

const { ledgerService } = await import("../wallet-service/ledger.service.js");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "swap-1", positionId: "pos-1", symbol: "EURUSD", side: "BUY",
    swapAmount: new Decimal(-2.5), swapRateAnnual: new Decimal(3.2),
    nights: 1, accrualDate: new Date("2026-07-15T00:00:00Z"),
    createdAt: new Date("2026-07-15T22:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCount.mockResolvedValue(0);
  mockFindMany.mockResolvedValue([]);
  mockAggregate.mockResolvedValue({ _sum: { swapAmount: null } });
});

describe("LedgerService.getSwapHistory()", () => {
  it("returns paginated swap accrual rows with the real per-position detail", async () => {
    mockCount.mockResolvedValue(1);
    mockFindMany.mockResolvedValue([row()]);
    mockAggregate.mockResolvedValue({ _sum: { swapAmount: new Decimal(-2.5) } });

    const page = await ledgerService.getSwapHistory({ userId: "user-1" });

    expect(page.totalCount).toBe(1);
    expect(page.totalSwapUsd).toBeCloseTo(-2.5, 8);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      id: "swap-1", positionId: "pos-1", symbol: "EURUSD", side: "BUY",
      swapAmount: -2.5, swapRateAnnual: 3.2, nights: 1, accrualDate: "2026-07-15",
    });
  });

  it("filters by userId, positionId, and symbol", async () => {
    await ledgerService.getSwapHistory({ userId: "user-1", positionId: "pos-1", symbol: "EURUSD" });

    const where = mockFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: "user-1", positionId: "pos-1", symbol: "EURUSD" });
  });

  it("filters by accrualDate range when from/to are given", async () => {
    const from = new Date("2026-07-01T00:00:00Z");
    const to   = new Date("2026-07-31T00:00:00Z");

    await ledgerService.getSwapHistory({ userId: "user-1", from, to });

    const where = mockFindMany.mock.calls[0][0].where as { accrualDate: { gte: Date; lte: Date } };
    expect(where.accrualDate.gte).toBe(from);
    expect(where.accrualDate.lte).toBe(to);
  });

  it("respects the 500-row cap on limit", async () => {
    await ledgerService.getSwapHistory({ userId: "user-1", limit: 10_000 });

    expect(mockFindMany.mock.calls[0][0].take).toBe(500);
  });

  it("returns an empty page in sandbox mode without touching the DB", async () => {
    vi.resetModules();
    vi.doMock("../shared/db.js", () => ({ IS_PERSISTENT: false, prisma: undefined }));
    const { ledgerService: sandboxService } = await import("../wallet-service/ledger.service.js");

    const page = await sandboxService.getSwapHistory({ userId: "user-1" });

    expect(page).toEqual({ entries: [], totalCount: 0, totalSwapUsd: 0, pageSize: 50, offset: 0 });
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
