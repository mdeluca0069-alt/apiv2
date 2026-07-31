import { z } from "zod";

export const AccountTierSchema = z.enum([
  "STANDARD",
  "GOLD",
  "PLATINUM",
  "VIP",
  "ENTERPRISE",
]);

export const UserRoleSchema = z.enum(["trader", "risk", "compliance", "admin", "super_admin"]);

export const AssetClassSchema = z.enum([
  "FX_MAJOR",
  "FX_MINOR",
  "INDEX",
  "COMMODITY",
  "EQUITY",
  "CRYPTO",
]);

export const OrderSideSchema = z.enum(["BUY", "SELL"]);
export const OrderTypeSchema = z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT", "TRAILING_STOP", "IOC", "FOK"]);
export const OrderStatusSchema = z.enum([
  "RECEIVED",
  "RISK_REVIEW",
  "ACCEPTED",
  "PARTIALLY_FILLED",
  "FILLED",
  "REJECTED",
  "CANCELLED",
  // Stop-limit lifecycle states
  "LIMIT_ARMED",    // STOP triggered; resting LIMIT order is now active
  "LIMIT_EXPIRED",  // armed LIMIT order expired without fill
  "LIMIT_CANCELLED", // armed LIMIT order cancelled by client
]);

export const InstrumentSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  assetClass: AssetClassSchema,
  base: z.string(),
  quote: z.string(),
  precision: z.number().int().min(0).max(8),
  minTradeSize: z.number().positive(),
  maxLeverageRetail: z.number().positive(),
  session: z.string(),
});

export const QuoteSchema = z.object({
  symbol: z.string(),
  bid: z.number().positive(),
  ask: z.number().positive(),
  mid: z.number().positive(),
  spread: z.number().nonnegative(),
  changePct: z.number(),
  ts: z.string(),
  // MARKET_DATA_FREEZE.md §0.7: true when this symbol's feed has gone
  // silent past STALE_THRESHOLD_MS -- until this field existed, WS
  // broadcasts and REST snapshots had no way to tell a client "this price
  // is not live," even though the backend already tracks staleness
  // internally (quoteCache.isStale()) and rejects orders on it.
  isStale: z.boolean().optional(),
});

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  authKey: z.string().optional(),
});

export const RegisterRequestSchema = LoginRequestSchema.extend({
  fullName: z.string().min(2),
  country: z.string().min(2).max(2).default("IT"),
  tier: AccountTierSchema.default("STANDARD"),
});

export const PrincipalSchema = z.object({
  sub: z.string(),
  email: z.string().email(),
  fullName: z.string(),
  tenantId: z.string(),
  tier: AccountTierSchema,
  roles: z.array(UserRoleSchema),
  permissions: z.array(z.string()),
  kycStatus: z.enum(["not_started", "pending", "approved", "rejected"]),
  mfaRequired: z.boolean(),
  accountNumber: z.string().optional(),
});

export const TokenBundleSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresIn: z.number().int().positive(),
  tokenType: z.literal("Bearer").default("Bearer"),
  principal: PrincipalSchema,
  tenantId: z.string(),
});

export const NewOrderRequestSchema = z.object({
  symbol: z.string().min(3),
  side: OrderSideSchema,
  type: OrderTypeSchema.default("MARKET"),
  quantity: z.number().positive(),
  price: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  leverage: z.number().positive().max(500).default(1),
  clientOrderId: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
});

export const PlaceOcoRequestSchema = z.object({
  legA: NewOrderRequestSchema,
  legB: NewOrderRequestSchema,
});

export const OrderAckSchema = z.object({
  id: z.string(),
  clientOrderId: z.string().optional(),
  symbol: z.string(),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  quantity: z.number(),
  requestedPrice: z.number().optional(),
  averageFillPrice: z.number().optional(),
  status: OrderStatusSchema,
  rejectionReason: z.string().optional(),
  marginRequired: z.number(),
  notional: z.number(),
  createdAt: z.string(),
});

export const PositionSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  side: OrderSideSchema,
  quantity: z.number(),
  entryPrice: z.number(),
  markPrice: z.number(),
  pnl: z.number(),
  marginUsed: z.number(),
  leverage: z.number(),
  openedAt: z.string(),
});

export const WalletBalanceSchema = z.object({
  currency: z.string(),
  available: z.number(),
  equity: z.number(),
  marginUsed: z.number(),
  freeMargin: z.number(),
  unrealizedPnl: z.number(),
});

export const RiskSnapshotSchema = z.object({
  riskScore: z.number().min(0).max(100),
  marginLevelPct: z.number(),
  exposure: z.number(),
  drawdownPct: z.number(),
  negativeBalanceProtection: z.boolean(),
  stopOutLevelPct: z.number(),
  leveragePolicy: z.record(z.number()),
  alerts: z.array(z.string()),
});

export const AiSignalSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  direction: z.enum(["BUY", "SELL", "NEUTRAL"]),
  confidence: z.number().min(0).max(1),
  horizon: z.enum(["INTRADAY", "SWING", "POSITION"]),
  regime: z.string(),
  rationale: z.string(),
  generatedAt: z.string(),
});

export const ServiceHealthSchema = z.object({
  service: z.string(),
  status: z.enum(["operational", "degraded", "offline"]),
  latencyMs: z.number(),
  region: z.string(),
  checkedAt: z.string(),
});

export const EconomicCalendarEventSchema = z.object({
  id: z.string(),
  time: z.string(),
  country: z.string(),
  currency: z.string(),
  impact: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  event: z.string(),
  previous: z.string(),
  forecast: z.string(),
  actual: z.string().optional(),
  countdownSeconds: z.number().int(),
  affectedSymbols: z.array(z.string()),
  olosScenario: z.string(),
});

export const IndicatorSnapshotSchema = z.object({
  symbol: z.string(),
  timeframe: z.string(),
  price: z.number(),
  generatedAt: z.string(),
  rsi: z.number(),
  macd: z.object({
    value: z.number(),
    signal: z.number(),
    histogram: z.number(),
    bias: z.enum(["bullish", "bearish", "neutral"]),
  }),
  ema: z.object({
    ema20: z.number(),
    ema50: z.number(),
    trend: z.enum(["uptrend", "downtrend", "range"]),
  }),
  vwap: z.number(),
  bollinger: z.object({
    upper: z.number(),
    middle: z.number(),
    lower: z.number(),
    bandwidthPct: z.number(),
  }),
  fibonacci: z.array(z.object({ level: z.string(), price: z.number() })),
  smartMoney: z.object({
    bias: z.enum(["accumulation", "distribution", "neutral"]),
    orderBlock: z.string(),
    liquiditySweep: z.string(),
    volumeProfile: z.string(),
  }),
});

export const AdminUpdateTierSchema = z.object({
  userId: z.string(),
  tier: AccountTierSchema,
});

export const AdminUpdateLiquiditySchema = z.object({
  symbol: z.string().min(3),
  enabled: z.boolean().optional(),
  spreadMarkupBps: z.number().min(0).max(250).optional(),
  mode: z.enum(["internal_lp", "reduced_only", "halted"]).optional(),
});

export const AdminKillSwitchSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().min(3).default("Admin broker control center"),
});

// RISK_ENGINE_FREEZE.md §7.3: stopOutLevelPct is intentionally NOT admin-settable
// here -- the real stop-out threshold is a hardcoded ESMA-mandated floor
// (STOP_OUT_PCT = 50 in trading-service/stopout.engine.ts), and this schema
// previously let an admin set a value that was silently never read by the
// actual liquidation engine.
export const AdminRiskPolicySchema = z.object({
  maxDrawdownPct: z.number().min(1).max(80).optional(),
  maxRiskPerTradePct: z.number().min(0.1).max(10).optional(),
  negativeBalanceProtection: z.boolean().optional(),
  eventRiskMode: z.enum(["normal", "reduced", "blocked"]).optional(),
});

export const AdminOlosGovernanceSchema = z.object({
  autopilotEnabled: z.boolean().optional(),
  minConfidence: z.number().min(0.5).max(0.99).optional(),
  maxRiskPerTradePct: z.number().min(0.1).max(5).optional(),
  eventLockMinutes: z.number().int().min(0).max(240).optional(),
  modelStatus: z.enum(["operational", "degraded", "offline"]).optional(),
});

// Task 14 Phase 3 — admin pause for a single client's autopilot, distinct
// from AdminOlosGovernanceSchema's platform-wide autopilotEnabled toggle.
export const AdminAutopilotPauseSchema = z.object({
  userId: z.string(),
  paused: z.boolean(),
  reason: z.string().min(3).optional(),
});

// Task 13 — Global Risk Supervisor admin override. "AUTO" hands control back
// to the automatic evaluator; any other mode forces it until cleared.
export const AdminRiskSupervisorOverrideSchema = z.object({
  mode: z.enum(["NORMAL", "SAFE_MODE", "EMERGENCY_MODE", "FULL_AUTOPILOT_STOP", "AUTO"]),
  reason: z.string().min(3).default("Admin override"),
});

export const AutopilotConfigSchema = z.object({
  userId: z.string(),
  tier: AccountTierSchema,
  enabled: z.boolean(),
  mode: z.enum(["locked", "supervised", "enterprise_review"]),
  minConfidence: z.number(),
  maxRiskPerTradePct: z.number(),
  eventLockMinutes: z.number(),
  allowedSymbols: z.array(z.string()),
  activeRules: z.array(z.string()),
  lastDecision: z.object({
    symbol: z.string(),
    action: z.enum(["WAIT", "ARM_BUY", "ARM_SELL"]),
    reason: z.string(),
  }),
});

export const ClientDocumentSchema = z.object({
  id: z.enum(["identity", "address", "appropriateness", "source_of_funds"]),
  label: z.string(),
  status: z.enum(["MISSING", "PENDING_REVIEW", "APPROVED", "REJECTED"]),
  updatedAt: z.string(),
  fileName: z.string().optional(),
  rejectionReason: z.string().optional(),
});

export const LedgerEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  type: z.enum(["ADMIN_CAPITAL_ALLOCATION", "DEPOSIT_REQUEST", "WITHDRAW_REQUEST", "MARGIN_RESERVED", "DOCUMENT_EVENT"]),
  amount: z.number(),
  status: z.enum(["PENDING_ADMIN", "APPROVED", "REJECTED", "COMPLETED"]),
  reference: z.string(),
  note: z.string(),
});

export const BrokerClientAccountSchema = z.object({
  userId: z.string(),
  profile: z.object({
    fullName: z.string(),
    email: z.string().email(),
    tier: AccountTierSchema,
    authKeyStatus: z.enum(["VERIFIED", "PENDING"]),
    kycStatus: z.enum(["NOT_STARTED", "PENDING_REVIEW", "APPROVED", "REJECTED"]),
    mifidStatus: z.enum(["COMPLETED", "PENDING"]),
  }),
  capital: z.object({
    allocated: z.number(),
    equity: z.number(),
    marginUsed: z.number(),
    freeMargin: z.number(),
    unrealizedPnl: z.number(),
    riskScore: z.number(),
  }),
  ledger: z.array(LedgerEntrySchema),
  documents: z.array(ClientDocumentSchema),
  settings: z.object({
    olosNotifications: z.boolean(),
    macroAlerts: z.boolean(),
    orderConfirmations: z.boolean(),
    autopilotSupervision: z.boolean(),
  }),
});

export const AdminAllocateCapitalSchema = z.object({
  userId: z.string(),
  amount: z.number().positive(),
  note: z.string().min(1).default("Allocazione capitale admin"),
});

export const ClientDepositRequestSchema = z.object({
  amount: z.number().positive(),
  method: z.string().min(1),
  details: z.string().optional(),
});

export const ClientWithdrawRequestSchema = z.object({
  amount: z.number().positive(),
  destination: z.string().min(1),
  method: z.string().min(1),
});

export const ClientDocumentUploadSchema = z.object({
  documentId:  ClientDocumentSchema.shape.id.optional(),
  documentKey: z.string().min(2).optional(),
  label:       z.string().optional(),
  fileName:    z.string().min(1),
  mimeType:    z.string().optional(),
  content:     z.string().optional(),  // base64 data URI or raw base64
});

export const AdminReviewDocumentSchema = z.object({
  userId: z.string(),
  documentId: ClientDocumentSchema.shape.id,
  status: z.enum(["APPROVED", "REJECTED"]),
  rejectionReason: z.string().optional(),
});

export const AdminReviewLedgerSchema = z.object({
  userId: z.string(),
  ledgerId: z.string(),
  status: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().optional(),
});

// ===== NEW SCHEMAS FOR FEATURES =====

// Trade Audit - Storico completo delle operazioni
export const TradeAuditSchema = z.object({
  id: z.string(),
  userId: z.string(),
  symbol: z.string(),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number(),
  entryPrice: z.number().optional(),
  exitPrice: z.number().optional(),
  stopLoss: z.number().optional(),
  takeProfit: z.number().optional(),
  pnlRealized: z.number().optional(),
  pnlUnrealized: z.number().optional(),
  pnlPercent: z.number().optional(),
  marginUsed: z.number().optional(),
  leverage: z.number().optional(),
  fees: z.number(),
  slippage: z.number(),
  duration: z.number().optional(), // minuti
  tradeStatus: z.enum(["OPEN", "CLOSED", "PARTIAL", "REJECTED", "CANCELLED"]),
  lifecycle: z.array(z.object({
    status: z.string(),
    timestamp: z.string(),
    detail: z.string().optional(),
  })),
  riskMetrics: z.object({
    riskScore: z.number(),
    marginLevel: z.number(),
    expectedLoss: z.number().optional(),
    bestCase: z.number().optional(),
    worstCase: z.number().optional(),
  }),
  createdAt: z.string(),
  closedAt: z.string().optional(),
});

// OLOS Signal - Dettagli dei segnali OLOS AI
export const OlosSignalSchema = z.object({
  id: z.string(),
  userId: z.string(),
  symbol: z.string(),
  timeframe: z.enum(["1M", "5M", "15M", "1H", "4H", "1D"]),
  signalType: z.enum(["BUY", "SELL", "NEUTRAL"]),
  confidence: z.number().min(0).max(100),
  setupPattern: z.string(),
  setupDescription: z.string(),
  supportLevel: z.number().optional(),
  resistanceLevel: z.number().optional(),
  confluenceFactors: z.array(z.string()),
  confidenceBreakdown: z.object({
    momentum: z.number(),
    regime: z.number(),
    macro: z.number(),
    volume: z.number().optional(),
  }),
  entryPrice: z.number(),
  entryRationale: z.string(),
  targetLevels: z.array(z.object({
    level: z.number(),
    pips: z.number(),
    type: z.enum(["target1", "target2", "final"]),
  })),
  stopLoss: z.number(),
  slRationale: z.string(),
  riskRewardRatio: z.number(),
  macroEvents: z.array(z.object({
    eventName: z.string(),
    impact: z.string(),
    timeToEvent: z.string(),
  })),
  marketRegime: z.enum(["bullish", "bearish", "sideways"]),
  volatilityLevel: z.enum(["low", "medium", "high"]),
  expectedRiskPips: z.number(),
  marginRequirement: z.number(),
  liquidityProfile: z.enum(["tight", "balanced", "broad"]),
  status: z.enum(["ACTIVE", "TRIGGERED", "CLOSED", "CANCELLED", "EXPIRED"]),
  triggeredAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Alias of createdAt — the field name the frontend signal store expects. */
  generatedAt: z.string().optional(),
});

// Risk Warning - Scenario Analysis
export const RiskWarningSchema = z.object({
  id: z.string(),
  userId: z.string(),
  riskScore: z.number().min(0).max(100),
  marginLevel: z.number(),
  portfolioAggregate: z.object({
    byAsset: z.record(z.number()),
    byDirection: z.object({ long: z.number(), short: z.number() }),
    totalExposure: z.number(),
  }),
  esmaLeverageActive: z.boolean(),
  negativeBalanceActive: z.boolean(),
  liveTradeDisabled: z.boolean(),
  scenarios: z.array(z.object({
    name: z.string(),
    impact: z.string(),
    probability: z.number(),
    maxLoss: z.number(),
  })),
  upcomingEvents: z.array(z.object({
    eventName: z.string(),
    time: z.string(),
    assetClass: z.string(),
    impact: z.string(),
    mitigationAction: z.string().optional(),
  })),
  marginForecast: z.array(z.object({
    timepoint: z.string(),
    forecastedMarginLevel: z.number(),
    riskZone: z.string(),
  })),
  exposureHeatmap: z.object({
    FX_MAJOR: z.number(),
    INDEX: z.number(),
    COMMODITY: z.number(),
    EQUITY: z.number(),
    CRYPTO: z.number(),
  }),
  killSwitchTriggers: z.array(z.object({
    trigger: z.string(),
    threshold: z.number(),
    action: z.string(),
    reason: z.string(),
  })),
  regulatoryLevel: z.enum(["none", "caution", "high_risk"]),
  regulatoryText: z.string().optional(),
  eventCalendarItems: z.array(z.object({
    eventTime: z.string(),
    symbol: z.string(),
    eventType: z.string(),
    forecast: z.string(),
    actual: z.string().optional(),
  })),
  severity: z.enum(["INFO", "WARNING", "CRITICAL"]),
  acknowledged: z.boolean(),
  acknowledgedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Academy Content
export const AcademyContentSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.enum(["olos_101", "autopilot_mt5", "risk_management", "trading_psychology", "case_studies"]),
  level: z.enum(["beginner", "intermediate", "advanced"]),
  contentType: z.enum(["article", "video", "course", "case_study", "playbook"]),
  videoUrl: z.string().optional(),
  duration: z.number().optional(),
  sections: z.array(z.object({
    title: z.string(),
    content: z.string(),
    order: z.number(),
  })),
  caseStudies: z.array(z.object({
    tradeSymbol: z.string(),
    setup: z.string(),
    entry: z.number(),
    exit: z.number(),
    pnl: z.number(),
    lessons: z.array(z.string()),
  })).optional(),
  resources: z.array(z.object({
    title: z.string(),
    url: z.string(),
    type: z.string(),
  })).optional(),
  prerequisites: z.array(z.string()),
  nextTopics: z.array(z.string()),
  relatedContent: z.array(z.string()),
  viewCount: z.number(),
  completionRate: z.number(),
  rating: z.number().optional(),
  isPublished: z.boolean(),
  publishedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// User Academy Progress
export const UserAcademyProgressSchema = z.object({
  id: z.string(),
  userId: z.string(),
  contentId: z.string(),
  progress: z.number(),
  completed: z.boolean(),
  completedAt: z.string().optional(),
  lastViewedAt: z.string(),
  notes: z.string().optional(),
  rating: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TradeAudit = z.infer<typeof TradeAuditSchema>;
export type OlosSignal = z.infer<typeof OlosSignalSchema>;
export type RiskWarning = z.infer<typeof RiskWarningSchema>;
export type AcademyContent = z.infer<typeof AcademyContentSchema>;
export type UserAcademyProgress = z.infer<typeof UserAcademyProgressSchema>;

export type AccountTier = z.infer<typeof AccountTierSchema>;
export type AssetClass = z.infer<typeof AssetClassSchema>;
export type Instrument = z.infer<typeof InstrumentSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type Principal = z.infer<typeof PrincipalSchema>;
export type NewOrderRequest = z.infer<typeof NewOrderRequestSchema>;
export type OrderAck = z.infer<typeof OrderAckSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type WalletBalance = z.infer<typeof WalletBalanceSchema>;
export type RiskSnapshot = z.infer<typeof RiskSnapshotSchema>;
export type AiSignal = z.infer<typeof AiSignalSchema>;
export type BrokerClientAccount = z.infer<typeof BrokerClientAccountSchema>;
export type EconomicCalendarEvent = z.infer<typeof EconomicCalendarEventSchema>;
export type IndicatorSnapshot = z.infer<typeof IndicatorSnapshotSchema>;

// ─── Execution Engine Contracts ───────────────────────────────────────────────

export const ESMA_LEVERAGE_CAPS: Record<string, number> = {
  FX_MAJOR:  30,
  FX_MINOR:  20,
  INDEX:     20,
  COMMODITY: 10,
  EQUITY:    5,
  CRYPTO:    2,
};

export const STOP_OUT_LEVEL_PCT    = 50;
export const MARGIN_CALL_LEVEL_PCT = 100;
export const MAX_RISK_PER_TRADE_PCT = 2;

export type RejectionReason =
  | "KILL_SWITCH_ACTIVE"
  | "INSUFFICIENT_MARGIN"
  | "LEVERAGE_EXCEEDS_ESMA_CAP"
  | "INSTRUMENT_HALTED"
  | "KYC_NOT_APPROVED"
  | "POSITION_SIZE_EXCEEDS_LIMIT"
  | "ACCOUNT_DRAWDOWN_LIMIT_REACHED"
  | "EVENT_RISK_LOCKOUT"
  | "DUPLICATE_CLIENT_ORDER_ID"
  | "INSTRUMENT_NOT_FOUND"
  | "WALLET_NOT_FOUND"
  | "CLIENT_EXPOSURE_LIMIT_EXCEEDED"
  | "CORRELATION_RISK_LIMIT_EXCEEDED"
  | "CONCENTRATION_LIMIT_EXCEEDED";

export type PreTradeRiskResult =
  | { pass: true;  marginRequired: number; notional: number; effectiveLeverage: number }
  | { pass: false; reason: RejectionReason; detail: string };

export type ExecutionRequest = {
  orderId:         string;
  userId:          string;
  symbol:          string;
  side:            "BUY" | "SELL";
  type:            "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT" | "TRAILING_STOP" | "IOC" | "FOK";
  quantity:        number;
  requestedPrice?: number;
  leverage:        number;
  stopLoss?:       number;
  takeProfit?:     number;
  marginRequired:  number;
  notional:        number;
  /**
   * PHASE2_REMEDIATION (H2): set only for a resting (LIMIT/STOP/STOP_LIMIT/
   * TRAILING_STOP) order's fill -- the amount already locked in
   * WalletAccount.locked at order-PLACEMENT time (order.controller.ts's
   * _parkPendingOrder()). execute() releases exactly this amount before
   * locking the real, execution-price-derived margin, so a resting fill is
   * a true-up (release estimate, lock real) instead of a double-lock.
   * Omitted for a MARKET/IOC/FOK order, which was never parked and so
   * never had any margin locked before reaching execute().
   */
  preLockedMargin?: number;
};

export type ExecutionResult =
  | {
      status:           "FILLED";
      orderId:          string;
      averageFillPrice: number;
      filledQuantity:   number;
      slippage:         number;
      fees:             number;
      positionId:       string;
      executionMs:      number;
    }
  | {
      status:            "PARTIALLY_FILLED";
      orderId:           string;
      averageFillPrice:  number;
      filledQuantity:    number;
      remainingQuantity: number;
      slippage:          number;
      fees:              number;
      positionId:        string;
      executionMs:       number;
    }
  | {
      status:  "REJECTED";
      orderId: string;
      reason:  string;
    };

export type FillResult = {
  averagePrice:      number;
  filledQuantity:    number;
  remainingQuantity: number;
  slippage:          number;
  fees:              number;
  liquidityConsumed: number;
  partialFill:       boolean;
};

export type OrderStatus =
  | "RECEIVED"
  | "RISK_REVIEW"
  | "ACCEPTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "REJECTED"
  | "CANCELLED"
  | "LIMIT_ARMED"
  | "LIMIT_EXPIRED"
  | "LIMIT_CANCELLED";

/** Immutable record of a single fill leg (one row per execution event). */
export type OrderFillRecord = {
  id:                string;
  orderId:           string;
  positionId:        string | null;
  quantity:          number;
  price:             number;
  liquidityProvider: string;
  slippage:          number;
  fees:              number;
  createdAt:         Date;
};

export type LifecycleEvent = {
  status:    OrderStatus;
  timestamp: string;
  detail:    string;
  actor:     "SYSTEM" | "RISK" | "LP" | "ADMIN";
};

export type MarginState = {
  userId:          string;
  balance:         number;
  equity:          number;
  marginUsed:      number;
  freeMargin:      number;
  marginLevelPct:  number;
  unrealizedPnl:   number;
};

export type LiquidationCandidate = {
  positionId:  string;
  userId:      string;
  symbol:      string;
  side:        "BUY" | "SELL";
  quantity:    number;
  entryPrice:  number;
  markPrice:   number;
  marginUsed:  number;
  pnl:         number;
  openedAt:    string;
};

export type LiquidationResult = {
  positionId:  string;
  exitPrice:   number;
  pnl:         number;
  reason:      "STOP_OUT" | "NEGATIVE_BALANCE_PROTECTION";
  executedAt:  string;
};

export type KillSwitchState = {
  active:        boolean;
  reason:        string;
  activatedAt?:  string;
  activatedBy?:  string;
};
