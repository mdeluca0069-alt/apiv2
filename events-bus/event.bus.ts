import { EventEmitter } from "node:events";

// ─── Typed Event Catalogue ───────────────────────────────────────────────────

export type OrderFilledEvent = {
  orderId: string;
  userId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  averageFillPrice: number;
  marginRequired: number;
  notional: number;
  leverage: number;
  timestamp: string;
  /** FASE 2.1: id of the OutboxEvent row already committed in the same DB
   *  transaction as the fill — lets the WS delivery bridge mark it published
   *  on live delivery instead of creating a second, redundant row. */
  outboxId?: string;
};

export type OrderRejectedEvent = {
  orderId: string;
  userId: string;
  symbol: string;
  reason: string;
  timestamp: string;
};

export type PositionOpenedEvent = {
  positionId: string;
  userId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;
  marginUsed: number;
  leverage: number;
  timestamp: string;
};

export type PositionClosedEvent = {
  positionId: string;
  userId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  timestamp: string;
  /** FASE 2.1: see OrderFilledEvent.outboxId. */
  outboxId?: string;
};

export type MarketQuoteEvent = {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  changePct: number;
  timestamp: string;
};

export type SignalGeneratedEvent = {
  signalId: string;
  /** Alias: some emitters use `id` instead of `signalId`. */
  id?: string;
  userId: string | "PLATFORM";
  symbol: string;
  signalType: "BUY" | "SELL" | "NEUTRAL";
  /** Alias: some emitters use `direction` instead of `signalType`. */
  direction?: "BUY" | "SELL" | "NEUTRAL";
  confidence: number;
  marketRegime: string;
  entryPrice: number;
  stopLoss: number;
  /** Alias: some emitters use `targetLevels` for take-profit price array. */
  targetLevels?: number[];
  /** Timeframe string, e.g. "1H", "4H". */
  timeframe?: string;
  riskRewardRatio: number;
  timestamp: string;
};

export type RiskWarningEvent = {
  userId: string;
  severity: "INFO" | "WARNING" | "CRITICAL" | "LOW" | "MEDIUM" | "HIGH";
  /** Optional: compliance alert type, e.g. "AML_FLAG", "PEP_HIT". */
  type?: string;
  marginLevel?: number;
  riskScore?: number;
  message: string;
  timestamp?: string;
  /** Optional: compliance-specific payload attached by compliance engine. */
  payload?: unknown;
};

export type AdminAuditEvent = {
  actor: string;
  action: string;
  entity: string;
  payload: Record<string, unknown>;
  timestamp: string;
};

export type WalletEvent = {
  userId: string;
  type: "CREDIT" | "DEBIT" | "MARGIN_LOCK" | "MARGIN_RELEASE";
  amount: number;
  reference: string;
  timestamp: string;
};

// ─── Order lifecycle events ───────────────────────────────────────────────────

export type OrderPendingEvent = {
  orderId:      string;
  pendingId?:   string;
  userId:       string;
  symbol:       string;
  side:         "BUY" | "SELL";
  type:         string;
  quantity?:    number;
  triggerPrice?: number;
  limitPrice?:  number;
  trailAmount?: number;
  timestamp:    string;
};

export type OrderCancelledEvent = {
  orderId:        string;
  pendingId?:     string;
  userId:         string;
  symbol?:        string;
  previousStatus?: string;
  reason?:        string;
  timestamp:      string;
};

export type OrderClosedEvent = {
  orderId?:   string;
  positionId?: string;
  userId:     string;
  symbol?:    string;
  pnl?:       number;
  timestamp:  string;
};

export type OrderTriggeredEvent = {
  pendingId:  string;
  orderId:    string;
  userId:     string;
  symbol:     string;
  side:       "BUY" | "SELL";
  type:       string;
  execPrice:  number;
  timestamp:  string;
  clientOrderId?: string;
};

export type OrderTriggerFailedEvent = {
  pendingId: string;
  orderId:   string;
  userId:    string;
  reason:    string;
  timestamp: string;
};

export type OrderStopLimitArmedEvent = {
  parentPendingId: string;
  orderId:         string;
  userId:          string;
  symbol:          string;
  limitPrice?:     number;
  timestamp:       string;
};

// ─── Account lifecycle events ─────────────────────────────────────────────────

export type UserRegisteredEvent = {
  userId:        string;
  email:         string;
  fullName:      string;
  tier:          string;
  accountNumber: string;
  timestamp:     string;
};

// ─── Support events ────────────────────────────────────────────────────────────

export type SupportTicketCreatedEvent = {
  userId:   string;
  ticketId: string;
  subject:  string;
  priority: string;
  timestamp: string;
};

export type SupportTicketUpdatedEvent = {
  userId:     string;
  ticketId:   string;
  status:     string;
  resolution?: string;
  agentNote?:  string;
  timestamp:  string;
};

// ─── KYC events ───────────────────────────────────────────────────────────────

export type KycDocumentUploadedEvent = {
  userId:      string;
  documentKey: string;
  caseId:      string;
  timestamp:   string;
};

export type KycApprovedEvent = {
  userId:  string;
  caseId:  string;
  adminId: string;
  timestamp: string;
};

export type KycDocsRequestedEvent = {
  userId:           string;
  caseId:           string;
  docs?:            string[];
  documentsNeeded?: string[];
  adminId?:         string;
  timestamp:        string;
};

export type KycRejectedEvent = {
  userId:   string;
  caseId:   string;
  reason:   string;
  actorId?: string;
  timestamp: string;
};

// ─── Autopilot events ─────────────────────────────────────────────────────────

export type AutopilotExecutedEvent = {
  userId:    string;
  orderId:   string;
  symbol:    string;
  side:      string;
  reason:    string;
  slippageBps?: number;
  executionAction?: string;
  executionScore?:  number;
  timestamp: string;
};

export type AutopilotDailyLossLockEvent = {
  userId:    string;
  pnl:       number;
  lossPct:   number;
  maxDailyLossPct: number;
  lockedUntil: string;
  timestamp: string;
};

export type AutopilotRejectedEvent = {
  userId:    string;
  symbol:    string;
  reason:    string;
  timestamp: string;
};

export type AutopilotConfigChangedEvent = {
  userId:     string;
  enabled?:   boolean;
  changes?:   Record<string, unknown>;
  timestamp?: string;
};

// ─── New Events (Execution Engine) ───────────────────────────────────────────

export type OrderStatusChangedEvent = {
  orderId:   string;
  userId:    string;
  symbol:    string;
  status:    string;
  detail:    string;
  timestamp: string;
};

// REALTIME_FREEZE.md Critical #1: the single canonical event for all three
// margin-risk thresholds (WARNING 150%, MARGIN_CALL 100%, STOP_OUT 50%).
// Previously WARNING had no event at all, and MARGIN_CALL/STOP_OUT emitted
// under two other names ("risk.margin_call"/"risk.stop_out") that had zero
// listeners anywhere -- three broken/half-wired paths pretending to be one
// working pipeline. `threshold` disambiguates which level fired;
// `positionsClosed`/`totalPnl` are only populated for STOP_OUT.
export type MarginWarningEvent = {
  userId:          string;
  marginLevelPct:  number;
  freeMargin:      number;
  equity:          number;
  marginUsed:      number;
  threshold:       "WARNING" | "MARGIN_CALL" | "STOP_OUT";
  timestamp:       string;
  positionsClosed?: number;
  totalPnl?:        number;
};

export type PositionPnlUpdatedEvent = {
  positionId:  string;
  userId:      string;
  symbol:      string;
  markPrice:   number;
  pnl:         number;
  pnlPercent:  number;
  timestamp:   string;
};

export type TradeClosedEvent = {
  positionId: string;
  userId:     string;
  symbol:     string;
  pnl:        number;
  reason:     string;
  closedAt:   string;
};

export type SwapAccruedEvent = {
  userId:      string;
  positionId:  string;
  symbol:      string;
  swap:        number;
  accrualDate: string;
};

export type OrderPartialFilledEvent = {
  orderId:           string;
  userId:            string;
  symbol:            string;
  side:              string;
  filledQuantity:    number;
  remainingQuantity: number;
  averageFillPrice:  number;
  timestamp:         string;
  /** FASE 2.1: see OrderFilledEvent.outboxId. */
  outboxId?:         string;
};

export type OrderLimitExpiredEvent = {
  orderId:    string;
  pendingId:  string;
  userId:     string;
  symbol:     string;
  side:       string;
  limitPrice: number;
  expiredAt:  string;
  timestamp:  string;
};

export type DocumentScanCleanEvent = {
  documentId: string;
  userId:     string;
};

export type DocumentScanInfectedEvent = {
  documentId: string;
  userId:     string;
  threats:    unknown;
  scannedAt:  string;
};

export type DocumentDeletedEvent = {
  documentId: string;
  userId:     string;
};

// ─── Event Map ────────────────────────────────────────────────────────────────

export interface BrokerEventMap {
  // Order lifecycle
  "order.filled":           [OrderFilledEvent];
  "order.rejected":         [OrderRejectedEvent];
  "order.status_changed":   [OrderStatusChangedEvent];
  "order.pending":          [OrderPendingEvent];
  "order.cancelled":        [OrderCancelledEvent];
  "order.closed":           [OrderClosedEvent];
  "order.triggered":        [OrderTriggeredEvent];
  "order.trigger_failed":   [OrderTriggerFailedEvent];
  "order.stop_limit_armed": [OrderStopLimitArmedEvent];
  // Position
  "position.opened":        [PositionOpenedEvent];
  "position.closed":        [PositionClosedEvent];
  "position.pnl_updated":   [PositionPnlUpdatedEvent];
  "position.updated":       [{ positionId: string; userId: string; symbol: string; stopLoss: number | null; takeProfit: number | null; timestamp: string }];
  // Market data
  "market.quote":           [MarketQuoteEvent];
  "market.data.stale":      [{ symbol: string; lastExternalAt: number; staleSince: number; timestamp: string }];
  // Signals
  "signal.generated":       [SignalGeneratedEvent];
  // Risk
  "risk.warning":           [RiskWarningEvent];
  "margin.warning":         [MarginWarningEvent];
  // Admin
  "admin.audit":            [AdminAuditEvent];
  // Wallet
  "wallet.event":           [WalletEvent];
  // Account lifecycle
  "user.registered":        [UserRegisteredEvent];
  // Support
  "support.ticket_created": [SupportTicketCreatedEvent];
  "support.ticket_updated": [SupportTicketUpdatedEvent];
  // KYC
  "kyc.document_uploaded":  [KycDocumentUploadedEvent];
  "kyc.approved":           [KycApprovedEvent];
  "kyc.docs_requested":     [KycDocsRequestedEvent];
  "kyc.rejected":           [KycRejectedEvent];
  // Autopilot
  "autopilot.executed":     [AutopilotExecutedEvent];
  "autopilot.rejected":     [AutopilotRejectedEvent];
  "autopilot.config_changed": [AutopilotConfigChangedEvent];
  "autopilot.daily_loss_lock": [AutopilotDailyLossLockEvent];
  // Trade lifecycle
  "trade.closed":           [TradeClosedEvent];
  // Swap
  "swap.accrued":           [SwapAccruedEvent];
  // Partial fills
  "order.partial_filled":   [OrderPartialFilledEvent];
  "order.limit_expired":    [OrderLimitExpiredEvent];
  // Document lifecycle
  "document.scan_clean":    [DocumentScanCleanEvent];
  "document.scan_infected": [DocumentScanInfectedEvent];
  "document.deleted":       [DocumentDeletedEvent];
  // Affiliate program
  "affiliate.status_changed":     [{ affiliateId: string; status: string; adminId: string; timestamp: string }];
  "affiliate.referral_recorded":  [{ affiliateId: string; userId: string; timestamp: string }];
  "affiliate.commission_accrued": [{ affiliateId: string; userId: string; depositId: string; amount: number; currency: string; timestamp: string }];
  // Autopilot position management
  "autopilot.position_managed": [{
    positionId: string; userId: string; symbol: string;
    action: "REGIME_EXIT" | "TIME_STOP" | "BREAK_EVEN" | "TRAILING_STOP";
    stopLoss?: number; timestamp: string;
  }];
}

// ─── Typed Event Bus ──────────────────────────────────────────────────────────

class BrokerEventBus extends EventEmitter {
  emit<K extends keyof BrokerEventMap>(event: K, ...args: BrokerEventMap[K]): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof BrokerEventMap>(
    event: K,
    listener: (...args: BrokerEventMap[K]) => void
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  once<K extends keyof BrokerEventMap>(
    event: K,
    listener: (...args: BrokerEventMap[K]) => void
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof BrokerEventMap>(
    event: K,
    listener: (...args: BrokerEventMap[K]) => void
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

// Singleton — import this everywhere
export const eventBus = new BrokerEventBus();
eventBus.setMaxListeners(50);

export default eventBus;
