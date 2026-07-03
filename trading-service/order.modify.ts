/**
 * Order Modification Service — Modify SL/TP on an open position
 *
 * Endpoint:  PUT /api/v1/trading/order/:id
 *
 * Validation:
 *  - Position must be OPEN and owned by the requesting user
 *  - New SL must be below entry for BUY, above entry for SELL
 *  - New TP must be above entry for BUY, below entry for SELL
 *  - Both fields are optional — send only the one being modified
 *
 * Persistence:
 *  - Persistent mode: updates Position row in DB + audit log
 *  - Sandbox mode:    updates in-memory position Map
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }               from "../events-bus/event.bus.js";
import { randomUUID }             from "node:crypto";
import { Decimal }                from "@prisma/client/runtime/library";
import type { BrokerState }       from "../shared/state.js";

export type ModifyRequest = {
  positionId: string;
  userId:     string;
  stopLoss?:  number;
  takeProfit?: number;
};

export type ModifyResult =
  | { ok: true;  positionId: string; stopLoss?: number; takeProfit?: number }
  | { ok: false; reason: string };

export async function modifyOrderSlTp(
  req:   ModifyRequest,
  state: BrokerState,
): Promise<ModifyResult> {

  if (IS_PERSISTENT && prisma?.position) {
    return modifyDb(req);
  }
  return modifyMemory(req, state);
}

// ─── Database-backed modify ───────────────────────────────────────────────────

async function modifyDb(req: ModifyRequest): Promise<ModifyResult> {
  const { positionId, userId, stopLoss, takeProfit } = req;

  if (stopLoss === undefined && takeProfit === undefined) {
    return { ok: false, reason: "NO_MODIFICATION_REQUESTED" };
  }

  const pos = await prisma.position.findUnique({
    where:  { id: positionId },
    select: { userId: true, side: true, entryPrice: true, status: true },
  });

  if (!pos)                     return { ok: false, reason: "POSITION_NOT_FOUND" };
  if (pos.userId !== userId)    return { ok: false, reason: "UNAUTHORIZED" };
  if (pos.status !== "OPEN")    return { ok: false, reason: `POSITION_${pos.status}` };

  const entry = pos.entryPrice.toNumber();

  // Risk validation
  if (stopLoss !== undefined) {
    if (pos.side === "BUY"  && stopLoss >= entry) return { ok: false, reason: "SL_MUST_BE_BELOW_ENTRY_FOR_BUY" };
    if (pos.side === "SELL" && stopLoss <= entry) return { ok: false, reason: "SL_MUST_BE_ABOVE_ENTRY_FOR_SELL" };
    if (stopLoss <= 0)                             return { ok: false, reason: "INVALID_STOP_LOSS" };
  }

  if (takeProfit !== undefined) {
    if (pos.side === "BUY"  && takeProfit <= entry) return { ok: false, reason: "TP_MUST_BE_ABOVE_ENTRY_FOR_BUY" };
    if (pos.side === "SELL" && takeProfit >= entry) return { ok: false, reason: "TP_MUST_BE_BELOW_ENTRY_FOR_SELL" };
    if (takeProfit <= 0)                             return { ok: false, reason: "INVALID_TAKE_PROFIT" };
  }

  // Apply changes
  const updateData: Record<string, unknown> = {};
  if (stopLoss  !== undefined) updateData.stopLoss   = new Decimal(stopLoss);
  if (takeProfit !== undefined) updateData.takeProfit = new Decimal(takeProfit);

  await prisma.$transaction(async (tx) => {
    await tx.position.update({
      where: { id: positionId },
      data:  updateData as Parameters<typeof tx.position.update>[0]["data"],
    });

    await tx.auditLog.create({
      data: {
        id:        randomUUID(),
        actor:     userId,
        action:    "trading.order_modify",
        entity:    positionId,
        payload:   { positionId, stopLoss, takeProfit } as object,
        createdAt: new Date(),
      },
    });
  }, { maxWait: 10000, timeout: 15000 });

  // Notify via WebSocket
  eventBus.emit("order.status_changed" as any, {
    orderId:    positionId,
    userId,
    status:     "MODIFIED",
    stopLoss,
    takeProfit,
    timestamp:  new Date().toISOString(),
  });

  return { ok: true, positionId, stopLoss, takeProfit };
}

// ─── In-memory (sandbox) modify ───────────────────────────────────────────────

function modifyMemory(req: ModifyRequest, state: BrokerState): ModifyResult {
  const { positionId, userId, stopLoss, takeProfit } = req;

  if (stopLoss === undefined && takeProfit === undefined) {
    return { ok: false, reason: "NO_MODIFICATION_REQUESTED" };
  }

  const result = state.modifyPositionSlTp(positionId, userId, stopLoss, takeProfit);
  if (!result.ok) return result;

  eventBus.emit("order.status_changed" as any, {
    orderId:    positionId,
    userId,
    status:     "MODIFIED",
    stopLoss,
    takeProfit,
    timestamp:  new Date().toISOString(),
  });

  return { ok: true, positionId, stopLoss, takeProfit };
}
