/**
 * Manual Position Close Service
 *
 * Endpoint:  POST /api/v1/trading/position/:id/close
 *
 * Flow:
 *   Ownership check → price resolve → SettlementEngine (atomic) → response
 *
 * Settlement logic has moved to settlement/settlement.engine.ts.
 * This module is now a thin orchestrator: auth check, price lookup, delegate.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }              from "../events-bus/event.bus.js";
import { quoteCache }            from "../market-data/quote.cache.js";
import { settlementEngine }      from "../settlement/settlement.engine.js";
import { LiquidityProvider } from "../liquidity-engine/liquidity.provider.js";
import type { BrokerState }      from "../shared/state.js";

export type CloseResult =
  | { ok: true;  positionId: string; symbol: string; pnl: number; exitPrice: number; netCredit: number }
  | { ok: false; reason: string };

export async function closePosition(
  positionId: string,
  userId:     string,
  state:      BrokerState,
): Promise<CloseResult> {
  if (IS_PERSISTENT && prisma?.position) {
    return closePositionDb(positionId, userId);
  }
  return closePositionMemory(positionId, userId, state);
}

// ─── Database-backed close ────────────────────────────────────────────────────

async function closePositionDb(
  positionId: string,
  userId:     string,
): Promise<CloseResult> {
  const pos = await (prisma as NonNullable<typeof prisma>).position.findUnique({
    where:  { id: positionId },
    select: {
      id:         true,
      userId:     true,
      symbol:     true,
      side:       true,
      quantity:   true,
      entryPrice: true,
      marginUsed: true,
      leverage:   true,
      status:     true,
      openedAt:   true,
    },
  });

  if (!pos)                  return { ok: false, reason: "POSITION_NOT_FOUND" };
  if (pos.userId !== userId) return { ok: false, reason: "UNAUTHORIZED" };
  if (pos.status !== "OPEN") return { ok: false, reason: `POSITION_ALREADY_${pos.status}` };

  const quote = quoteCache.get(pos.symbol);
  if (!quote) return { ok: false, reason: "NO_PRICE_AVAILABLE" };

  const closeSide = pos.side === "BUY" ? "SELL" : "BUY";
  const qty       = pos.quantity.toNumber();

  const book      = LiquidityProvider.buildBook({
    symbol:    pos.symbol,
    bid:       quote.bid,
    ask:       quote.ask,
    mid:       quote.mid,
    spread:    quote.spread,
    changePct: quote.changePct ?? 0,
  });
  const sim       = LiquidityProvider.calculateFillFromBook(book, closeSide, qty);
  const exitPrice = sim.averagePrice;

  const result = await settlementEngine.settle({
    positionId,
    userId,
    symbol:     pos.symbol,
    side:       pos.side as "BUY" | "SELL",
    quantity:   qty,
    entryPrice: pos.entryPrice.toNumber(),
    exitPrice,
    marginUsed: pos.marginUsed.toNumber(),
    leverage:   pos.leverage,
    openedAt:   pos.openedAt,
    reason:     "MANUAL",
    detail:     "Client-initiated manual position close",
  });

  return {
    ok:         true,
    positionId,
    symbol:     pos.symbol,
    pnl:        result.cappedPnl,
    exitPrice,
    netCredit:  result.netCredit,
  };
}

// ─── In-memory (sandbox) close ────────────────────────────────────────────────

async function closePositionMemory(
  positionId: string,
  userId:     string,
  state:      BrokerState,
): Promise<CloseResult> {
  const result = state.closePositionInMemory(positionId, userId);
  if (!result.ok) return result;

  const ts = new Date().toISOString();

  eventBus.emit("position.closed", {
    positionId,
    userId,
    symbol:    result.symbol,
    side:      result.side ?? "BUY",
    quantity:  result.quantity ?? 0,
    entryPrice: result.entryPrice ?? 0,
    exitPrice: result.exitPrice,
    pnl:       result.pnl,
    timestamp: ts,
  });

  return { ok: true, positionId, symbol: result.symbol, pnl: result.pnl, exitPrice: result.exitPrice, netCredit: result.pnl };
}
