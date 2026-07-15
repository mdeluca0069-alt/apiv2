/**
 * settlement.engine.nbp.spec.ts
 *
 * FASE 4.3 (Risk Engine, Bug #6) — Negative Balance Protection had two gaps:
 *
 *   1. pnl.calculator.ts's applyNBP() correctly capped raw P&L at
 *      -marginUsed, but settlement.engine.ts recomputed netCredit with its
 *      own independent inline formula (`cappedPnl - commission`, not even
 *      calling pnlCalculator.netCredit()) -- commission was subtracted
 *      AFTER the cap, unprotected, so a position already at the NBP floor
 *      could still debit the wallet for more than its own deposited
 *      margin once commission was included.
 *
 *   2. Even with (1) fixed, a client can still end up with a negative
 *      wallet balance in aggregate (several positions can each respect
 *      their own margin cap while the account's pre-existing balance was
 *      smaller than the sum of their margins) -- nothing detected or
 *      wrote this off anywhere; a negative balance just sat there.
 *
 * pnlCalculator and commissionCalculator are left UNMOCKED (pure math, no
 * I/O) so this exercises the real, just-fixed formulas end to end, not a
 * re-description of them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { mockQueryRaw, mockPositionUpdate, mockWalletUpdate, mockLedgerCreateMany, mockOutboxCreate } = vi.hoisted(() => ({
  mockQueryRaw:        vi.fn(),
  mockPositionUpdate:  vi.fn().mockResolvedValue({}),
  mockWalletUpdate:    vi.fn(),
  mockLedgerCreateMany: vi.fn().mockResolvedValue({}),
  mockOutboxCreate:    vi.fn().mockResolvedValue({ id: "outbox-1" }),
}));

const { mockDb } = vi.hoisted(() => {
  type Tx = {
    $queryRaw:   typeof mockQueryRaw;
    position:    { update: typeof mockPositionUpdate };
    walletAccount: { update: typeof mockWalletUpdate };
    ledgerEntry: { createMany: typeof mockLedgerCreateMany };
    outboxEvent: { create: typeof mockOutboxCreate };
  };
  const tx: Tx = {
    $queryRaw:   mockQueryRaw,
    position:    { update: mockPositionUpdate },
    walletAccount: { update: mockWalletUpdate },
    ledgerEntry: { createMany: mockLedgerCreateMany },
    outboxEvent: { create: mockOutboxCreate },
  };
  return {
    mockDb: {
      $transaction: vi.fn(async (fn: (tx: Tx) => Promise<unknown>) => fn(tx)),
    },
  };
});
vi.mock("../shared/db.js", () => ({ prisma: mockDb }));

vi.mock("../risk-service/exposure.limits.js", () => ({
  exposureRegistry: { closePosition: vi.fn(), openPosition: vi.fn() },
}));
vi.mock("../events-bus/event.bus.js", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("../gateway/metrics.js", () => ({ metrics: { inc: vi.fn(), observe: vi.fn() } }));
const { mockAlertSend } = vi.hoisted(() => ({ mockAlertSend: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { send: mockAlertSend, marginDiscrepancy: vi.fn().mockResolvedValue(undefined) },
}));

const { settlementEngine } = await import("../settlement/settlement.engine.js");
const { commissionCalculator } = await import("../trading-service/commission.calculator.js");

function decimalRow(n: number) {
  return String(n);
}

/** Sets up the two sequential $queryRaw calls settle() makes: position
 *  lock (status=OPEN), then wallet lock (returns `locked`). */
function mockLocks(locked: number) {
  mockQueryRaw
    .mockResolvedValueOnce([{ status: "OPEN" }])
    .mockResolvedValueOnce([{ locked: decimalRow(locked) }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPositionUpdate.mockResolvedValue({});
  mockLedgerCreateMany.mockResolvedValue({});
  mockOutboxCreate.mockResolvedValue({ id: "outbox-1" });
});

describe("SettlementEngine.settle() — NBP commission leak (Bug #6, part 1)", () => {
  it("netCredit never debits the wallet for more than the position's own margin, even after commission", async () => {
    const marginUsed = 200;
    mockLocks(marginUsed);
    mockWalletUpdate.mockResolvedValue({ balance: new Decimal(-marginUsed) }); // whatever DB "would" compute; overridden by write-off path if negative

    const result = await settlementEngine.settle({
      positionId: "pos-1", userId: "user-1", symbol: "EURUSD", side: "BUY",
      quantity: 10_000, entryPrice: 1.1000, exitPrice: 0.9000, // massive adverse move
      marginUsed, leverage: 10, openedAt: new Date(), reason: "STOP_OUT",
    });

    const expectedCommission = commissionCalculator.compute({ symbol: "EURUSD", quantity: 10_000, exitPrice: 0.9000 }).commission;
    expect(expectedCommission).toBeGreaterThan(0); // sanity: this scenario does incur a real commission

    expect(result.cappedPnl).toBe(-marginUsed); // rawPnl capped at -200 (unchanged behavior)
    // netCredit must NOT be more negative than -marginUsed despite commission > 0
    expect(result.netCredit).toBe(-marginUsed);
    expect(result.netCredit).toBeGreaterThanOrEqual(-marginUsed);
  });

  it("a small loss well within margin still deducts commission normally (fix does not over-protect)", async () => {
    mockLocks(1_000);
    mockWalletUpdate.mockResolvedValue({ balance: new Decimal(9_000) });

    const result = await settlementEngine.settle({
      positionId: "pos-2", userId: "user-1", symbol: "EURUSD", side: "BUY",
      quantity: 10_000, entryPrice: 1.0850, exitPrice: 1.0870, // small win
      marginUsed: 1_000, leverage: 10, openedAt: new Date(), reason: "MANUAL",
    });

    expect(result.rawPnl).toBeCloseTo(20, 4);
    expect(result.cappedPnl).toBeCloseTo(20, 4); // not capped
    expect(result.netCredit).toBeLessThan(result.cappedPnl); // commission still deducted
  });
});

describe("SettlementEngine.settle() — negative balance write-off (Bug #6, part 2)", () => {
  it("writes off a residual negative balance to zero with an audited NBP_WRITEOFF ledger entry", async () => {
    // Starting balance is thin ($50); this position's capped netCredit
    // (-200ish) would drive it negative even though the position's own
    // margin cap (200) was individually respected.
    mockLocks(200);
    // Prisma's `increment` on balance=50 by netCredit≈-20x lands the update
    // at a negative Decimal -- simulate exactly that as the update's return.
    mockWalletUpdate.mockResolvedValueOnce({ balance: new Decimal(-150) }); // first update: applies netCredit, goes negative
    mockWalletUpdate.mockResolvedValueOnce({ balance: new Decimal(0) });    // second update: write-off zeroes it

    const result = await settlementEngine.settle({
      positionId: "pos-3", userId: "user-1", symbol: "EURUSD", side: "BUY",
      quantity: 10_000, entryPrice: 1.1000, exitPrice: 0.9000,
      marginUsed: 200, leverage: 10, openedAt: new Date(), reason: "STOP_OUT",
    });

    expect(result.writeOffAmount).toBe(150);
    expect(result.newBalance.toNumber()).toBe(0);
    expect(mockWalletUpdate).toHaveBeenCalledTimes(2);
    expect(mockWalletUpdate.mock.calls[1][0].data.balance.toNumber()).toBe(0);

    // The 4th ledger leg (NBP_WRITEOFF) was created alongside PNL/COMMISSION/MARGIN_RELEASE.
    const ledgerRows = mockLedgerCreateMany.mock.calls[0][0].data as Array<{ type: string; amount: Decimal }>;
    const writeOffRow = ledgerRows.find((r) => r.type === "NBP_WRITEOFF");
    expect(writeOffRow).toBeDefined();
    expect(writeOffRow!.amount.toNumber()).toBe(150);

    // An alert was raised for visibility.
    expect(mockAlertSend).toHaveBeenCalledWith(expect.objectContaining({ type: "NBP_WRITEOFF" }));
  });

  it("does not write anything off when the resulting balance stays non-negative", async () => {
    mockLocks(1_000);
    mockWalletUpdate.mockResolvedValue({ balance: new Decimal(8_980) });

    const result = await settlementEngine.settle({
      positionId: "pos-4", userId: "user-1", symbol: "EURUSD", side: "BUY",
      quantity: 10_000, entryPrice: 1.0850, exitPrice: 1.0870,
      marginUsed: 1_000, leverage: 10, openedAt: new Date(), reason: "MANUAL",
    });

    expect(result.writeOffAmount).toBe(0);
    expect(mockWalletUpdate).toHaveBeenCalledTimes(1); // no second (write-off) update call
    const ledgerRows = mockLedgerCreateMany.mock.calls[0][0].data as Array<{ type: string }>;
    expect(ledgerRows.find((r) => r.type === "NBP_WRITEOFF")).toBeUndefined();
    expect(mockAlertSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: "NBP_WRITEOFF" }));
  });
});
