/**
 * OrderCancelService — cancel a pending (non-filled) order.
 *
 * Endpoint:  DELETE /api/v1/trading/order/:id
 *
 * Rules:
 *   - Only orders in RECEIVED, RISK_REVIEW, ACCEPTED states can be cancelled.
 *   - FILLED and REJECTED orders cannot be cancelled.
 *   - Position close uses POST /trading/position/:id/close, not this service.
 *
 * Persistence:
 *   - Persistent: updates Order status to CANCELLED + AuditLog
 *   - Sandbox: updates in-memory order Map
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { immutableAudit } from "../security/immutable.audit.js";
import { eventBus }        from "../events-bus/event.bus.js";
import { outboxService }   from "../realtime-infra/outbox.service.js";
import type { BrokerState } from "../shared/state.js";

const CANCELLABLE = new Set(["RECEIVED", "RISK_REVIEW", "ACCEPTED"]);

export type CancelResult =
  | { ok: true;  orderId: string; previousStatus: string }
  | { ok: false; reason: string };

export async function cancelOrder(
  orderId: string,
  userId:  string,
  state:   BrokerState,
): Promise<CancelResult> {
  if (IS_PERSISTENT && prisma?.order) {
    return cancelOrderDb(orderId, userId);
  }
  return cancelOrderMemory(orderId, userId, state);
}

// ─── Database-backed cancel ───────────────────────────────────────────────────

async function cancelOrderDb(orderId: string, userId: string): Promise<CancelResult> {
  const order = await (prisma as NonNullable<typeof prisma>).order.findUnique({
    where:  { id: orderId },
    select: { userId: true, status: true },
  });

  if (!order)                       return { ok: false, reason: "ORDER_NOT_FOUND" };
  if (order.userId !== userId)      return { ok: false, reason: "UNAUTHORIZED" };
  if (!CANCELLABLE.has(order.status)) {
    return { ok: false, reason: `CANNOT_CANCEL_${order.status}_ORDER` };
  }

  await (prisma as NonNullable<typeof prisma>).$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data:  { status: "CANCELLED" },
    });

    await immutableAudit.write({
      actor:   userId,
      action:  "trading.order_cancelled",
      entity:  orderId,
      payload: { orderId, previousStatus: order.status } as object,
    }, tx);
  }, { maxWait: 10000, timeout: 15000 });

  const ts = new Date().toISOString();
  const payload = { orderId, userId, status: "CANCELLED", previousStatus: order.status, timestamp: ts };

  void outboxService.enqueue("order.cancelled", payload as Record<string, unknown>, userId);

  eventBus.emit("order.cancelled", {
    orderId,
    userId,
    previousStatus: order.status,
    reason:    "CANCELLED",
    timestamp: ts,
  });

  return { ok: true, orderId, previousStatus: order.status };
}

// ─── In-memory (sandbox) cancel ───────────────────────────────────────────────

async function cancelOrderMemory(
  orderId: string,
  userId:  string,
  state:   BrokerState,
): Promise<CancelResult> {
  // PHASE C PENTEST (RBAC/IDOR): state.getOrders(userId) is already scoped
  // to the caller's own orders -- an orderId belonging to another user
  // simply won't be found here, matching cancelOrderDb()'s explicit
  // `order.userId !== userId` check above (404-style non-disclosure
  // instead of a separate 403, consistent with how NOT_FOUND is already
  // used for a missing id).
  const orders = state.getOrders(userId) as Array<{ id: string; status: string }>;
  const order  = orders.find((o) => o.id === orderId);

  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };
  if (!CANCELLABLE.has(order.status)) {
    return { ok: false, reason: `CANNOT_CANCEL_${order.status}_ORDER` };
  }

  // PHASE C PENTEST: updateOrderStatusInMemory() previously did not exist
  // on BrokerState at all -- this dynamic-dispatch check always evaluated
  // false, so the sandbox cancel path never actually updated order status
  // (silently a no-op beyond the event emission below). It's now a real
  // method (shared/state.ts), which also enforces ownership itself as a
  // second layer of defense.
  state.updateOrderStatusInMemory(orderId, userId, "CANCELLED");

  const ts = new Date().toISOString();
  eventBus.emit("order.cancelled", {
    orderId, userId, previousStatus: order.status, reason: "CANCELLED", timestamp: ts,
  });

  return { ok: true, orderId, previousStatus: order.status };
}
