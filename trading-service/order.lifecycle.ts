import { randomUUID }  from "node:crypto";
import { Decimal }     from "@prisma/client/runtime/library";
import { prisma }      from "../shared/db.js";
import type { LifecycleEvent, OrderStatus, OrderFillRecord } from "../shared/contracts.js";

/**
 * Thrown when an order with the same (userId, clientOrderId) already exists.
 * statusCode=409 so the HTTP layer returns the correct status code.
 */
export class DuplicateOrderError extends Error {
  statusCode = 409;
  constructor(public readonly existingOrder: Record<string, unknown>) {
    super("DUPLICATE_ORDER: clientOrderId already used for this account");
    this.name = "DuplicateOrderError";
  }
}

/** Prisma unique-constraint violation code. */
function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null &&
    "code" in err && (err as { code: string }).code === "P2002"
  );
}

export class OrderLifecycle {
  /**
   * Persist a new order in RECEIVED status with the full risk-check result.
   */
  async create(params: {
    userId:          string;
    symbol:          string;
    side:            "BUY" | "SELL";
    type:            "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | "TRAILING_STOP";
    quantity:        number;
    requestedPrice?: number;
    leverage:        number;
    stopLoss?:       number;
    takeProfit?:     number;
    notional:        number;
    marginRequired:  number;
    clientOrderId?:  string;
    riskCheckResult: object;
  }) {
    const id = randomUUID();
    const lifecycle: LifecycleEvent[] = [{
      status:    "RECEIVED",
      timestamp: new Date().toISOString(),
      detail:    "Order received by OMS",
      actor:     "SYSTEM",
    }];

    try {
      return await prisma.order.create({
        data: {
          id,
          userId:          params.userId,
          symbol:          params.symbol.toUpperCase(),
          side:            params.side,
          type:            params.type,
          status:          "RECEIVED",
          quantity:        new Decimal(params.quantity),
          requestedPrice:  params.requestedPrice  ? new Decimal(params.requestedPrice)  : null,
          leverage:        params.leverage,
          stopLoss:        params.stopLoss   ? new Decimal(params.stopLoss)   : null,
          takeProfit:      params.takeProfit ? new Decimal(params.takeProfit) : null,
          notional:        new Decimal(params.notional),
          marginRequired:  new Decimal(params.marginRequired),
          clientOrderId:   params.clientOrderId ?? null,
          riskCheckResult: { ...params.riskCheckResult, lifecycle } as object,
        },
      });
    } catch (err) {
      // Unique constraint on (userId, clientOrderId): return the existing order.
      if (isPrismaUniqueViolation(err) && params.clientOrderId) {
        const existing = await prisma.order.findFirst({
          where: { userId: params.userId, clientOrderId: params.clientOrderId },
        });
        if (existing) {
          throw new DuplicateOrderError(existing as unknown as Record<string, unknown>);
        }
      }
      throw err;
    }
  }

  /**
   * Advance order to the next status, appending a lifecycle event.
   *
   * Uses a single $executeRaw JSONB-append UPDATE instead of the prior
   * findUnique + update (two round trips) to cut order critical-path latency.
   */
  async transition(
    orderId: string,
    toStatus: OrderStatus,
    detail:   string,
    actor:    LifecycleEvent["actor"] = "SYSTEM",
    extra?: {
      averageFillPrice?: number;
      rejectionReason?:  string;
      slippage?:         number;
      fees?:             number;
      filledAt?:         Date;
    },
  ): Promise<void> {
    const eventJson = JSON.stringify([{
      status:    toStatus,
      timestamp: new Date().toISOString(),
      detail,
      actor,
    }]);

    if (extra?.averageFillPrice !== undefined) {
      // FILLED transition — update status, lifecycle, and fill-specific fields
      await prisma.$executeRaw`
        UPDATE "Order" SET
          status = ${toStatus},
          "riskCheckResult" = jsonb_set(
            COALESCE("riskCheckResult", '{}'),
            '{lifecycle}',
            COALESCE("riskCheckResult"->'lifecycle', '[]') || ${eventJson}::jsonb
          ),
          "averageFillPrice" = ${new Decimal(extra.averageFillPrice)},
          slippage           = ${new Decimal(extra.slippage ?? 0)},
          fees               = ${new Decimal(extra.fees ?? 0)},
          "filledAt"         = ${extra.filledAt ?? new Date()}
        WHERE id = ${orderId}
      `;
    } else if (extra?.rejectionReason) {
      // REJECTED transition — update status, lifecycle, and rejection reason
      await prisma.$executeRaw`
        UPDATE "Order" SET
          status = ${toStatus},
          "riskCheckResult" = jsonb_set(
            COALESCE("riskCheckResult", '{}'),
            '{lifecycle}',
            COALESCE("riskCheckResult"->'lifecycle', '[]') || ${eventJson}::jsonb
          ),
          "rejectionReason" = ${extra.rejectionReason}
        WHERE id = ${orderId}
      `;
    } else {
      // ACCEPTED or other transitions — status + lifecycle only
      await prisma.$executeRaw`
        UPDATE "Order" SET
          status = ${toStatus},
          "riskCheckResult" = jsonb_set(
            COALESCE("riskCheckResult", '{}'),
            '{lifecycle}',
            COALESCE("riskCheckResult"->'lifecycle', '[]') || ${eventJson}::jsonb
          )
        WHERE id = ${orderId}
      `;
    }
  }

  async rejectOrder(orderId: string, reason: string): Promise<void> {
    await this.transition(orderId, "REJECTED", reason, "RISK", {
      rejectionReason: reason,
    });
  }

  /**
   * Creates a Position record linked to the filled order.
   * Returns the new positionId.
   */
  async createPosition(params: {
    orderId:     string;
    userId:      string;
    symbol:      string;
    side:        "BUY" | "SELL";
    quantity:    number;
    entryPrice:  number;
    markPrice:   number;
    marginUsed:  number;
    leverage:    number;
    stopLoss?:   number;
    takeProfit?: number;
  }): Promise<string> {
    const id = randomUUID();

    await prisma.position.create({
      data: {
        id,
        orderId:    params.orderId,
        userId:     params.userId,
        symbol:     params.symbol.toUpperCase(),
        side:       params.side,
        quantity:   new Decimal(params.quantity),
        entryPrice: new Decimal(params.entryPrice),
        markPrice:  new Decimal(params.markPrice),
        marginUsed: new Decimal(params.marginUsed),
        leverage:   params.leverage,
        stopLoss:   params.stopLoss   ? new Decimal(params.stopLoss)   : null,
        takeProfit: params.takeProfit ? new Decimal(params.takeProfit) : null,
        status:     "OPEN",
        pnl:        new Decimal(0),
        pnlPercent: new Decimal(0),
      },
    });

    return id;
  }

  async getLifecycle(orderId: string): Promise<LifecycleEvent[]> {
    const order = await prisma.order.findUnique({
      where:  { id: orderId },
      select: { riskCheckResult: true },
    });
    const meta = order?.riskCheckResult as { lifecycle?: LifecycleEvent[] } | null;
    return meta?.lifecycle ?? [];
  }

  /**
   * Record an individual fill leg in the Fill table.
   *
   * Called once per execution (full fill = 1 row; partial fill = 1 row per leg).
   * Fire-and-forget is NOT used here — Fill rows are financial records and must
   * be durable before the execution result is returned to the caller.
   */
  async createFill(params: {
    orderId:           string;
    positionId:        string | null;
    quantity:          number;
    price:             number;
    liquidityProvider: string;
    slippage:          number;
    fees:              number;
  }): Promise<OrderFillRecord> {
    const id = randomUUID();
    const now = new Date();

    await prisma.$executeRaw`
      INSERT INTO "Fill"
        ("id","orderId","positionId","quantity","price","liquidityProvider","slippage","fees","createdAt")
      VALUES
        (${id}, ${params.orderId}, ${params.positionId ?? null},
         ${new Decimal(params.quantity)}, ${new Decimal(params.price)},
         ${params.liquidityProvider},
         ${new Decimal(params.slippage)}, ${new Decimal(params.fees)},
         ${now})
    `;

    return {
      id,
      orderId:           params.orderId,
      positionId:        params.positionId,
      quantity:          params.quantity,
      price:             params.price,
      liquidityProvider: params.liquidityProvider,
      slippage:          params.slippage,
      fees:              params.fees,
      createdAt:         now,
    };
  }

  /**
   * Atomically increment Order.filledQuantity and return the updated totals.
   *
   * Uses a raw UPDATE … RETURNING so the increment and the read are one
   * round trip under the default ReadCommitted isolation (sufficient here —
   * the execution queue serializes per-user so concurrent increments for the
   * same order cannot occur on the B-book path).
   *
   * Returns { newFilledQty, originalQty } so the caller can determine whether
   * the order is now fully filled (newFilledQty >= originalQty).
   */
  async incrementFilledQuantity(
    orderId:    string,
    addedQty:   number,
  ): Promise<{ newFilledQty: number; originalQty: number }> {
    const rows = await prisma.$queryRaw<Array<{ filledQty: string; qty: string }>>`
      UPDATE "Order"
      SET "filledQuantity" = "filledQuantity" + ${new Decimal(addedQty)}
      WHERE id = ${orderId}
      RETURNING "filledQuantity" AS "filledQty", quantity AS qty
    `;

    if (!rows[0]) throw new Error(`Order ${orderId} not found during filledQuantity increment`);

    return {
      newFilledQty: parseFloat(rows[0].filledQty),
      originalQty:  parseFloat(rows[0].qty),
    };
  }
}

export const orderLifecycle = new OrderLifecycle();
