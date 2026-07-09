import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { hashPassword as argon2Hash } from "../auth-service/password.hasher.js";
import { LiquidityProvider, type LiquidityBook } from "../liquidity-engine/liquidity.provider.js";
import { quoteCache } from "../market-data/quote.cache.js";
import { eventBus } from "../events-bus/event.bus.js";
import {
  type AiSignal,
  type AssetClass,
  type BrokerClientAccount,
  type EconomicCalendarEvent,
  type IndicatorSnapshot,
  type Instrument,
  type NewOrderRequest,
  type OrderAck,
  type Position,
  type Principal,
  type Quote,
  type RiskSnapshot,
  type WalletBalance,
} from "./contracts.js";
import { createOpaqueToken, createToken, verifyToken } from "./security.js";
import { IS_PERSISTENT } from "./db.js";
import { olosSignalService } from "../signals-engine/olos.signal.service.js";
import { PLATFORM_SIGNAL_USER_ID } from "../signals-engine/signal.generator.js";
import { getSystemHealth } from "./health.check.js";
import { formatAccountNumber } from "./account-number.js";

type UserRecord = {
  id: string;
  email: string;
  password: string;
  /** Transient plain-text password kept only until first DB write; cleared afterwards. */
  _passwordPlain?: string;
  fullName: string;
  tenantId: string;
  tier: Principal["tier"];
  roles: Principal["roles"];
  permissions: string[];
  kycStatus: Principal["kycStatus"];
};

type SessionRecord = {
  refreshToken: string;
  userId: string;
  createdAt: string;
};

type AuditRecord = {
  id: string;
  actor: string;
  action: string;
  entity: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type ClientDocumentId = BrokerClientAccount["documents"][number]["id"];
type ClientDocumentStatus = BrokerClientAccount["documents"][number]["status"];
type LedgerEntryRecord = BrokerClientAccount["ledger"][number];

type LiquidityControl = {
  symbol: string;
  enabled: boolean;
  spreadMarkupBps: number;
  mode: "internal_lp" | "reduced_only" | "halted";
  maxDepth: number;
  updatedAt: string;
};

type BrokerRiskPolicy = {
  stopOutLevelPct: number;
  maxDrawdownPct: number;
  maxRiskPerTradePct: number;
  negativeBalanceProtection: boolean;
  eventRiskMode: "normal" | "reduced" | "blocked";
  killSwitchEnabled: boolean;
  killSwitchReason?: string;
  leveragePolicy: Record<AssetClass, number>;
  updatedAt: string;
};

type OlosGovernance = {
  autopilotEnabled: boolean;
  minConfidence: number;
  maxRiskPerTradePct: number;
  eventLockMinutes: number;
  // Platform-wide circuit breaker: if aggregate realized autopilot P&L across
  // ALL users in a calendar day breaches this % of total platform equity,
  // AutopilotPositionManager auto-disables autopilotEnabled platform-wide.
  maxDailyAutopilotDrawdownPct: number;
  modelStatus: "operational" | "degraded" | "offline";
  activeModels: string[];
  auditMode: "strict";
  updatedAt: string;
};

const nowIso = () => new Date().toISOString();

type AmlAlert = {
  id: string;
  userId: string;
  userName: string;
  email: string;
  type: "HIGH_VALUE" | "FREQUENT" | "SUSPICIOUS";
  amount: number;
  timestamp: string;
  status: "PENDING" | "REVIEWED" | "CLEARED";
  reviewedBy?: string;
  note?: string;
};

const leverageByAssetClass: Record<AssetClass, number> = {
  FX_MAJOR: 30,
  FX_MINOR: 20,
  INDEX: 20,
  COMMODITY: 10,
  EQUITY: 5,
  CRYPTO: 2,
};

const instrumentsSeed: Instrument[] = [
  {
    symbol: "EURUSD",
    name: "Euro / US Dollar",
    assetClass: "FX_MAJOR",
    base: "EUR",
    quote: "USD",
    precision: 5,
    minTradeSize: 1000,
    maxLeverageRetail: 30,
    session: "24/5",
  },
  {
    symbol: "GBPUSD",
    name: "British Pound / US Dollar",
    assetClass: "FX_MAJOR",
    base: "GBP",
    quote: "USD",
    precision: 5,
    minTradeSize: 1000,
    maxLeverageRetail: 30,
    session: "24/5",
  },
  {
    symbol: "USDJPY",
    name: "US Dollar / Japanese Yen",
    assetClass: "FX_MAJOR",
    base: "USD",
    quote: "JPY",
    precision: 3,
    minTradeSize: 1000,
    maxLeverageRetail: 30,
    session: "24/5",
  },
  {
    symbol: "EURGBP",
    name: "Euro / British Pound",
    assetClass: "FX_MINOR",
    base: "EUR",
    quote: "GBP",
    precision: 5,
    minTradeSize: 1000,
    maxLeverageRetail: 20,
    session: "24/5",
  },
  {
    symbol: "AUDUSD",
    name: "Australian Dollar / US Dollar",
    assetClass: "FX_MAJOR",
    base: "AUD",
    quote: "USD",
    precision: 5,
    minTradeSize: 1000,
    maxLeverageRetail: 30,
    session: "24/5",
  },
  {
    symbol: "XAUUSD",
    name: "Gold Spot",
    assetClass: "COMMODITY",
    base: "XAU",
    quote: "USD",
    precision: 2,
    minTradeSize: 0.01,
    maxLeverageRetail: 10,
    session: "24/5",
  },
  {
    symbol: "US500",
    name: "US 500 Index CFD",
    assetClass: "INDEX",
    base: "US500",
    quote: "USD",
    precision: 2,
    minTradeSize: 0.1,
    maxLeverageRetail: 20,
    session: "23/5",
  },
  {
    symbol: "US100",
    name: "US Tech 100 Index CFD",
    assetClass: "INDEX",
    base: "US100",
    quote: "USD",
    precision: 2,
    minTradeSize: 0.1,
    maxLeverageRetail: 20,
    session: "23/5",
  },
  {
    symbol: "DE40",
    name: "Germany 40 Index CFD",
    assetClass: "INDEX",
    base: "DE40",
    quote: "EUR",
    precision: 2,
    minTradeSize: 0.1,
    maxLeverageRetail: 20,
    session: "23/5",
  },
  {
    symbol: "UK100",
    name: "UK 100 Index CFD",
    assetClass: "INDEX",
    base: "UK100",
    quote: "GBP",
    precision: 2,
    minTradeSize: 0.1,
    maxLeverageRetail: 20,
    session: "23/5",
  },
  {
    symbol: "WTI",
    name: "WTI Crude Oil CFD",
    assetClass: "COMMODITY",
    base: "WTI",
    quote: "USD",
    precision: 2,
    minTradeSize: 1,
    maxLeverageRetail: 10,
    session: "23/5",
  },
  {
    symbol: "BRENT",
    name: "Brent Crude Oil CFD",
    assetClass: "COMMODITY",
    base: "BRENT",
    quote: "USD",
    precision: 2,
    minTradeSize: 1,
    maxLeverageRetail: 10,
    session: "23/5",
  },
  {
    symbol: "BTCUSD",
    name: "Bitcoin / US Dollar CFD",
    assetClass: "CRYPTO",
    base: "BTC",
    quote: "USD",
    precision: 2,
    minTradeSize: 0.001,
    maxLeverageRetail: 2,
    session: "24/7",
  },
  {
    symbol: "ETHUSD",
    name: "Ethereum / US Dollar CFD",
    assetClass: "CRYPTO",
    base: "ETH",
    quote: "USD",
    precision: 2,
    minTradeSize: 0.01,
    maxLeverageRetail: 2,
    session: "24/7",
  },
  {
    symbol: "AAPL",
    name: "Apple CFD",
    assetClass: "EQUITY",
    base: "AAPL",
    quote: "USD",
    precision: 2,
    minTradeSize: 1,
    maxLeverageRetail: 5,
    session: "US equities",
  },
  {
    symbol: "MSFT",
    name: "Microsoft CFD",
    assetClass: "EQUITY",
    base: "MSFT",
    quote: "USD",
    precision: 2,
    minTradeSize: 1,
    maxLeverageRetail: 5,
    session: "US equities",
  },
  {
    symbol: "NVDA",
    name: "NVIDIA CFD",
    assetClass: "EQUITY",
    base: "NVDA",
    quote: "USD",
    precision: 2,
    minTradeSize: 1,
    maxLeverageRetail: 5,
    session: "US equities",
  },
  {
    symbol: "TSLA",
    name: "Tesla CFD",
    assetClass: "EQUITY",
    base: "TSLA",
    quote: "USD",
    precision: 2,
    minTradeSize: 1,
    maxLeverageRetail: 5,
    session: "US equities",
  },
  {
    symbol: "AMZN",
    name: "Amazon CFD",
    assetClass: "EQUITY",
    base: "AMZN",
    quote: "USD",
    precision: 2,
    minTradeSize: 1,
    maxLeverageRetail: 5,
    session: "US equities",
  },
  {
    symbol: "USDCHF",
    name: "US Dollar / Swiss Franc",
    assetClass: "FX_MAJOR",
    base: "USD",
    quote: "CHF",
    precision: 5,
    minTradeSize: 1000,
    maxLeverageRetail: 30,
    session: "24/5",
  },
  {
    symbol: "SOLUSD",
    name: "Solana / US Dollar CFD",
    assetClass: "CRYPTO",
    base: "SOL",
    quote: "USD",
    precision: 2,
    minTradeSize: 0.1,
    maxLeverageRetail: 2,
    session: "24/7",
  },
  {
    symbol: "XAGUSD",
    name: "Silver Spot",
    assetClass: "COMMODITY",
    base: "XAG",
    quote: "USD",
    precision: 3,
    minTradeSize: 1,
    maxLeverageRetail: 10,
    session: "24/5",
  },
];

// Updated to real market prices – June 2026.
const basePrices: Record<string, number> = {
  EURUSD:  1.1522,
  GBPUSD:  1.3376,
  USDJPY:  144.80,
  EURGBP:  0.8615,
  AUDUSD:  0.6450,
  XAUUSD:  3310.00,
  US500:   5875.00,
  US100:   21100.00,
  DE40:    23500.00,
  UK100:   8700.00,
  WTI:     61.50,
  BRENT:   65.20,
  BTCUSD:  102000.00,
  ETHUSD:  2540.00,
  USDCHF:  0.8940,
  SOLUSD:  145.00,
  XAGUSD:  32.50,
  AAPL:    212.00,
  MSFT:    460.00,
  NVDA:    1320.00,
  TSLA:    340.00,
  AMZN:    210.00,
};

function createPrincipal(user: UserRecord): Principal {
  return {
    sub: user.id,
    email: user.email,
    fullName: user.fullName,
    tenantId: user.tenantId,
    tier: user.tier,
    roles: user.roles,
    permissions: user.permissions,
    kycStatus: user.kycStatus,
    mfaRequired: false,
    accountNumber: formatAccountNumber(user.id),
  };
}

export class BrokerState {
  private readonly signingKey: string;
  private readonly verifyKey: string;
  private readonly tokenVerifier?: (token: string) => import("./security.js").TokenPayload | null;
  private readonly _liveTradingEnabled: boolean;
  private readonly prisma?: PrismaClient;
  private _featureFlagsOverride: Record<string, boolean> = {};
  private readonly _amlAlerts = new Map<string, AmlAlert>();
  private readonly users = new Map<string, UserRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly quotes = new Map<string, Quote>();
  private readonly orders = new Map<string, OrderAck>();
  private readonly positions = new Map<string, Position>();
  private readonly clientAccounts = new Map<string, BrokerClientAccount>();
  private readonly liquidityControls = new Map<string, LiquidityControl>();
  private readonly audit: AuditRecord[] = [];
  private riskPolicy: BrokerRiskPolicy = {
    stopOutLevelPct: 50,
    maxDrawdownPct: 18,
    maxRiskPerTradePct: 2,
    negativeBalanceProtection: true,
    eventRiskMode: "normal",
    killSwitchEnabled: false,
    leveragePolicy: { ...leverageByAssetClass },
    updatedAt: nowIso(),
  };
  private olosGovernance: OlosGovernance = {
    autopilotEnabled: true,
    minConfidence: 0.78,
    maxRiskPerTradePct: 1.2,
    eventLockMinutes: 30,
    maxDailyAutopilotDrawdownPct: 5,
    modelStatus: "operational",
    activeModels: ["regime", "confidence", "sentiment", "flow", "risk", "scenario", "autopilot"],
    auditMode: "strict",
    updatedAt: nowIso(),
  };
  private tick = 0;

  constructor(options: {
    signingKey?: string;
    verifyKey?: string;
    /** @deprecated Pass signingKey/verifyKey instead */
    secret?: string;
    tokenVerifier?: (token: string) => import("./security.js").TokenPayload | null;
    liveTradingEnabled: boolean;
    prisma?: PrismaClient;
  }) {
    this.signingKey    = options.signingKey ?? options.secret ?? "dev-fallback";
    this.verifyKey     = options.verifyKey  ?? options.secret ?? "dev-fallback";
    this.tokenVerifier = options.tokenVerifier;
    this._liveTradingEnabled = options.liveTradingEnabled;
    this.prisma = options.prisma;
    this.seed();
  }

  seed(): void {
    const users: UserRecord[] = [
      {
        id: "usr_trader_demo",
        email: "trader@igfxpro.local",
        password: this._hashScrypt("OlosDemo!2026"),
        _passwordPlain: "OlosDemo!2026",
        fullName: "IGFXPRO Trader",
        tenantId: "tenant_igfxpro",
        tier: "PLATINUM",
        roles: ["trader"],
        permissions: [
          "trading:read",
          "trading:write",
          "wallet:read",
          "risk:read",
          "ai:read",
        ],
        kycStatus: "approved",
      },
      {
        id: "usr_admin_demo",
        email: "admin@igfxpro.local",
        password: this._hashScrypt("OlosAdmin!2026"),
        _passwordPlain: "OlosAdmin!2026",
        fullName: "IGFXPRO Admin",
        tenantId: "tenant_igfxpro",
        tier: "ENTERPRISE",
        roles: ["admin", "compliance", "risk"],
        permissions: ["*"],
        kycStatus: "approved",
      },
    ];

    users.forEach((user) => {
      this.users.set(user.email.toLowerCase(), user);
      if (user.roles.includes("trader")) {
        const account = this.createClientAccount(user);
        // Pre-fund demo trader so tier derives correctly (PLATINUM = equity ≥ 25 000)
        if (user.id === "usr_trader_demo") {
          const demoLedger: LedgerEntryRecord = {
            id: "ledger_demo_seed",
            type: "ADMIN_CAPITAL_ALLOCATION",
            amount: 100_000,
            status: "APPROVED",
            reference: "DEMO_SEED",
            note: "Initial demo capital allocation",
            createdAt: nowIso(),
          };
          const funded = this.recalculateClientAccount({ ...account, ledger: [demoLedger] });
          this.clientAccounts.set(user.id, funded);
        } else {
          this.clientAccounts.set(user.id, account);
        }
      }
    });
    instrumentsSeed.forEach((instrument) => {
      this.quotes.set(instrument.symbol, this.makeQuote(instrument.symbol, 0));
      this.liquidityControls.set(instrument.symbol, {
        symbol: instrument.symbol,
        enabled: true,
        spreadMarkupBps: instrument.assetClass === "CRYPTO" ? 18 : instrument.assetClass === "EQUITY" ? 8 : 4,
        mode: "internal_lp",
        maxDepth: instrument.assetClass === "FX_MAJOR" ? 18_000_000 : instrument.assetClass === "CRYPTO" ? 1_200_000 : 5_000_000,
        updatedAt: nowIso(),
      });
    });
  }


  private createClientAccount(user: UserRecord): BrokerClientAccount {
    const createdAt = nowIso();
    // NO AUTO-ALLOCATION: Cliente deve fare deposito e admin approva
    const allocated = 0;
    return this.recalculateClientAccount({
      userId: user.id,
      profile: {
        fullName: user.fullName,
        email: user.email,
        tier: user.tier,
        authKeyStatus: "VERIFIED",
        kycStatus: user.kycStatus === "approved" ? "APPROVED"
          : user.kycStatus === "rejected" ? "REJECTED"
          : user.kycStatus === "pending"  ? "PENDING_REVIEW"
          : "NOT_STARTED",
        mifidStatus: "COMPLETED",
      },
      capital: {
        allocated,
        equity: allocated,
        marginUsed: 0,
        freeMargin: allocated,
        unrealizedPnl: 0,
        riskScore: 0,
      },
      ledger: [],
      documents: [
        { id: "identity", label: "Documento identita", status: "MISSING", updatedAt: createdAt },
        { id: "address", label: "Prova indirizzo", status: "MISSING", updatedAt: createdAt },
        { id: "appropriateness", label: "Modulo appropriatezza MiFID", status: "APPROVED", updatedAt: createdAt },
        { id: "source_of_funds", label: "Fonte fondi", status: "MISSING", updatedAt: createdAt },
      ],
      settings: {
        olosNotifications: true,
        macroAlerts: true,
        orderConfirmations: true,
        autopilotSupervision: true,
      },
    });
  }

  private recalculateClientAccount(account: BrokerClientAccount): BrokerClientAccount {
    const allocated = account.ledger
      .filter((entry) =>
        (entry.type === "ADMIN_CAPITAL_ALLOCATION" || entry.type === "DEPOSIT_REQUEST" || entry.type === "WITHDRAW_REQUEST") &&
        entry.status === "APPROVED"
      )
      .reduce((sum, entry) => sum + entry.amount, 0);
    const marginUsed = this.getPositions().reduce((sum, position) => sum + position.marginUsed, 0);
    const unrealizedPnl = this.getPositions().reduce((sum, position) => sum + position.pnl, 0);
    const equity = allocated + unrealizedPnl;
    const freeMargin = Math.max(0, equity - marginUsed);
    const riskScore = Math.min(100, Math.round((marginUsed / Math.max(equity, 1)) * 100 + (freeMargin < equity * 0.25 ? 25 : 8)));

    return {
      ...account,
      profile: account.profile,
      capital: {
        allocated,
        equity,
        marginUsed,
        freeMargin,
        unrealizedPnl,
        riskScore,
      },
    };
  }

  private getUserById(userId: string): UserRecord | undefined {
    return [...this.users.values()].find((user) => user.id === userId);
  }

  private ensureClientAccount(userId: string): BrokerClientAccount {
    const existing = this.clientAccounts.get(userId);
    if (existing) {
      const recalculated = this.recalculateClientAccount(existing);
      this.clientAccounts.set(userId, recalculated);
      return recalculated;
    }
    const user = this.getUserById(userId) ?? this.users.get("trader@igfxpro.local");
    if (!user) throw new Error(`Unknown client account ${userId}`);
    const account = this.createClientAccount(user);
    this.clientAccounts.set(user.id, account);
    return account;
  }

  async initializePersistence(): Promise<void> {
    if (!this.prisma) return;

    await this.prisma.tenant.upsert({
      where: { id: "tenant_igfxpro" },
      update: {},
      create: {
        id: "tenant_igfxpro",
        name: "IGFXPRO",
        region: "EU",
      },
    });

    // System user for platform-generated signals and audit records.
    // Must exist before SignalGenerator persists OlosSignal rows.
    await this.prisma.user.upsert({
      where: { email: "system@igfxpro.internal" },
      update: {},
      create: {
        id: "sys_olos_engine",
        email: "system@igfxpro.internal",
        password: randomUUID(), // not usable for login
        fullName: "OLOS System Engine",
        role: "system",
        roles: ["system"],
        permissions: [],
        tier: "ENTERPRISE",
        kycStatus: "approved",
        tenantId: "tenant_igfxpro",
      },
    });

    for (const user of this.users.values()) {
      // Use argon2id when writing to DB — the in-memory scrypt hash is only for
      // sandbox login. If _passwordPlain is available we compute a fresh argon2 hash;
      // otherwise fall back to whatever is stored (may be scrypt, migrated lazily).
      const dbPassword = user._passwordPlain
        ? await argon2Hash(user._passwordPlain)
        : user.password;

      await this.prisma.user.upsert({
        where: { email: user.email },
        update: {
          // password intentionally excluded — never overwrite an existing hash in the DB
          fullName: user.fullName,
          role: user.roles[0] ?? "trader",
          roles: user.roles,
          permissions: user.permissions,
          tier: user.tier,
          kycStatus: user.kycStatus,
          tenantId: user.tenantId,
        },
        create: {
          id: user.id,
          email: user.email,
          password: dbPassword,
          fullName: user.fullName,
          role: user.roles[0] ?? "trader",
          roles: user.roles,
          permissions: user.permissions,
          tier: user.tier,
          kycStatus: user.kycStatus,
          tenantId: user.tenantId,
        },
      });
    }

    // Clear plain-text passwords from memory once DB writes are done.
    for (const user of this.users.values()) {
      user._passwordPlain = undefined;
    }

    for (const instrument of instrumentsSeed) {
      await this.prisma.instrument.upsert({
        where: { symbol: instrument.symbol },
        update: {
          name: instrument.name,
          assetClass: instrument.assetClass,
          base: instrument.base,
          quote: instrument.quote,
          precision: instrument.precision,
          minTradeSize: instrument.minTradeSize,
          maxLeverageRetail: instrument.maxLeverageRetail,
        },
        create: {
          symbol: instrument.symbol,
          name: instrument.name,
          assetClass: instrument.assetClass,
          base: instrument.base,
          quote: instrument.quote,
          precision: instrument.precision,
          minTradeSize: instrument.minTradeSize,
          maxLeverageRetail: instrument.maxLeverageRetail,
        },
      });
    }

    for (const account of this.clientAccounts.values()) {
      await this.persistClientAccount(account);
    }

    await this.hydrateFromDatabase();
  }

  private async hydrateFromDatabase(): Promise<void> {
    if (!this.prisma) return;

    const [users, sessions, orders, positions, audit, ledgerEntries, clientDocuments, brokerSettings] = await Promise.all([
      this.prisma.user.findMany(),
      this.prisma.session.findMany(),
      this.prisma.order.findMany({ orderBy: { createdAt: "desc" } }),
      this.prisma.position.findMany({ where: { closedAt: null } }),
      this.prisma.auditLog.findMany({ orderBy: { createdAt: "asc" }, take: 100 }),
      this.prisma.ledgerEntry.findMany({ orderBy: { createdAt: "desc" } }),
      this.prisma.clientDocument.findMany(),
      this.prisma.brokerSetting.findMany(),
    ]);

    this.users.clear();
    for (const user of users) {
      const roles = Array.isArray(user.roles) ? user.roles.map(String) : [user.role];
      const permissions = Array.isArray(user.permissions) ? user.permissions.map(String) : ["trading:read"];
      this.users.set(user.email.toLowerCase(), {
        id: user.id,
        email: user.email,
        password: user.password,
        fullName: user.fullName,
        tenantId: user.tenantId,
        tier: user.tier as UserRecord["tier"],
        roles: roles as UserRecord["roles"],
        permissions,
        kycStatus: user.kycStatus as UserRecord["kycStatus"],
      });
    }

    this.clientAccounts.clear();
    for (const user of this.users.values()) {
      if (user.roles.includes("trader")) {
        this.clientAccounts.set(user.id, this.createClientAccount(user));
      }
    }

    this.sessions.clear();
    sessions.forEach((session) => {
      this.sessions.set(session.refreshToken, {
        refreshToken: session.refreshToken,
        userId: session.userId,
        createdAt: session.createdAt.toISOString(),
      });
    });

    this.orders.clear();
    orders.forEach((order) => {
      this.orders.set(order.id, {
        id: order.id,
        clientOrderId: order.clientOrderId ?? undefined,
        symbol: order.symbol,
        side: order.side as OrderAck["side"],
        type: order.type as OrderAck["type"],
        quantity: Number(order.quantity),
        requestedPrice: order.requestedPrice ? Number(order.requestedPrice) : undefined,
        averageFillPrice: order.averageFillPrice ? Number(order.averageFillPrice) : undefined,
        status: order.status as OrderAck["status"],
        rejectionReason: order.rejectionReason ?? undefined,
        marginRequired: Number(order.marginRequired),
        notional: Number(order.notional),
        createdAt: order.createdAt.toISOString(),
      });
    });

    this.positions.clear();
    positions.forEach((position) => {
      this.positions.set(position.id, {
        id: position.id,
        symbol: position.symbol,
        side: position.side as Position["side"],
        quantity: Number(position.quantity),
        entryPrice: Number(position.entryPrice),
        markPrice: Number(position.entryPrice),
        pnl: 0,
        marginUsed: Number(position.marginUsed),
        leverage: position.leverage,
        openedAt: position.openedAt.toISOString(),
      });
    });

    this.audit.length = 0;
    audit.forEach((entry) => {
      this.audit.push({
        id: entry.id,
        actor: entry.actor,
        action: entry.action,
        entity: entry.entity,
        payload: typeof entry.payload === "object" && entry.payload ? entry.payload as Record<string, unknown> : {},
        createdAt: entry.createdAt.toISOString(),
      });
    });

    for (const account of this.clientAccounts.values()) {
      const accountLedger = ledgerEntries
        .filter((entry) => entry.userId === account.userId)
        .map((entry): LedgerEntryRecord => ({
          id: entry.id,
          createdAt: entry.createdAt.toISOString(),
          type: entry.type as LedgerEntryRecord["type"],
          amount: Number(entry.amount),
          status: entry.status as LedgerEntryRecord["status"],
          reference: entry.reference,
          note: entry.note,
        }));
      const documents = account.documents.map((document) => {
        const saved = clientDocuments.find((entry) => entry.userId === account.userId && entry.documentKey === document.id);
        return saved
          ? {
              id: saved.documentKey as ClientDocumentId,
              label: saved.label,
              status: saved.status as ClientDocumentStatus,
              updatedAt: saved.updatedAt.toISOString(),
              fileName: saved.fileName ?? undefined,
              rejectionReason: saved.rejectionReason ?? undefined,
            }
          : document;
      });
      this.clientAccounts.set(account.userId, this.recalculateClientAccount({
        ...account,
        ledger: accountLedger.length > 0 ? accountLedger : account.ledger,
        documents,
      }));
    }

    brokerSettings.forEach((setting) => this.applyBrokerSetting(setting.key, setting.value));
  }

  private applyBrokerSetting(key: string, value: Prisma.JsonValue): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (key === "riskPolicy") {
      this.riskPolicy = {
        ...this.riskPolicy,
        ...(value as Partial<BrokerRiskPolicy>),
        leveragePolicy: {
          ...this.riskPolicy.leveragePolicy,
          ...((value as Partial<BrokerRiskPolicy>).leveragePolicy ?? {}),
        },
      };
    }
    if (key === "olosGovernance") {
      this.olosGovernance = {
        ...this.olosGovernance,
        ...(value as Partial<OlosGovernance>),
      };
    }
    if (key === "liquidityControls") {
      Object.entries(value as Record<string, LiquidityControl>).forEach(([symbol, control]) => {
        this.liquidityControls.set(symbol, { ...control, symbol });
      });
    }
  }

  login(email: string, password: string) {
    const user = this.users.get(email.toLowerCase());
    if (!user) return null;
    if (!this._verifyScrypt(user.password, password)) return null;

    this.recordAudit(user.id, "auth.login", "session", { email });
    return this._issueTokens(user);
  }

  private _hashScrypt(plain: string): string {
    const salt = randomUUID().replace(/-/g, "");
    const h = scryptSync(plain, salt, 64).toString("hex");
    return `${salt}:${h}`;
  }

  private _verifyScrypt(stored: string, plain: string): boolean {
    const colon = stored.indexOf(":");
    if (colon < 1) return false;
    const salt = stored.slice(0, colon);
    const hash = stored.slice(colon + 1);
    try {
      const derived = scryptSync(plain, salt, 64).toString("hex");
      if (hash.length !== derived.length) return false;
      return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derived, "hex"));
    } catch {
      return false;
    }
  }

  private _issueTokens(user: UserRecord) {
    const principal = createPrincipal(user);
    const refreshToken = createOpaqueToken("refresh");
    this.sessions.set(refreshToken, {
      refreshToken,
      userId: user.id,
      createdAt: nowIso(),
    });
    void this.persistSession(refreshToken, user.id);

    return {
      accessToken: createToken(
        {
          sub: user.id,
          email: user.email,
          tenantId: user.tenantId,
          roles: user.roles,
          permissions: user.permissions,
        },
        this.signingKey
      ),
      refreshToken,
      expiresIn: 3600,
      tokenType: "Bearer" as const,
      principal,
      tenantId: user.tenantId,
    };
  }

  register(input: { email: string; password: string; fullName: string; country: string; tier?: Principal["tier"] }) {
    const existing = this.users.get(input.email.toLowerCase());
    if (existing) return this.login(input.email, input.password);

    const user: UserRecord = {
      id: randomUUID(),
      email: input.email,
      password: this._hashScrypt(input.password),
      _passwordPlain: input.password,
      fullName: input.fullName,
      tenantId: "tenant_igfxpro",
      tier: input.tier ?? "STANDARD",
      roles: ["trader"],
      permissions: ["trading:read", "wallet:read", "risk:read", "ai:read"],
      kycStatus: input.country.toUpperCase() === "IT" ? "pending" : "not_started",
    };
    this.users.set(user.email.toLowerCase(), user);
    this.clientAccounts.set(user.id, this.createClientAccount(user));
    void this.persistUser(user);
    void this.persistClientAccount(this.clientAccounts.get(user.id)!);
    this.recordAudit(user.id, "auth.register", "user", { email: user.email, country: input.country });
    return this.login(input.email, input.password);
  }

  refresh(refreshToken: string) {
    const session = this.sessions.get(refreshToken);
    if (!session) return null;
    const user = [...this.users.values()].find((candidate) => candidate.id === session.userId);
    if (!user) return null;
    // Issue new tokens directly — no password re-verification on token refresh.
    this.sessions.delete(refreshToken);
    return this._issueTokens(user);
  }

  resolvePrincipal(authHeader: string | undefined): Principal | null {
    const token = authHeader?.replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const payload = this.tokenVerifier
      ? this.tokenVerifier(token)
      : verifyToken(token, this.verifyKey);
    if (!payload) return null;
    // Check in-memory store first (sandbox mode)
    const memUser = [...this.users.values()].find((c) => c.id === payload.sub);
    if (memUser) return createPrincipal(memUser);
    // For DB-backed sessions, reconstruct principal from JWT payload directly.
    // The JWT was signed with our key and contains all required claims.
    if (payload.sub && payload.tenantId) {
      type PrincipalRole = import("./contracts.js").Principal["roles"][number];
      const validRoles: PrincipalRole[] = ["trader","admin","super_admin","risk","compliance"];
      const roles = (payload.roles ?? ["trader"])
        .filter((r): r is PrincipalRole => validRoles.includes(r as PrincipalRole));
      return {
        sub:         payload.sub,
        email:       payload.email,
        fullName:    "",
        tenantId:    payload.tenantId,
        roles,
        permissions: payload.permissions ?? [],
        tier:        "STANDARD" as import("./contracts.js").Principal["tier"],
        kycStatus:   "not_started" as const,
        mfaRequired: false,
        accountNumber: formatAccountNumber(payload.sub),
      };
    }
    return null;
  }

  getTenant() {
    return {
      id: "tenant_igfxpro",
      slug: "igfxpro",
      name: "IGFXPRO",
      region: "EU",
      defaultCurrency: "EUR",
      regulatoryProfile: "MiFID II / ESMA CFD controls",
      branding: {
        accent: "#22d3ee",
        logoUrl: "/assets/logos/primary-logo.svg",
      },
      features: ["olos-ai", "sandbox-execution", "negative-balance-protection"],
    };
  }

  getFeatureFlags() {
    return {
      aiTrading: true,
      smartSignals: true,
      brokerControlCenter: true,
      hedgeAutomation: true,
      institutionalCharts: true,
      olosAi: true,
      sandboxExecution: false,
      liveTrading: this._liveTradingEnabled || true,
      negativeBalanceProtection: true,
      esmaRetailLeverage: true,
      kycRequiredBeforeLive: true,
      ...this._featureFlagsOverride,
    };
  }

  updateFeatureFlags(flags: Record<string, boolean>, actor: string): void {
    this._featureFlagsOverride = { ...this._featureFlagsOverride, ...flags };
    this.recordAudit(actor, "admin.feature_flags_updated", "platform", flags);
    void this.persistBrokerSetting("featureFlagsOverride", this._featureFlagsOverride);
  }

  getAmlAlerts(): AmlAlert[] {
    // Seed from ledger: high-value deposits/withdrawals that were flagged
    if (this._amlAlerts.size === 0) {
      for (const account of this.clientAccounts.values()) {
        for (const entry of account.ledger) {
          if (
            (entry.type === "DEPOSIT_REQUEST" || entry.type === "WITHDRAW_REQUEST") &&
            entry.amount >= 10000
          ) {
            const id = `AML-${entry.id.slice(0, 8).toUpperCase()}`;
            if (!this._amlAlerts.has(id)) {
              this._amlAlerts.set(id, {
                id,
                userId:   account.userId,
                userName: account.profile.fullName,
                email:    account.profile.email,
                type:     entry.amount >= 50000 ? "HIGH_VALUE" : "FREQUENT",
                amount:   entry.amount,
                timestamp: entry.createdAt,
                status:   entry.status === "APPROVED" ? "CLEARED" : "PENDING",
              });
            }
          }
        }
      }
    }
    return [...this._amlAlerts.values()].sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  reviewAmlAlert(id: string, status: "REVIEWED" | "CLEARED", actor: string, note?: string): AmlAlert {
    const alert = this._amlAlerts.get(id);
    if (!alert) throw Object.assign(new Error(`AML alert ${id} not found`), { status: 404 });
    const updated: AmlAlert = { ...alert, status, reviewedBy: actor, note };
    this._amlAlerts.set(id, updated);
    this.recordAudit(actor, `admin.aml_alert_${status.toLowerCase()}`, id, { note });
    return updated;
  }

  getEconomicCalendar(): EconomicCalendarEvent[] {
    const base = new Date();
    const events = [
      {
        id: "evt_ecb_rate",
        offsetMinutes: 42,
        country: "EU",
        currency: "EUR",
        impact: "CRITICAL" as const,
        event: "ECB rate decision and press conference",
        previous: "4.00%",
        forecast: "4.00%",
        affectedSymbols: ["EURUSD", "EURGBP", "DE40", "XAUUSD"],
        olosScenario: "Blocca Autopilot 30 minuti prima e dopo, riduci size FX EUR del 50%.",
      },
      {
        id: "evt_us_cpi",
        offsetMinutes: 128,
        country: "US",
        currency: "USD",
        impact: "CRITICAL" as const,
        event: "US CPI inflation release",
        previous: "3.4%",
        forecast: "3.3%",
        affectedSymbols: ["EURUSD", "USDJPY", "US500", "US100", "XAUUSD", "BTCUSD"],
        olosScenario: "Attiva volatility shield, spread monitor e segnali solo sopra confidence minima.",
      },
      {
        id: "evt_nfp",
        offsetMinutes: 310,
        country: "US",
        currency: "USD",
        impact: "HIGH" as const,
        event: "Nonfarm payrolls and unemployment rate",
        previous: "175K / 3.9%",
        forecast: "185K / 3.9%",
        affectedSymbols: ["EURUSD", "GBPUSD", "USDJPY", "US500", "XAUUSD"],
        olosScenario: "Countdown prioritario, no market orders senza conferma, alert slippage.",
      },
      {
        id: "evt_uk_pmi",
        offsetMinutes: 520,
        country: "UK",
        currency: "GBP",
        impact: "MEDIUM" as const,
        event: "UK services PMI",
        previous: "54.1",
        forecast: "53.8",
        affectedSymbols: ["GBPUSD", "EURGBP", "UK100"],
        olosScenario: "Controllo correlazione GBP e conferma trend su H1.",
      },
      {
        id: "evt_oil_stock",
        offsetMinutes: 780,
        country: "US",
        currency: "USD",
        impact: "HIGH" as const,
        event: "EIA crude oil inventories",
        previous: "-1.4M",
        forecast: "-0.8M",
        affectedSymbols: ["WTI", "BRENT", "US500"],
        olosScenario: "Monitora depth e liquidity sweep su WTI/BRENT.",
      },
    ];

    return events.map((event) => {
      const time = new Date(base.getTime() + event.offsetMinutes * 60_000);
      return {
        ...event,
        time: time.toISOString(),
        countdownSeconds: Math.max(0, Math.floor((time.getTime() - Date.now()) / 1000)),
      };
    });
  }

  getIndicatorSnapshot(symbol: string, timeframe = "15M"): IndicatorSnapshot | null {
    const normalized = symbol.toUpperCase();
    const quote = this.getQuote(normalized);
    const instrument = instrumentsSeed.find((item) => item.symbol === normalized);
    if (!quote || !instrument) return null;

    const precision = instrument.precision;
    const history = Array.from({ length: 64 }, (_, index) => {
      const wave = Math.sin((this.tick + index + normalized.length) / 5) * 0.004;
      const drift = Math.cos((this.tick + index) / 11) * 0.002;
      return quote.mid * (1 + wave + drift);
    });
    const avg = (items: number[]) => items.reduce((sum, item) => sum + item, 0) / Math.max(items.length, 1);
    const last = history.at(-1) ?? quote.mid;
    const gains = history.slice(1).map((value, index) => Math.max(0, value - history[index]));
    const losses = history.slice(1).map((value, index) => Math.max(0, history[index] - value));
    const rs = avg(gains.slice(-14)) / Math.max(avg(losses.slice(-14)), 0.000001);
    const rsi = 100 - 100 / (1 + rs);
    const ema = (period: number) => {
      const k = 2 / (period + 1);
      return history.reduce((previous, value) => value * k + previous * (1 - k), history[0] ?? quote.mid);
    };
    const ema12 = ema(12);
    const ema26 = ema(26);
    const macdValue = ema12 - ema26;
    const macdSignal = macdValue * 0.82;
    const ema20 = ema(20);
    const ema50 = ema(50);
    const variance = avg(history.map((value) => (value - avg(history)) ** 2));
    const stdev = Math.sqrt(variance);
    const high = Math.max(...history);
    const low = Math.min(...history);
    const fibLevels = [
      ["0.236", high - (high - low) * 0.236],
      ["0.382", high - (high - low) * 0.382],
      ["0.500", high - (high - low) * 0.5],
      ["0.618", high - (high - low) * 0.618],
      ["0.786", high - (high - low) * 0.786],
    ] as Array<[string, number]>;

    return {
      symbol: normalized,
      timeframe,
      price: Number(last.toFixed(precision)),
      generatedAt: nowIso(),
      rsi: Number(rsi.toFixed(2)),
      macd: {
        value: Number(macdValue.toFixed(precision)),
        signal: Number(macdSignal.toFixed(precision)),
        histogram: Number((macdValue - macdSignal).toFixed(precision)),
        bias: macdValue > macdSignal ? "bullish" : macdValue < macdSignal ? "bearish" : "neutral",
      },
      ema: {
        ema20: Number(ema20.toFixed(precision)),
        ema50: Number(ema50.toFixed(precision)),
        trend: ema20 > ema50 * 1.0005 ? "uptrend" : ema20 < ema50 * 0.9995 ? "downtrend" : "range",
      },
      vwap: Number((avg(history.slice(-24)) * 0.998 + last * 0.002).toFixed(precision)),
      bollinger: {
        upper: Number((avg(history) + stdev * 2).toFixed(precision)),
        middle: Number(avg(history).toFixed(precision)),
        lower: Number((avg(history) - stdev * 2).toFixed(precision)),
        bandwidthPct: Number(((stdev * 4 / last) * 100).toFixed(2)),
      },
      fibonacci: fibLevels.map(([level, price]) => ({ level, price: Number(price.toFixed(precision)) })),
      smartMoney: {
        bias: quote.changePct > 0.08 ? "accumulation" : quote.changePct < -0.08 ? "distribution" : "neutral",
        orderBlock: `${Number((last * 0.997).toFixed(precision))} - ${Number((last * 1.001).toFixed(precision))}`,
        liquiditySweep: quote.changePct >= 0 ? "Buy-side liquidity sweep watch" : "Sell-side liquidity sweep watch",
        volumeProfile: `POC ${Number(avg(history.slice(-32)).toFixed(precision))}, value area ${Number((last * 0.994).toFixed(precision))}/${Number((last * 1.006).toFixed(precision))}`,
      },
    };
  }

  getRiskPolicy(): BrokerRiskPolicy {
    return { ...this.riskPolicy, leveragePolicy: { ...this.riskPolicy.leveragePolicy } };
  }

  getLiquidityControls(): LiquidityControl[] {
    return [...this.liquidityControls.values()];
  }

  getOlosGovernance(): OlosGovernance {
    return { ...this.olosGovernance, activeModels: [...this.olosGovernance.activeModels] };
  }

  getAutopilotConfig(userId: string) {
    const account = this.ensureClientAccount(userId);
    const rank: Record<Principal["tier"], number> = { STANDARD: 1, GOLD: 2, PLATINUM: 3, VIP: 4, ENTERPRISE: 5 };
    const enabled = this.olosGovernance.autopilotEnabled && rank[account.profile.tier] >= rank.PLATINUM && !this.riskPolicy.killSwitchEnabled;
    const topSignal = this.getAiSignals()[0];
    return {
      userId,
      tier: account.profile.tier,
      enabled,
      mode: enabled ? (rank[account.profile.tier] >= rank.ENTERPRISE ? "enterprise_review" : "supervised") : "locked",
      minConfidence: this.olosGovernance.minConfidence,
      maxRiskPerTradePct: this.olosGovernance.maxRiskPerTradePct,
      eventLockMinutes: this.olosGovernance.eventLockMinutes,
      allowedSymbols: this.getQuotes().slice(0, rank[account.profile.tier] * 4).map((quote) => quote.symbol),
      activeRules: [
        "No execution during admin kill switch",
        "No autopilot inside high-impact event lock window",
        "Respect ESMA leverage caps and negative balance protection",
        `Reject signal below ${Math.round(this.olosGovernance.minConfidence * 100)}% confidence`,
      ],
      lastDecision: {
        symbol: topSignal?.symbol ?? "EURUSD",
        action: !enabled || !topSignal || topSignal.confidence < this.olosGovernance.minConfidence
          ? "WAIT"
          : topSignal.direction === "SELL"
            ? "ARM_SELL"
            : "ARM_BUY",
        reason: !enabled
          ? "Autopilot bloccato dal tier, governance o kill switch."
          : topSignal?.rationale ?? "In attesa di nuovo segnale OLOS.",
      },
    };
  }

  async getAdminWorkspace() {
    const ledger = this.getClientAccounts().flatMap((account) =>
      account.ledger.map((entry) => ({ ...entry, userId: account.userId, clientName: account.profile.fullName }))
    );
    const approvedDeposits = ledger
      .filter((entry) => entry.type === "DEPOSIT_REQUEST" && entry.status === "APPROVED")
      .reduce((sum, entry) => sum + entry.amount, 0);
    const approvedWithdrawals = ledger
      .filter((entry) => entry.type === "WITHDRAW_REQUEST" && entry.status === "APPROVED")
      .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);

    return {
      overview: {
        realRegisteredUsers: this.users.size,
        kycQueue: this.getClientAccounts().reduce((sum, account) => sum + account.documents.filter((document) => document.status === "PENDING_REVIEW").length, 0),
        orders: this.orders.size,
        approvedDeposits,
        approvedWithdrawals,
      },
      accounts: this.getClientAccounts(),
      quotes: this.getQuotes(),
      positions: this.getPositions(),
      orders: this.getOrders(),
      riskPolicy: this.getRiskPolicy(),
      liquidityControls: this.getLiquidityControls(),
      olosGovernance: this.getOlosGovernance(),
      serviceHealth: await this.getServiceHealth(),
      calendar: this.getEconomicCalendar(),
      audit: this.getAudit(),
    };
  }

  getClientAccounts(): BrokerClientAccount[] {
    return [...this.clientAccounts.values()].map((account) => this.recalculateClientAccount(account));
  }

  getClientAccount(userId: string): BrokerClientAccount {
    return this.ensureClientAccount(userId);
  }

  createDepositRequest(userId: string, input: { amount: number; method: string; details?: string }): BrokerClientAccount {
    const account = this.ensureClientAccount(userId);
    const entry: LedgerEntryRecord = {
      id: randomUUID(),
      createdAt: nowIso(),
      type: "DEPOSIT_REQUEST",
      amount: input.amount,
      status: "PENDING_ADMIN",
      reference: input.details?.trim() || input.method,
      note: `Richiesta deposito ${input.method}${input.details ? `: ${input.details}` : ""} in coda admin/KYC/AML/admin.`,
    };
    const next = this.recalculateClientAccount({ ...account, ledger: [entry, ...account.ledger] });
    this.clientAccounts.set(userId, next);
    void this.persistLedgerEntry(userId, entry);
    this.recordAudit(userId, "wallet.deposit_requested", "ledger", entry);
    return next;
  }

  createWithdrawRequest(userId: string, input: { amount: number; destination: string; method: string }): BrokerClientAccount {
    const account = this.ensureClientAccount(userId);
    const status = input.amount <= account.capital.freeMargin ? "PENDING_ADMIN" : "REJECTED";
    const entry: LedgerEntryRecord = {
      id: randomUUID(),
      createdAt: nowIso(),
      type: "WITHDRAW_REQUEST",
      amount: -Math.abs(input.amount),
      status,
      reference: input.destination,
      note:
        status === "PENDING_ADMIN"
          ? `Richiesta prelievo ${input.method} verso ${input.destination} in coda KYC/AML/admin.`
          : "Prelievo rifiutato: free margin insufficiente.",
    };
    const next = this.recalculateClientAccount({ ...account, ledger: [entry, ...account.ledger] });
    this.clientAccounts.set(userId, next);
    void this.persistLedgerEntry(userId, entry);
    this.recordAudit(userId, "wallet.withdraw_requested", "ledger", entry);
    return next;
  }

  uploadClientDocument(userId: string, input: { documentId: ClientDocumentId; fileName: string }): BrokerClientAccount {
    const account = this.ensureClientAccount(userId);
    const documents = account.documents.map((document) =>
      document.id === input.documentId
        ? { ...document, status: "PENDING_REVIEW" as const, fileName: input.fileName, rejectionReason: undefined, updatedAt: nowIso() }
        : document
    );
    const entry: LedgerEntryRecord = {
      id: randomUUID(),
      createdAt: nowIso(),
      type: "DOCUMENT_EVENT",
      amount: 0,
      status: "PENDING_ADMIN",
      reference: input.documentId,
      note: `${input.fileName} caricato dal cliente e in revisione.`,
    };
    const next = this.recalculateClientAccount({ ...account, documents, ledger: [entry, ...account.ledger] });
    this.clientAccounts.set(userId, next);
    void this.persistClientDocument(userId, documents.find((document) => document.id === input.documentId)!);
    void this.persistLedgerEntry(userId, entry);
    this.recordAudit(userId, "kyc.document_uploaded", "client_document", entry);
    return next;
  }

  adminAllocateCapital(actor: Principal, input: { userId: string; amount: number; note: string }): BrokerClientAccount {
    const account = this.ensureClientAccount(input.userId);
    const entry: LedgerEntryRecord = {
      id: randomUUID(),
      createdAt: nowIso(),
      type: "ADMIN_CAPITAL_ALLOCATION",
      amount: input.amount,
      status: "APPROVED",
      reference: "BROKER_CONTROL_CENTER",
      note: input.note,
    };
    const next = this.recalculateClientAccount({ ...account, ledger: [entry, ...account.ledger] });
    this.clientAccounts.set(input.userId, next);
    void this.persistLedgerEntry(input.userId, entry);
    void this.persistWalletBalance(input.userId, next.capital.allocated);
    this.recordAudit(actor.sub, "admin.capital_allocated", "client_account", { userId: input.userId, entry });
    return next;
  }

  adminWithdrawCapital(actor: Principal, input: { userId: string; amount: number; note: string }): BrokerClientAccount {
    const account = this.ensureClientAccount(input.userId);
    const entry: LedgerEntryRecord = {
      id: randomUUID(),
      createdAt: nowIso(),
      type: "WITHDRAW_REQUEST",
      amount: -input.amount, // Negative amount for withdrawal
      status: "APPROVED",
      reference: "BROKER_CONTROL_CENTER",
      note: input.note,
    };
    const next = this.recalculateClientAccount({ ...account, ledger: [entry, ...account.ledger] });
    this.clientAccounts.set(input.userId, next);
    void this.persistLedgerEntry(input.userId, entry);
    void this.persistWalletBalance(input.userId, next.capital.allocated);
    this.recordAudit(actor.sub, "admin.capital_withdrawn", "client_account", { userId: input.userId, entry });
    return next;
  }

  adminReviewDocument(
    actor: Principal,
    input: { userId: string; documentId: ClientDocumentId; status: "APPROVED" | "REJECTED"; rejectionReason?: string }
  ): BrokerClientAccount {
    const account = this.ensureClientAccount(input.userId);
    const documents = account.documents.map((document) =>
      document.id === input.documentId
        ? {
            ...document,
            status: input.status,
            rejectionReason: input.status === "REJECTED" ? input.rejectionReason ?? "Documento non conforme." : undefined,
            updatedAt: nowIso(),
          }
        : document
    );
    const entry: LedgerEntryRecord = {
      id: randomUUID(),
      createdAt: nowIso(),
      type: "DOCUMENT_EVENT",
      amount: 0,
      status: input.status,
      reference: input.documentId,
      note: input.status === "APPROVED" ? "Documento approvato da admin." : input.rejectionReason ?? "Documento rifiutato da admin.",
    };

    // When all documents reach APPROVED status, promote the user's KYC to "approved".
    // This is what the risk engine checks (prisma.user.kycStatus) to allow trading.
    const allApproved = documents.every((d) => d.status === "APPROVED");
    const anyRejected = documents.some((d) => d.status === "REJECTED");
    const newKycStatus: UserRecord["kycStatus"] = allApproved
      ? "approved"
      : anyRejected
      ? "rejected"
      : "pending";

    const user = this.getUserById(input.userId);
    if (user && user.kycStatus !== newKycStatus) {
      user.kycStatus = newKycStatus;
      this.users.set(user.email.toLowerCase(), user);
      void this.persistUser(user);
    }

    const next = this.recalculateClientAccount({
      ...account,
      documents,
      ledger: [entry, ...account.ledger],
      profile: {
        ...account.profile,
        kycStatus: allApproved ? "APPROVED" : anyRejected ? "REJECTED" : "PENDING_REVIEW",
      },
    });
    this.clientAccounts.set(input.userId, next);
    void this.persistClientDocument(input.userId, documents.find((document) => document.id === input.documentId)!);
    void this.persistLedgerEntry(input.userId, entry);
    this.recordAudit(actor.sub, "admin.document_reviewed", "client_document", { ...input, newKycStatus });
    return next;
  }

  adminSetKycStatus(
    actor: Principal,
    input: { userId: string; kycStatus: "approved" | "rejected" | "pending" }
  ): BrokerClientAccount {
    const user = this.getUserById(input.userId);
    if (!user) throw new Error(`Unknown user ${input.userId}`);
    user.kycStatus = input.kycStatus;
    this.users.set(user.email.toLowerCase(), user);
    void this.persistUser(user);

    const account = this.ensureClientAccount(input.userId);
    const kycProfileStatus =
      input.kycStatus === "approved" ? "APPROVED" as const
      : input.kycStatus === "rejected" ? "REJECTED" as const
      : "PENDING_REVIEW" as const;

    // Also mark all documents as APPROVED when admin force-approves KYC
    const documents = input.kycStatus === "approved"
      ? account.documents.map((d) => ({ ...d, status: "APPROVED" as const, updatedAt: nowIso() }))
      : account.documents;

    const next = this.recalculateClientAccount({
      ...account,
      documents,
      profile: { ...account.profile, kycStatus: kycProfileStatus },
    });
    this.clientAccounts.set(input.userId, next);
    if (input.kycStatus === "approved") {
      documents.forEach((d) => void this.persistClientDocument(input.userId, d));
    }
    this.recordAudit(actor.sub, "admin.kyc_status_set", "client_account", input);
    return next;
  }

  adminReviewLedger(
    actor: Principal,
    input: { userId: string; ledgerId: string; status: "APPROVED" | "REJECTED"; note?: string }
  ): BrokerClientAccount {
    const account = this.ensureClientAccount(input.userId);
    const target = account.ledger.find((entry) => entry.id === input.ledgerId);
    if (!target) throw new Error(`Unknown ledger entry ${input.ledgerId}`);

    const ledger = account.ledger.map((entry) =>
      entry.id === input.ledgerId
        ? {
            ...entry,
            status: input.status,
            note: input.note ?? (input.status === "APPROVED" ? "Movimento approvato da admin." : "Movimento rifiutato da admin."),
          }
        : entry
    );
    
    const reviewed = ledger.find((entry) => entry.id === input.ledgerId)!;
    
    // Auto-allocate capital when DEPOSIT_REQUEST is approved
    let finalLedger = ledger;
    if (input.status === "APPROVED" && reviewed.type === "DEPOSIT_REQUEST") {
      const allocationEntry: LedgerEntryRecord = {
        id: randomUUID(),
        createdAt: nowIso(),
        type: "ADMIN_CAPITAL_ALLOCATION",
        amount: reviewed.amount,
        status: "APPROVED",
        reference: `DEPOSIT_${reviewed.id}`,
        note: `Capitale allocato automaticamente da deposito approvato. ${reviewed.note}`,
      };
      finalLedger = [allocationEntry, ...ledger];
    }
    
    // Auto-withdraw capital when WITHDRAW_REQUEST is approved
    if (input.status === "APPROVED" && reviewed.type === "WITHDRAW_REQUEST") {
      const withdrawalEntry: LedgerEntryRecord = {
        id: randomUUID(),
        createdAt: nowIso(),
        type: "ADMIN_CAPITAL_ALLOCATION",
        amount: reviewed.amount, // Already negative from client
        status: "APPROVED",
        reference: `WITHDRAWAL_${reviewed.id}`,
        note: `Capitale rimosso automaticamente da prelievo approvato. ${reviewed.note}`,
      };
      finalLedger = [withdrawalEntry, ...ledger];
    }
    
    const next = this.recalculateClientAccount({ ...account, ledger: finalLedger });
    this.clientAccounts.set(input.userId, next);
    void this.persistLedgerEntry(input.userId, reviewed);
    if (finalLedger.length > ledger.length) {
      const newEntry = finalLedger[0];
      void this.persistLedgerEntry(input.userId, newEntry);
    }
    this.recordAudit(actor.sub, "admin.ledger_reviewed", "ledger", { userId: input.userId, entry: reviewed });
    return next;
  }

  adminUpdateTier(actor: Principal, input: { userId: string; tier: Principal["tier"] }): BrokerClientAccount {
    const user = this.getUserById(input.userId);
    if (!user) throw new Error(`Unknown user ${input.userId}`);
    user.tier = input.tier;
    this.users.set(user.email.toLowerCase(), user);
    const account = this.ensureClientAccount(input.userId);
    const next = this.recalculateClientAccount({
      ...account,
      profile: {
        ...account.profile,
        tier: input.tier,
      },
    });
    this.clientAccounts.set(input.userId, next);
    void this.persistUser(user);
    this.recordAudit(actor.sub, "admin.tier_updated", "client_account", input);
    return next;
  }

  adminUpdateLiquidity(
    actor: Principal,
    input: { symbol: string; enabled?: boolean; spreadMarkupBps?: number; mode?: LiquidityControl["mode"] }
  ): LiquidityControl {
    const symbol = input.symbol.toUpperCase();
    const existing = this.liquidityControls.get(symbol);
    if (!existing) throw new Error(`Unknown liquidity symbol ${symbol}`);
    const next: LiquidityControl = {
      ...existing,
      enabled: input.enabled ?? existing.enabled,
      spreadMarkupBps: input.spreadMarkupBps ?? existing.spreadMarkupBps,
      mode: input.mode ?? existing.mode,
      updatedAt: nowIso(),
    };
    this.liquidityControls.set(symbol, next);
    void this.persistBrokerSetting("liquidityControls", Object.fromEntries(this.liquidityControls.entries()));
    this.quotes.set(symbol, this.makeQuote(symbol, this.tick));
    this.recordAudit(actor.sub, "admin.liquidity_updated", "liquidity_control", next);
    return next;
  }

  adminToggleKillSwitch(actor: Principal, input: { enabled: boolean; reason: string }): BrokerRiskPolicy {
    this.riskPolicy = {
      ...this.riskPolicy,
      killSwitchEnabled: input.enabled,
      killSwitchReason: input.enabled ? input.reason : undefined,
      updatedAt: nowIso(),
    };
    void this.persistBrokerSetting("riskPolicy", this.riskPolicy);
    this.recordAudit(actor.sub, "admin.kill_switch", "risk_policy", input);
    return this.getRiskPolicy();
  }

  adminUpdateRiskPolicy(
    actor: Principal,
    input: {
      stopOutLevelPct?: number;
      maxDrawdownPct?: number;
      maxRiskPerTradePct?: number;
      negativeBalanceProtection?: boolean;
      eventRiskMode?: BrokerRiskPolicy["eventRiskMode"];
    }
  ): BrokerRiskPolicy {
    this.riskPolicy = {
      ...this.riskPolicy,
      ...input,
      updatedAt: nowIso(),
    };
    void this.persistBrokerSetting("riskPolicy", this.riskPolicy);
    this.recordAudit(actor.sub, "admin.risk_policy_updated", "risk_policy", input);
    return this.getRiskPolicy();
  }

  adminUpdateOlosGovernance(
    actor: Principal,
    input: {
      autopilotEnabled?: boolean;
      minConfidence?: number;
      maxRiskPerTradePct?: number;
      eventLockMinutes?: number;
      maxDailyAutopilotDrawdownPct?: number;
      modelStatus?: OlosGovernance["modelStatus"];
    }
  ): OlosGovernance {
    this.olosGovernance = {
      ...this.olosGovernance,
      ...input,
      updatedAt: nowIso(),
    };
    void this.persistBrokerSetting("olosGovernance", this.olosGovernance);
    this.recordAudit(actor.sub, "admin.olos_governance_updated", "olos_governance", input);
    return this.getOlosGovernance();
  }

  getInstruments(): Instrument[] {
    return instrumentsSeed;
  }

  updateQuotes(): Quote[] {
    this.tick += 1;
    for (const instrument of instrumentsSeed) {
      const quote = this.makeQuote(instrument.symbol, this.tick);
      this.quotes.set(instrument.symbol, quote);
      eventBus.emit("market.quote", {
        symbol:    quote.symbol,
        bid:       quote.bid,
        ask:       quote.ask,
        mid:       quote.mid,
        spread:    quote.spread,
        changePct: quote.changePct,
        timestamp: quote.ts,
      });
    }
    return this.getQuotes();
  }

  getQuotes(): Quote[] {
    const liveQuotes = quoteCache.getAll();
    if (liveQuotes.length === 0) return [...this.quotes.values()];

    // Merge: live price takes priority; fall back to synthetic for any
    // symbol the feed hasn't delivered yet (partial quoteCache state).
    const liveMap = new Map(liveQuotes.map(q => [q.symbol, q]));
    return instrumentsSeed.map(
      (inst) => liveMap.get(inst.symbol) ?? this.makeQuote(inst.symbol, this.tick),
    );
  }

  getLiquidityBook(symbol: string): LiquidityBook | null {
    const quote = this.getQuote(symbol);
    return quote ? LiquidityProvider.buildBook(quote) : null;
  }

  getQuote(symbol: string): Quote | null {
    return this.quotes.get(symbol.toUpperCase()) ?? null;
  }

  placeOrder(order: NewOrderRequest, principal: Principal): OrderAck {
    if (this.riskPolicy.killSwitchEnabled) {
      return this.reject(order, `Global kill switch active: ${this.riskPolicy.killSwitchReason ?? "admin risk policy"}`, principal.sub);
    }

    const instrument = instrumentsSeed.find((item) => item.symbol === order.symbol.toUpperCase());
    if (!instrument) {
      return this.reject(order, "UNKNOWN_INSTRUMENT", principal.sub);
    }

    const control = this.liquidityControls.get(instrument.symbol);
    if (!control?.enabled || control.mode === "halted") {
      return this.reject(order, `Liquidity halted for ${instrument.symbol}`, principal.sub);
    }

    if (this.riskPolicy.eventRiskMode === "blocked") {
      return this.reject(order, "Event risk mode blocks new orders", principal.sub);
    }

    const quote = this.getQuote(instrument.symbol) ?? this.makeQuote(instrument.symbol, this.tick);
    const liquidityBook = LiquidityProvider.buildBook(quote);
    const fill = LiquidityProvider.calculateFillFromBook(liquidityBook, order.side, order.quantity);
    const executionPrice = fill.averagePrice;
    const maxRetailLeverage = this.riskPolicy.leveragePolicy[instrument.assetClass] ?? leverageByAssetClass[instrument.assetClass];
    if (order.leverage > maxRetailLeverage) {
      return this.reject(
        order,
        `ESMA retail leverage cap exceeded for ${instrument.assetClass}: max ${maxRetailLeverage}:1`,
        principal.sub
      );
    }

    if (order.quantity < instrument.minTradeSize) {
      return this.reject(order, `Minimum trade size is ${instrument.minTradeSize}`, principal.sub);
    }

    const notional = executionPrice * order.quantity;
    const marginRequired = notional / order.leverage;
    const wallet = this.getWallet(principal.sub);
    if (marginRequired > wallet.freeMargin) {
      return this.reject(order, "Insufficient free margin under negative balance protection policy", principal.sub);
    }

    const ack: OrderAck = {
      id: randomUUID(),
      clientOrderId: order.clientOrderId,
      symbol: instrument.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      requestedPrice: order.price,
      averageFillPrice: executionPrice,
      status: "FILLED",
      marginRequired,
      notional,
      createdAt: nowIso(),
    };

    this.orders.set(ack.id, ack);
    const position: Position = {
      id: ack.id,
      symbol: instrument.symbol,
      side: order.side,
      quantity: order.quantity,
      entryPrice: executionPrice,
      markPrice: executionPrice,
      pnl: 0,
      marginUsed: marginRequired,
      leverage: order.leverage,
      openedAt: ack.createdAt,
    };
    this.positions.set(ack.id, position);
    void this.persistFilledOrder(ack, position, principal.sub);
    this.recordAudit(principal.sub, "trading.order_filled", "order", ack);

    eventBus.emit("order.filled", {
      orderId: ack.id,
      userId: principal.sub,
      symbol: ack.symbol,
      side: ack.side,
      quantity: ack.quantity,
      averageFillPrice: ack.averageFillPrice ?? executionPrice,
      marginRequired,
      notional,
      leverage: order.leverage,
      timestamp: ack.createdAt,
    });
    eventBus.emit("position.opened", {
      positionId: position.id,
      userId: principal.sub,
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      marginUsed: position.marginUsed,
      leverage: position.leverage,
      timestamp: position.openedAt,
    });

    return ack;
  }

  getOrders(): OrderAck[] {
    return [...this.orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Manual position close for sandbox mode (no DB). */
  closePositionInMemory(
    positionId: string,
    userId:     string,
  ): { ok: true; positionId: string; symbol: string; pnl: number; exitPrice: number; side: "BUY" | "SELL"; quantity: number; entryPrice: number }
   | { ok: false; reason: string } {
    const pos = this.positions.get(positionId);
    if (!pos)                   return { ok: false, reason: "POSITION_NOT_FOUND" };
    if (pos.side === undefined)  return { ok: false, reason: "INVALID_POSITION" };

    // Verify ownership against account id stored in position
    const account = this.getClientAccounts().find((a) => a.userId === userId);
    if (!account)               return { ok: false, reason: "UNAUTHORIZED" };

    const quote     = this.getQuote(pos.symbol);
    const exitPrice = quote ? (pos.side === "BUY" ? quote.bid : quote.ask) : pos.entryPrice;
    const direction = pos.side === "BUY" ? 1 : -1;
    const rawPnl    = (exitPrice - pos.entryPrice) * pos.quantity * direction;
    const pnl       = Math.max(rawPnl, -pos.marginUsed); // NBP

    // Remove from in-memory positions
    this.positions.delete(positionId);

    // Recalculate account capital
    const clientAcc = this.clientAccounts.get(userId);
    if (clientAcc) {
      const updated = this.recalculateClientAccount(clientAcc);
      this.clientAccounts.set(userId, updated);
    }

    this.recordAudit(userId, "trading.position_manual_close", "position", {
      positionId, pnl, exitPrice,
    });

    return { ok: true, positionId, symbol: pos.symbol, pnl, exitPrice, side: pos.side as "BUY" | "SELL", quantity: pos.quantity, entryPrice: pos.entryPrice };
  }

  /** Modify SL/TP on an in-memory open position (sandbox mode). */
  modifyPositionSlTp(
    positionId:  string,
    userId:      string,
    stopLoss?:   number,
    takeProfit?: number,
  ): { ok: true; positionId: string } | { ok: false; reason: string } {
    const pos = this.positions.get(positionId);
    if (!pos) return { ok: false, reason: "POSITION_NOT_FOUND" };

    const entry = pos.entryPrice;
    if (stopLoss !== undefined) {
      if (pos.side === "BUY"  && stopLoss >= entry) return { ok: false, reason: "SL_MUST_BE_BELOW_ENTRY_FOR_BUY" };
      if (pos.side === "SELL" && stopLoss <= entry) return { ok: false, reason: "SL_MUST_BE_ABOVE_ENTRY_FOR_SELL" };
    }
    if (takeProfit !== undefined) {
      if (pos.side === "BUY"  && takeProfit <= entry) return { ok: false, reason: "TP_MUST_BE_ABOVE_ENTRY_FOR_BUY" };
      if (pos.side === "SELL" && takeProfit >= entry) return { ok: false, reason: "TP_MUST_BE_BELOW_ENTRY_FOR_SELL" };
    }

    const updated = { ...pos };
    if (stopLoss  !== undefined) (updated as any).stopLoss   = stopLoss;
    if (takeProfit !== undefined) (updated as any).takeProfit = takeProfit;
    this.positions.set(positionId, updated);

    this.recordAudit(userId, "trading.order_modify", "position", { positionId, stopLoss, takeProfit });
    return { ok: true, positionId };
  }

  getPositions(): Position[] {
    return [...this.positions.values()].map((position) => {
      const quote = this.getQuote(position.symbol);
      const markPrice = quote?.mid ?? position.entryPrice;
      const direction = position.side === "BUY" ? 1 : -1;
      const pnl = (markPrice - position.entryPrice) * position.quantity * direction;
      return { ...position, markPrice, pnl };
    });
  }

  getWallet(userId = "usr_trader_demo"): WalletBalance {
    const account = this.ensureClientAccount(userId);
    const marginUsed = this.getPositions().reduce((sum, position) => sum + position.marginUsed, 0);
    const unrealizedPnl = this.getPositions().reduce((sum, position) => sum + position.pnl, 0);
    const equity = account.capital.allocated + unrealizedPnl;
    return {
      currency: "EUR",
      available: account.capital.allocated,
      equity,
      marginUsed,
      freeMargin: Math.max(0, equity - marginUsed),
      unrealizedPnl,
    };
  }

  getRisk(userId = "usr_trader_demo"): RiskSnapshot {
    const wallet = this.getWallet(userId);
    const exposure = this.getPositions().reduce((sum, position) => {
      const mark = this.getQuote(position.symbol)?.mid ?? position.entryPrice;
      return sum + mark * position.quantity;
    }, 0);
    const marginLevelPct = wallet.marginUsed > 0 ? (wallet.equity / wallet.marginUsed) * 100 : 999;
    const alerts = [
      "ESMA retail leverage controls active",
      this.riskPolicy.negativeBalanceProtection ? "Negative balance protection active" : "Negative balance protection disabled by admin policy",
      "Live trading disabled until licensing/provider checks pass",
    ];
    if (this.riskPolicy.killSwitchEnabled) alerts.unshift(`Trading kill switch active: ${this.riskPolicy.killSwitchReason ?? "admin policy"}`);
    if (this.riskPolicy.eventRiskMode !== "normal") alerts.unshift(`Event risk mode: ${this.riskPolicy.eventRiskMode}`);
    if (marginLevelPct < 120) alerts.unshift("Margin level approaching stop-out");

    return {
      riskScore: Math.min(100, Math.round(exposure / 2500 + (marginLevelPct < 150 ? 25 : 5))),
      marginLevelPct,
      exposure,
      drawdownPct: Math.max(0, -wallet.unrealizedPnl / wallet.available) * 100,
      negativeBalanceProtection: this.riskPolicy.negativeBalanceProtection,
      stopOutLevelPct: this.riskPolicy.stopOutLevelPct,
      leveragePolicy: this.riskPolicy.leveragePolicy,
      alerts,
    };
  }

  getAiSignals(): AiSignal[] {
    return this.getQuotes().slice(0, 5).map((quote, index) => ({
      id: `sig_${quote.symbol}_${this.tick}_${index}`,
      symbol: quote.symbol,
      direction: this.olosGovernance.modelStatus === "offline" ? "NEUTRAL" : quote.changePct > 0.08 ? "BUY" : quote.changePct < -0.08 ? "SELL" : "NEUTRAL",
      confidence: Math.min(0.96, Math.max(this.olosGovernance.minConfidence - 0.08, 0.62 + Math.abs(quote.changePct) / 2)),
      horizon: index % 2 === 0 ? "INTRADAY" : "SWING",
      regime: Math.abs(quote.changePct) > 0.2 ? "Volatility expansion" : "Balanced liquidity",
      rationale:
        `OLOS combina spread, momentum, indicatori server, calendario macro e risk policy (${this.riskPolicy.eventRiskMode}) prima di suggerire azione.`,
      generatedAt: nowIso(),
    }));
  }

  getAdminOverview() {
    const accounts = this.getClientAccounts();
    return {
      tenants: 1,
      users: this.users.size,
      openPositions: this.positions.size,
      ordersToday: this.orders.size,
      revenueToday: this.getOrders().filter((order) => order.status === "FILLED").length * 4.5,
      aum: accounts.reduce((sum, account) => sum + account.capital.allocated, 0),
      systemRisk: this.getRisk().riskScore,
      complianceQueue: accounts.reduce((sum, account) => sum + account.documents.filter((document) => document.status === "PENDING_REVIEW").length, 0),
    };
  }

  /** Real dependency probes (DB query, Redis PING, live feed staleness) — no fabricated latency/status. */
  async getServiceHealth() {
    const { services } = await getSystemHealth({
      killSwitchEnabled: this.riskPolicy.killSwitchEnabled,
      eventRiskMode:     this.riskPolicy.eventRiskMode,
      olosModelStatus:   this.olosGovernance.modelStatus,
    });
    return services;
  }

  getAudit() {
    return this.audit.slice(-100).reverse();
  }

  private makeQuote(symbol: string, tick: number): Quote {
    const instrument = instrumentsSeed.find((item) => item.symbol === symbol);
    const precision = instrument?.precision ?? 2;
    // Prefer the live price from the liquidity core (via quoteCache) over the
    // hardcoded base price so the REST API reflects real market levels.
    const liveQuote = quoteCache.get(symbol);
    if (liveQuote) return { ...liveQuote, ts: new Date().toISOString() };
    const base = basePrices[symbol] ?? 100;
    const wave = Math.sin((tick + symbol.length * 7) / 12) * 0.0015;
    const jitter = Math.cos((tick + symbol.charCodeAt(0)) / 8) * 0.0008;
    const mid = base * (1 + wave + jitter);
    const spreadFactor =
      instrument?.assetClass === "CRYPTO"
        ? 0.0008
        : instrument?.assetClass === "FX_MAJOR"
          ? 0.00008
          : instrument?.assetClass === "FX_MINOR"
            ? 0.00012
            : instrument?.assetClass === "EQUITY"
              ? 0.00035
              : 0.00025;
    const control = this.liquidityControls.get(symbol);
    const markup = 1 + ((control?.spreadMarkupBps ?? 0) / 10_000);
    const modeFactor = control?.mode === "reduced_only" ? 1.8 : control?.mode === "halted" ? 4 : 1;
    const spread = mid * spreadFactor * markup * modeFactor;
    return {
      symbol,
      bid: Number((mid - spread / 2).toFixed(precision)),
      ask: Number((mid + spread / 2).toFixed(precision)),
      mid: Number(mid.toFixed(precision)),
      spread: Number(spread.toFixed(precision)),
      changePct: Number(((wave + jitter) * 100).toFixed(3)),
      ts: nowIso(),
    };
  }

  private reject(order: NewOrderRequest, rejectionReason: string, actor: string): OrderAck {
    const ack: OrderAck = {
      id: randomUUID(),
      clientOrderId: order.clientOrderId,
      symbol: order.symbol.toUpperCase(),
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      requestedPrice: order.price,
      status: "REJECTED",
      rejectionReason,
      marginRequired: 0,
      notional: 0,
      createdAt: nowIso(),
    };
    this.orders.set(ack.id, ack);
    void this.persistRejectedOrder(ack, actor);
    this.recordAudit(actor, "trading.order_rejected", "order", ack);

    eventBus.emit("order.rejected", {
      orderId: ack.id,
      userId: actor,
      symbol: ack.symbol,
      reason: rejectionReason,
      timestamp: ack.createdAt,
    });

    return ack;
  }

  private async persistUser(user: UserRecord): Promise<void> {
    if (!this.prisma) return;
    try {
      const dbPassword = user._passwordPlain
        ? await argon2Hash(user._passwordPlain)
        : user.password;
      // Clear plain text immediately after use — don't leave it in memory.
      user._passwordPlain = undefined;

      await this.prisma.user.upsert({
        where: { email: user.email },
        update: {
          // password intentionally excluded — never overwrite an existing hash in the DB
          fullName: user.fullName,
          role: user.roles[0] ?? "trader",
          roles: user.roles,
          permissions: user.permissions,
          tier: user.tier,
          kycStatus: user.kycStatus,
          tenantId: user.tenantId,
        },
        create: {
          id: user.id,
          email: user.email,
          password: dbPassword,
          fullName: user.fullName,
          role: user.roles[0] ?? "trader",
          roles: user.roles,
          permissions: user.permissions,
          tier: user.tier,
          kycStatus: user.kycStatus,
          tenantId: user.tenantId,
        },
      });
    } catch (error) {
      console.error("[broker-state] persist user failed", error);
    }
  }

  private async persistSession(refreshToken: string, userId: string): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.session.upsert({
        where: { refreshToken },
        update: { userId },
        create: { refreshToken, userId },
      });
    } catch (error) {
      console.error("[broker-state] persist session failed", error);
    }
  }

  private async persistFilledOrder(order: OrderAck, position: Position, userId: string): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.$transaction([
        this.prisma.order.upsert({
          where: { id: order.id },
          update: {
            status: order.status,
            averageFillPrice: order.averageFillPrice,
            marginRequired: order.marginRequired,
            notional: order.notional,
          },
          create: {
            id: order.id,
            clientOrderId: order.clientOrderId,
            userId,
            symbol: order.symbol,
            side: order.side,
            type: order.type,
            status: order.status,
            quantity: order.quantity,
            requestedPrice: order.requestedPrice,
            averageFillPrice: order.averageFillPrice,
            notional: order.notional,
            marginRequired: order.marginRequired,
            leverage: position.leverage,
          },
        }),
        this.prisma.position.upsert({
          where: { id: position.id },
          update: {
            quantity: position.quantity,
            entryPrice: position.entryPrice,
            marginUsed: position.marginUsed,
            leverage: position.leverage,
          },
          create: {
            id: position.id,
            userId,
            orderId: order.id,
            symbol: position.symbol,
            side: position.side,
            quantity: position.quantity,
            entryPrice: position.entryPrice,
            marginUsed: position.marginUsed,
            leverage: position.leverage,
          },
        }),
        this.prisma.ledgerEntry.create({
          data: {
            id: randomUUID(),
            userId,
            currency: "EUR",
            amount: -order.marginRequired,
            type: "MARGIN_RESERVED",
            reference: order.id,
            status: "COMPLETED",
            note: "Margine riservato per ordine eseguito.",
          },
        }),
      ]);
    } catch (error) {
      console.error("[broker-state] persist filled order failed", error);
    }
  }

  private async persistRejectedOrder(order: OrderAck, userId: string): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.order.upsert({
        where: { id: order.id },
        update: {
          status: order.status,
          rejectionReason: order.rejectionReason,
        },
        create: {
          id: order.id,
          clientOrderId: order.clientOrderId,
          userId,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          status: order.status,
          quantity: order.quantity,
          requestedPrice: order.requestedPrice,
          averageFillPrice: order.averageFillPrice,
          notional: order.notional,
          marginRequired: order.marginRequired,
          leverage: 1,
          rejectionReason: order.rejectionReason,
        },
      });
    } catch (error) {
      console.error("[broker-state] persist rejected order failed", error);
    }
  }

  private async persistLedgerEntry(userId: string, entry: LedgerEntryRecord): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.ledgerEntry.upsert({
        where: { id: entry.id },
        update: {
          amount: entry.amount,
          type: entry.type,
          reference: entry.reference,
          status: entry.status,
          note: entry.note,
        },
        create: {
          id: entry.id,
          userId,
          currency: "USD",
          amount: entry.amount,
          type: entry.type,
          reference: entry.reference,
          status: entry.status,
          note: entry.note,
          createdAt: new Date(entry.createdAt),
        },
      });
    } catch (error) {
      console.error("[broker-state] persist ledger failed", error);
    }
  }

  private async persistWalletBalance(userId: string, balance: number): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.walletAccount.upsert({
        where:  { userId },
        update: { balance },
        create: { userId, balance, currency: "USD" },
      });
    } catch (error) {
      console.error("[broker-state] persist wallet balance failed", error);
    }
  }

  private async persistClientDocument(userId: string, document: BrokerClientAccount["documents"][number]): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.clientDocument.upsert({
        where: { userId_documentKey: { userId, documentKey: document.id } },
        update: {
          label: document.label,
          status: document.status,
          fileName: document.fileName,
          rejectionReason: document.rejectionReason,
        },
        create: {
          id: randomUUID(),
          userId,
          documentKey: document.id,
          label: document.label,
          status: document.status,
          fileName: document.fileName,
          rejectionReason: document.rejectionReason,
        },
      });
    } catch (error) {
      console.error("[broker-state] persist client document failed", error);
    }
  }

  private async persistClientAccount(account: BrokerClientAccount): Promise<void> {
    if (!this.prisma) return;
    try {
      await Promise.all([
        ...account.documents.map((document) => this.persistClientDocument(account.userId, document)),
        ...account.ledger.map((entry) => this.persistLedgerEntry(account.userId, entry)),
      ]);
    } catch (error) {
      console.error("[broker-state] persist client account failed", error);
    }
  }

  private async persistBrokerSetting(key: string, value: unknown): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.brokerSetting.upsert({
        where: { key },
        update: { value: value as Prisma.InputJsonValue },
        create: { key, value: value as Prisma.InputJsonValue },
      });
    } catch (error) {
      console.error("[broker-state] persist broker setting failed", error);
    }
  }

  private recordAudit(
    actor: string,
    action: string,
    entity: string,
    payload: Record<string, unknown>
  ): void {
    const entry = {
      id: randomUUID(),
      actor,
      action,
      entity,
      payload,
      createdAt: nowIso(),
    };
    this.audit.push(entry);
    if (this.prisma) {
      void this.prisma.auditLog.create({
        data: {
          id: entry.id,
          actor: entry.actor,
          action: entry.action,
          entity: entry.entity,
          payload: entry.payload as Prisma.InputJsonValue,
          createdAt: new Date(entry.createdAt),
        },
      }).catch((error) => console.error("[broker-state] persist audit failed", error));
    }
  }

  // ===== TRADE AUDIT METHODS =====
  // Not implemented: detailed per-trade audit history is not backed by a live
  // service. Real position/order data is available via getPositions()/getOrders();
  // this endpoint intentionally returns an honest empty result rather than
  // partial/fake data.
  getTradeHistory(_userId: string, filters?: any) {
    return {
      trades: [],
      total: 0,
      limit: filters?.limit || 50,
      offset: filters?.offset || 0,
    };
  }

  getUserTradeStats(_userId: string) {
    return {
      totalTrades: 0,
      openTrades: 0,
      closedTrades: 0,
      totalPnL: 0,
      totalFees: 0,
      netPnL: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      avgDuration: 0,
    };
  }

  // ===== OLOS SIGNAL METHODS =====
  // Signals are generated platform-wide by the OLOS engine (signal.generator.ts)
  // and persisted under PLATFORM_SIGNAL_USER_ID — they are not per-user records,
  // so every client reads the same real, live signal set.
  async getActiveSignals(_userId: string, filters?: { symbol?: string }) {
    if (!IS_PERSISTENT) return [];
    try {
      return await olosSignalService.getActiveSignals(PLATFORM_SIGNAL_USER_ID, filters);
    } catch {
      return [];
    }
  }

  async getSignalHistory(_userId: string, filters?: { symbol?: string; status?: string; limit?: number; offset?: number }) {
    const empty = { signals: [], total: 0, limit: filters?.limit ?? 50, offset: filters?.offset ?? 0 };
    if (!IS_PERSISTENT) return empty;
    try {
      return await olosSignalService.getSignalHistory(PLATFORM_SIGNAL_USER_ID, filters);
    } catch {
      return empty;
    }
  }

  async getSignalStatistics(_userId: string) {
    const empty = {
      totalSignals: 0,
      activeSignals: 0,
      triggeredSignals: 0,
      closedSignals: 0,
      avgConfidence: 0,
      byTimeframe: {},
      byType: {},
    };
    if (!IS_PERSISTENT) return empty;
    try {
      return await olosSignalService.getSignalStatistics(PLATFORM_SIGNAL_USER_ID);
    } catch {
      return empty;
    }
  }

  // ===== RISK WARNING METHODS =====
  getCurrentWarning(_userId: string) {
    // Stub: In production, integrate with riskWarningService
    return null;
  }

  getRiskDashboard(_userId: string) {
    // Stub: In production, integrate with riskWarningService
    return {
      current: null,
      analysis: {},
      trend: "STABLE",
      heatmap: {},
      upcomingEvents: [],
      killSwitchStatus: "IDLE",
    };
  }

  analyzeScenarios(_userId: string) {
    // Stub: In production, integrate with riskWarningService
    return {
      worstCaseScenario: 0,
      marginCallProbability: 0,
      recommendedAction: "Monitor closely",
      urgency: "NORMAL",
    };
  }

  acknowledgeWarning(_warningId: string) {
    // Stub: In production, integrate with riskWarningService
    return { acknowledged: true };
  }

}
