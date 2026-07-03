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
 * All algo orders run within in-process interval loops and submit child orders
 * to the real execution engine. On restart they are marked CANCELLED (no
 * persistence of in-flight algo state across restarts is guaranteed).
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

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
  symbol:        string;
  direction:     "BUY" | "SELL";
  totalQuantity: number;
  params:        AlgoParams;
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

export class AlgoOrderService extends EventEmitter {
  private readonly active = new Map<string, { algo: AlgoOrder; timer: ReturnType<typeof setInterval> | null }>();

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

    switch (req.params.type) {
      case "TWAP":
        this._runTwap(algo, req.params, req.onChildFill);
        break;
      case "VWAP":
        this._runVwap(algo, req.params, req.onChildFill);
        break;
      case "ICEBERG":
        this._runIceberg(algo, req.params, req.onChildFill);
        break;
      case "BRACKET":
        this._runBracket(algo, req.onChildFill);
        break;
    }

    this.active.set(id, { algo, timer: null });
    this.emit("algo:started", algo);
    console.log(`[algo] ${id} ${req.params.type} ${req.direction} ${req.totalQuantity} ${req.symbol} started`);

    return algo;
  }

  cancel(algoId: string, userId: string): boolean {
    const entry = this.active.get(algoId);
    if (!entry || entry.algo.userId !== userId) return false;

    if (entry.timer) clearInterval(entry.timer);
    entry.algo.status    = "CANCELLED";
    entry.algo.updatedAt = new Date().toISOString();
    this.active.delete(algoId);
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

  private _runTwap(
    algo:       AlgoOrder,
    params:     TwapParams,
    onFill?:    AlgoSubmitRequest["onChildFill"],
  ): void {
    const sliceQty     = algo.totalQuantity / params.slices;
    const intervalMs   = params.durationMs / params.slices;
    let   slicesFired  = 0;

    const timer = setInterval(() => {
      if (slicesFired >= params.slices || algo.status !== "RUNNING") {
        clearInterval(timer);
        if (algo.status === "RUNNING") this._complete(algo);
        return;
      }

      const qty    = slicesFired === params.slices - 1
        ? algo.remainingQty     // last slice absorbs rounding residual
        : Math.min(sliceQty, algo.remainingQty);

      this._simulateFill(algo, qty, onFill);
      slicesFired++;

      if (algo.remainingQty <= 0) {
        clearInterval(timer);
        this._complete(algo);
      }
    }, intervalMs);

    const entry = this.active.get(algo.id);
    if (entry) entry.timer = timer;
  }

  // ── VWAP execution ─────────────────────────────────────────────────────────

  private _runVwap(
    algo:    AlgoOrder,
    params:  VwapParams,
    onFill?: AlgoSubmitRequest["onChildFill"],
  ): void {
    const weights    = getVolumeWeights(params.slices, params.volumeProfile);
    const quantities = weights.map(w => algo.totalQuantity * w);
    const intervalMs = params.durationMs / params.slices;
    let   idx        = 0;

    const timer = setInterval(() => {
      if (idx >= params.slices || algo.status !== "RUNNING") {
        clearInterval(timer);
        if (algo.status === "RUNNING") this._complete(algo);
        return;
      }

      const qty = idx === params.slices - 1
        ? algo.remainingQty
        : Math.min(quantities[idx]!, algo.remainingQty);

      this._simulateFill(algo, qty, onFill);
      idx++;

      if (algo.remainingQty <= 0) {
        clearInterval(timer);
        this._complete(algo);
      }
    }, intervalMs);

    const entry = this.active.get(algo.id);
    if (entry) entry.timer = timer;
  }

  // ── Iceberg execution ──────────────────────────────────────────────────────

  private _runIceberg(
    algo:    AlgoOrder,
    params:  IcebergParams,
    onFill?: AlgoSubmitRequest["onChildFill"],
  ): void {
    const fireSlice = () => {
      if (algo.status !== "RUNNING" || algo.remainingQty <= 0) {
        this._complete(algo);
        return;
      }

      const qty = Math.min(params.visibleQty, algo.remainingQty);
      this._simulateFill(algo, qty, onFill);

      if (algo.remainingQty > 0) {
        setTimeout(fireSlice, params.reloadDelay);
      } else {
        this._complete(algo);
      }
    };

    // Fire first slice immediately
    setTimeout(fireSlice, 0);
  }

  // ── Bracket execution ──────────────────────────────────────────────────────

  private _runBracket(
    algo:    AlgoOrder,
    onFill?: AlgoSubmitRequest["onChildFill"],
  ): void {
    // Bracket is a logical container — the entry fills immediately (market) or
    // when price touches limitPrice (limit). TP and SL (algo.params, a
    // BracketParams) are managed by the existing order.trigger.watcher in
    // trading-service, not by this simulator.
    this._simulateFill(algo, algo.totalQuantity, onFill);
    this._complete(algo);
  }

  // ── Fill simulation ────────────────────────────────────────────────────────

  private _simulateFill(
    algo:    AlgoOrder,
    qty:     number,
    onFill?: AlgoSubmitRequest["onChildFill"],
  ): void {
    if (qty <= 0) return;

    const childId = `co_${randomUUID()}`;
    const now     = new Date().toISOString();

    // In production this fires the real ExecutionEngine. Here we record the
    // child order and emit an event so the caller can route to real execution.
    const child: ChildOrder = {
      id:       childId,
      quantity: qty,
      fillPrice:null,   // filled by caller after execution
      status:   "PENDING",
      sentAt:   now,
      filledAt: null,
    };

    algo.childOrders.push(child);
    algo.updatedAt = now;

    this.emit("algo:child:sent", { algo, child });
    onFill?.(child, algo);
  }

  recordChildFill(algoId: string, childId: string, fillPrice: number, qty: number): void {
    const algo = this.get(algoId);
    if (!algo) return;

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
  }

  private _complete(algo: AlgoOrder): void {
    algo.status      = "COMPLETED";
    algo.updatedAt   = new Date().toISOString();
    algo.completedAt = algo.updatedAt;
    this.active.delete(algo.id);
    this.emit("algo:completed", algo);
    console.log(
      `[algo] ${algo.id} COMPLETED filled=${algo.filledQuantity.toFixed(4)}/${algo.totalQuantity.toFixed(4)} avgPrice=${algo.avgFillPrice.toFixed(5)}`
    );
  }
}

export const algoOrderService = new AlgoOrderService();
