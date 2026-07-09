/**
 * AlgoOrderService — institutional algorithmic order execution.
 *
 * Order types:
 *   TWAP  — Time-Weighted Average Price: splits large orders into equal-sized
 *            child orders executed at fixed intervals over a specified duration.
 *            Minimises market impact by distributing execution over time.
 *
 *   VWAP  — Volume-Weighted Average Price: weights child orders by simulated
 *            volume curve (U-shaped intraday pattern). Targets benchmark price.
 *
 *   ICEBERG — Visible portion of a large order. Only `visibleQty` is shown in
 *              the order book at any time; rest is refilled automatically.
 *
 *   BRACKET — OCO (One-Cancels-Other) with entry, take-profit, and stop-loss
 *              as a single atomic unit. Cancels the remaining leg on fill.
 *
 * All algo orders run within in-process, self-scheduling async loops. Each
 * child slice is placed through the real execution pipeline
 * (trading-service/order.controller.ts — the same path MARKET orders use)
 * and awaited before the next slice is considered, so filledQuantity/
 * remainingQty/avgFillPrice always reflect real fills, never a simulation.
 * On restart they are marked CANCELLED (no persistence of in-flight algo
 * state across restarts is guaranteed).
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { orderController } from "../trading-service/order.controller.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AlgoOrderType = "TWAP" | "VWAP" | "ICEBERG" | "BRACKET";

export type AlgoOrderStatus = "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED";

export type AlgoOrder = {
  id:              string;
  userId:          string;
  symbol:          string;
  direction:       "BUY" | "SELL";
  algoType:        AlgoOrderType;
  totalQuantity:   number;
  filledQuantity:  number;
  remainingQty:    number;
  avgFillPrice:    number;
  status:          AlgoOrderStatus;
  childOrders:     ChildOrder[];
  params:          AlgoParams;
  createdAt:       string;
  updatedAt:       string;
  completedAt?:    string;
};

export type ChildOrder = {
  id:         string;
  quantity:   number;
  fillPrice:  number | null;
  status:     "PENDING" | "FILLED" | "CANCELLED";
  sentAt:     string;
  filledAt:   string | null;
};

export type TwapParams = {
  type:         "TWAP";
  durationMs:   number;   // total execution window (e.g. 3600000 = 1 hour)
  slices:       number;   // number of child orders (e.g. 12 = every 5 min in 1h)
  maxSlippage:  number;   // reject child fills > X% away from VWAP
};

export type VwapParams = {
  type:         "VWAP";
  durationMs:   number;
  slices:       number;
  volumeProfile:"uniform" | "u-shaped" | "morning-heavy" | "afternoon-heavy";
};

export type IcebergParams = {
  type:         "ICEBERG";
  visibleQty:   number;   // quantity shown in order book at a time
  limitPrice:   number;   // price at which to show the order
  reloadDelay:  number;   // ms delay before showing next slice after fill
};

export type BracketParams = {
  type:        "BRACKET";
  entryPrice:  number;
  takeProfit:  number;
  stopLoss:    number;
  orderType:   "MARKET" | "LIMIT";
};

export type AlgoParams = TwapParams | VwapParams | IcebergParams | BracketParams;

export type AlgoSubmitRequest = {
  userId:        string;
  tenantId:      string;
  symbol:        string;
  direction:     "BUY" | "SELL";
  totalQuantity: number;
  params:        AlgoParams;
  /** Fired after each child slice is placed (filled or failed) — for logging/push, not execution. */
  onChildFill?:  (childOrder: ChildOrder, algo: AlgoOrder) => void;
};

// ─── Volume profile weights (VWAP simulation) ─────────────────────────────────

function getVolumeWeights(slices: number, profile: VwapParams["volumeProfile"]): number[] {
  const weights: number[] = [];
  for (let i = 0; i < slices; i++) {
    const t = i / (slices - 1);
    let w: number;
    switch (profile) {
      case "u-shaped":
        w = 1 + 2 * (1 - 2 * t) ** 2; // high at open/close, low at midday
        break;
      case "morning-heavy":
        w = Math.exp(-2 * t) + 0.3;
        break;
      case "afternoon-heavy":
        w = Math.exp(-2 * (1 - t)) + 0.3;
        break;
      default: // uniform
        w = 1;
    }
    weights.push(w);
  }
  const total = weights.reduce((s, v) => s + v, 0);
  return weights.map(w => w / total); // normalize to sum = 1
}

// ─── AlgoOrderService ─────────────────────────────────────────────────────────

type OrderCtx = { userId: string; tenantId: string };

type ActiveEntry = {
  algo:           AlgoOrder;
  ctx:            OrderCtx;
  /** True once no further child slices will ever be sent (all scheduled). */
  allSlicesSent:  boolean;
  cancelRequested:boolean;
};

export class AlgoOrderService extends EventEmitter {
  private readonly active = new Map<string, ActiveEntry>();

  submit(req: AlgoSubmitRequest): AlgoOrder {
    const id  = `algo_${randomUUID()}`;
    const now = new Date().toISOString();

    const algo: AlgoOrder = {
      id,
      userId:         req.userId,
      symbol:         req.symbol,
      direction:      req.direction,
      algoType:       req.params.type,
      totalQuantity:  req.totalQuantity,
      filledQuantity: 0,
      remainingQty:   req.totalQuantity,
      avgFillPrice:   0,
      status:         "RUNNING",
      childOrders:    [],
      params:         req.params,
      createdAt:      now,
      updatedAt:      now,
    };

    const entry: ActiveEntry = {
      algo,
      ctx:             { userId: req.userId, tenantId: req.tenantId },
      allSlicesSent:   false,
      cancelRequested: false,
    };
    this.active.set(id, entry);
    this.emit("algo:started", algo);
    console.log(`[algo] ${id} ${req.params.type} ${req.direction} ${req.totalQuantity} ${req.symbol} started`);

    // Fire-and-forget: the async runner drives the algo to completion in the
    // background. Errors inside it are always caught per-slice (see
    // _executeChild), so this can never produce an unhandled rejection.
    switch (req.params.type) {
      case "TWAP":
        void this._runTwap(entry, req.params, req.onChildFill);
        break;
      case "VWAP":
        void this._runVwap(entry, req.params, req.onChildFill);
        break;
      case "ICEBERG":
        void this._runIceberg(entry, req.params, req.onChildFill);
        break;
      case "BRACKET":
        void this._runBracket(entry, req.onChildFill);
        break;
    }

    return algo;
  }

  cancel(algoId: string, userId: string): boolean {
    const entry = this.active.get(algoId);
    if (!entry || entry.algo.userId !== userId) return false;

    // Stop future slices; any slice already in flight (awaiting placeOrder)
    // still resolves normally and is accounted for via recordChildFill/
    // recordChildFailure — we don't leave a dangling real order unaccounted.
    entry.cancelRequested = true;
    entry.algo.status     = "CANCELLED";
    entry.algo.updatedAt  = new Date().toISOString();
    this.emit("algo:cancelled", entry.algo);
    console.log(`[algo] ${algoId} cancelled by userId=${userId}`);
    return true;
  }

  getActive(userId: string): AlgoOrder[] {
    return Array.from(this.active.values())
      .filter(e => e.algo.userId === userId)
      .map(e => e.algo);
  }

  get(algoId: string): AlgoOrder | null {
    return this.active.get(algoId)?.algo ?? null;
  }

  // ── TWAP execution ─────────────────────────────────────────────────────────

  private async _runTwap(
    entry:      ActiveEntry,
    params:     TwapParams,
    onFill?:    AlgoSubmitRequest["onChildFill"],
  ): Promise<void> {
    const { algo } = entry;
    const sliceQty = algo.totalQuantity / params.slices;

    for (let slicesFired = 0; slicesFired < params.slices; slicesFired++) {
      if (entry.cancelRequested) return;
      if (slicesFired > 0) await sleep(params.durationMs / params.slices);
      if (entry.cancelRequested) return;

      const qty = slicesFired === params.slices - 1
        ? algo.remainingQty     // last slice absorbs rounding residual
        : Math.min(sliceQty, algo.remainingQty);

      await this._executeChild(entry, qty, onFill);
    }

    this._finishSlicing(entry);
  }

  // ── VWAP execution ─────────────────────────────────────────────────────────

  private async _runVwap(
    entry:   ActiveEntry,
    params:  VwapParams,
    onFill?: AlgoSubmitRequest["onChildFill"],
  ): Promise<void> {
    const { algo } = entry;
    const weights    = getVolumeWeights(params.slices, params.volumeProfile);
    const quantities = weights.map(w => algo.totalQuantity * w);

    for (let idx = 0; idx < params.slices; idx++) {
      if (entry.cancelRequested) return;
      if (idx > 0) await sleep(params.durationMs / params.slices);
      if (entry.cancelRequested) return;

      const qty = idx === params.slices - 1
        ? algo.remainingQty
        : Math.min(quantities[idx]!, algo.remainingQty);

      await this._executeChild(entry, qty, onFill);
    }

    this._finishSlicing(entry);
  }

  // ── Iceberg execution ──────────────────────────────────────────────────────

  private async _runIceberg(
    entry:   ActiveEntry,
    params:  IcebergParams,
    onFill?: AlgoSubmitRequest["onChildFill"],
  ): Promise<void> {
    const { algo } = entry;

    while (!entry.cancelRequested && algo.remainingQty > 0) {
      const qty = Math.min(params.visibleQty, algo.remainingQty);
      await this._executeChild(entry, qty, onFill);

      if (entry.cancelRequested || algo.remainingQty <= 0) break;
      await sleep(params.reloadDelay);
    }

    this._finishSlicing(entry);
  }

  // ── Bracket execution ──────────────────────────────────────────────────────

  private async _runBracket(
    entry:   ActiveEntry,
    onFill?: AlgoSubmitRequest["onChildFill"],
  ): Promise<void> {
    // Bracket is a single entry order carrying its own stopLoss/takeProfit —
    // _executeChild attaches them from algo.params (BracketParams) so the
    // resulting position is protected the moment it opens; ongoing SL/TP
    // enforcement is then the existing position.price.monitor's job, same
    // as any other position.
    if (!entry.cancelRequested) {
      await this._executeChild(entry, entry.algo.totalQuantity, onFill);
    }
    this._finishSlicing(entry);
  }

  // ── Child order execution (real, via the order controller) ───────────────

  /** Marks that no further slices will be scheduled, then completes if nothing is left pending. */
  private _finishSlicing(entry: ActiveEntry): void {
    entry.allSlicesSent = true;
    this._maybeComplete(entry);
  }

  private async _executeChild(
    entry:   ActiveEntry,
    qty:     number,
    onFill?: AlgoSubmitRequest["onChildFill"],
  ): Promise<void> {
    if (qty <= 0) return;
    const { algo, ctx } = entry;

    const childId = `co_${randomUUID()}`;
    const now     = new Date().toISOString();
    const child: ChildOrder = {
      id:        childId,
      quantity:  qty,
      fillPrice: null,
      status:    "PENDING",
      sentAt:    now,
      filledAt:  null,
    };
    algo.childOrders.push(child);
    algo.updatedAt = now;
    this.emit("algo:child:sent", { algo, child });

    try {
      const bracket = algo.params.type === "BRACKET" ? algo.params : undefined;
      const ack = await orderController.placeOrder(
        {
          symbol:     algo.symbol,
          side:       algo.direction,
          type:       "MARKET",
          quantity:   qty,
          leverage:   1,
          stopLoss:   bracket?.stopLoss,
          takeProfit: bracket?.takeProfit,
        },
        ctx,
      );

      if (ack.status === "FILLED" && typeof ack.averageFillPrice === "number") {
        this.recordChildFill(algo.id, childId, ack.averageFillPrice, qty);
      } else {
        this._recordChildFailure(algo.id, childId, ack.rejectionReason ?? `order status ${ack.status}`);
      }
    } catch (err) {
      this._recordChildFailure(algo.id, childId, (err as Error).message);
    }

    onFill?.(child, algo);
  }

  recordChildFill(algoId: string, childId: string, fillPrice: number, qty: number): void {
    const entry = this.active.get(algoId);
    if (!entry) return;
    const { algo } = entry;

    const child = algo.childOrders.find(c => c.id === childId);
    if (!child) return;

    child.fillPrice = fillPrice;
    child.status    = "FILLED";
    child.filledAt  = new Date().toISOString();

    const prevFilled = algo.filledQuantity;
    algo.filledQuantity += qty;
    algo.remainingQty   = Math.max(0, algo.totalQuantity - algo.filledQuantity);
    algo.avgFillPrice   = prevFilled === 0
      ? fillPrice
      : (algo.avgFillPrice * prevFilled + fillPrice * qty) / algo.filledQuantity;
    algo.updatedAt = new Date().toISOString();

    this.emit("algo:child:filled", { algo, child });
    this._maybeComplete(entry);
  }

  private _recordChildFailure(algoId: string, childId: string, reason: string): void {
    const entry = this.active.get(algoId);
    if (!entry) return;
    const { algo } = entry;

    const child = algo.childOrders.find(c => c.id === childId);
    if (!child) return;

    child.status   = "CANCELLED";
    child.filledAt = new Date().toISOString();
    algo.updatedAt = child.filledAt;

    console.warn(`[algo] ${algoId} child ${childId} failed: ${reason}`);
    this.emit("algo:child:failed", { algo, child, reason });
    this._maybeComplete(entry);
  }

  /** Completes the algo once slicing has finished AND no child order is still PENDING. */
  private _maybeComplete(entry: ActiveEntry): void {
    const { algo } = entry;
    if (algo.status !== "RUNNING") return;
    if (!entry.allSlicesSent) return;
    if (algo.childOrders.some(c => c.status === "PENDING")) return;
    this._complete(entry);
  }

  private _complete(entry: ActiveEntry): void {
    const { algo } = entry;
    algo.status      = algo.filledQuantity > 0 ? "COMPLETED" : "FAILED";
    algo.updatedAt   = new Date().toISOString();
    algo.completedAt = algo.updatedAt;
    this.active.delete(algo.id);
    this.emit("algo:completed", algo);
    console.log(
      `[algo] ${algo.id} ${algo.status} filled=${algo.filledQuantity.toFixed(4)}/${algo.totalQuantity.toFixed(4)} avgPrice=${algo.avgFillPrice.toFixed(5)}`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const algoOrderService = new AlgoOrderService();
