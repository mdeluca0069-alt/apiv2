/**
 * balance.calculator.spec.ts
 *
 * FASE 4.2 — BalanceCalculator was previously dead code (correct formula,
 * zero callers) and independently reimplemented the bid/ask-side P&L
 * formula instead of delegating to pnl.calculator.ts's canonical
 * unrealized(), despite its own header comment claiming to be a consumer
 * of it. Now wired into ledger.engine.ts's withdrawal checks (FASE 4.1) and
 * delegates its formula to pnlCalculator (FASE 4.2 cleanup) -- this locks
 * in both behaviors.
 */
import { describe, it, expect } from "vitest";
import { BalanceCalculator } from "../wallet-service/balance.calculator.js";

function decimalLike(n: number) {
  return { toNumber: () => n, valueOf: () => n };
}

function makeMockDb(balance: number, locked: number, positions: Array<{ symbol: string; side: "BUY" | "SELL"; quantity: number; entryPrice: number }>) {
  return {
    walletAccount: {
      findUnique: async () => ({ balance: decimalLike(balance), locked: decimalLike(locked), currency: "USD" }),
    },
    position: {
      findMany: async () => positions.map((p) => ({
        symbol: p.symbol, side: p.side, quantity: decimalLike(p.quantity), entryPrice: decimalLike(p.entryPrice),
      })),
    },
  } as never;
}

describe("BalanceCalculator.compute()", () => {
  it("computes equity/freeMargin/marginLevel from live quotes via the canonical pnlCalculator formula", async () => {
    const db = makeMockDb(10_000, 3_000, [{ symbol: "EURUSD", side: "BUY", quantity: 100_000, entryPrice: 1.0600 }]);
    const calc = new BalanceCalculator(db);

    const snapshot = await calc.compute("user-1", [{ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 }]);

    expect(snapshot.unrealizedPnL).toBeCloseTo(-6_000, 2); // BUY valued at bid
    expect(snapshot.equity).toBeCloseTo(4_000, 2);
    expect(snapshot.freeMargin).toBeCloseTo(1_000, 2);
    expect(snapshot.marginLevel).toBeCloseTo((4_000 / 3_000) * 100, 1);
  });

  it("SELL positions are valued at ask", async () => {
    const db = makeMockDb(10_000, 1_000, [{ symbol: "EURUSD", side: "SELL", quantity: 100_000, entryPrice: 1.0600 }]);
    const calc = new BalanceCalculator(db);

    const snapshot = await calc.compute("user-1", [{ symbol: "EURUSD", bid: 1.0500, ask: 1.0700, mid: 1.0600 }]);

    // (entry - ask) * qty = (1.0600 - 1.0700) * 100000 = -1000
    expect(snapshot.unrealizedPnL).toBeCloseTo(-1_000, 2);
  });

  it("a position with no matching quote contributes zero", async () => {
    const db = makeMockDb(5_000, 0, [{ symbol: "GBPUSD", side: "BUY", quantity: 10_000, entryPrice: 1.25 }]);
    const calc = new BalanceCalculator(db);

    const snapshot = await calc.compute("user-1", []); // no quotes supplied

    expect(snapshot.unrealizedPnL).toBe(0);
    expect(snapshot.equity).toBe(5_000);
  });

  it("freeMargin never goes negative in the returned snapshot", async () => {
    const db = makeMockDb(1_000, 500, [{ symbol: "EURUSD", side: "BUY", quantity: 100_000, entryPrice: 1.5000 }]);
    const calc = new BalanceCalculator(db);

    const snapshot = await calc.compute("user-1", [{ symbol: "EURUSD", bid: 1.0000, ask: 1.0002, mid: 1.0001 }]);

    expect(snapshot.freeMargin).toBe(0);
  });
});
