// Load .env before anything else (no-op in Docker / prod where vars are injected)
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: new URL("../.env", import.meta.url).pathname });

// ─── Required-secret validation ───────────────────────────────────────────────
// Runs before any service is initialised. Missing required secrets = hard exit.
(function validateRequiredSecrets() {
  const isProduction = process.env.NODE_ENV === "production";
  const required: Array<{ key: string; present: boolean; hint?: string }> = [];

  const hasRSA =
    Boolean(process.env.JWT_PRIVATE_KEY?.includes("BEGIN")) &&
    Boolean(process.env.JWT_PUBLIC_KEY?.includes("BEGIN"));
  const hasSymmetric = (process.env.JWT_SECRET?.length ?? 0) >= 32;
  required.push({
    key: "JWT_SECRET (≥32 chars) or JWT_PRIVATE_KEY + JWT_PUBLIC_KEY",
    present: hasRSA || hasSymmetric,
    hint: "openssl rand -hex 64",
  });

  required.push({
    key: "ANTHROPIC_API_KEY",
    present: Boolean(process.env.ANTHROPIC_API_KEY),
    hint: "console.anthropic.com/settings/keys",
  });

  if (isProduction) {
    required.push({
      key: "DATABASE_URL",
      present: Boolean(process.env.DATABASE_URL),
      hint: "postgresql://user:password@host:5432/dbname",
    });
    required.push({
      key: "TWELVEDATA_API_KEY",
      present: Boolean(process.env.TWELVEDATA_API_KEY),
      hint: "twelvedata.com/account/api-keys",
    });
    required.push({
      key: "CORS_ORIGIN",
      present: Boolean(process.env.CORS_ORIGIN),
      hint: "https://www.igfxpro.com — must not default to a localhost dev URL in production",
    });
  }

  const missing = required.filter((r) => !r.present);
  if (missing.length === 0) return;

  console.error("[igfxpro-apiv2] STARTUP FAILED — missing required environment variables:");
  for (const { key, hint } of missing) {
    console.error(`  • ${key}${hint ? `  (${hint})` : ""}`);
  }
  console.error("[igfxpro-apiv2] Copy .env.example → .env and fill in all required values.");
  process.exit(1);
})();

import { IncomingMessage } from "node:http";
import { PrismaClient }   from "@prisma/client";
import { WebSocketServer, type WebSocket } from "ws";
import { initRedis }      from "./shared/redis.js";

import { routes }               from "./gateway/routes.js";
import { createApiServer }      from "./shared/http.js";
import { BrokerState }          from "./shared/state.js";
import { assertValidSecret, verifyToken } from "./shared/security.js";
import { jwtKeyManager }        from "./security/jwt-key-manager.js";
import { markDbUnavailable }    from "./shared/db.js";
import { eventBus }             from "./events-bus/event.bus.js";
import { RateLimiter }          from "./gateway/rate-limiter.js";

// ─── Market-data ─────────────────────────────────────────────────────────────
import { quoteCache }               from "./market-data/quote.cache.js";
import { fetchLiveQuotes }          from "./market-data/feeds/twelvedata.rest.js";
import { FeedManager }              from "./market-data/feed.manager.js";
import { virtualOrderbook }         from "./liquidity-engine/virtual.orderbook.js";
import { assetClassOf }             from "./liquidity-engine/liquidity.provider.js";

// ─── P5 / Internal Liquidity Core ────────────────────────────────────────────
// InternalLiquidityCore is the SINGLE canonical price source.
// All consumers (execution, risk, OLOS, WebSocket, MT5) read from quoteCache,
// which is written exclusively by the core on every tick.
import {
  InternalLiquidityCore,
  normaliseSymbol,
} from "./liquidity-engine/internal.liquidity.core.js";
import { brokerSpreadConfig } from "./liquidity-engine/broker.spread.config.js";
import { exposureRegistry }   from "./risk-service/exposure.limits.js";
import { logger }             from "./shared/logger.js";

// ─── Signal generation ───────────────────────────────────────────────────────
import { SignalGenerator }      from "./signals-engine/signal.generator.js";
import { configureScanSchedule, recordScan } from "./signals-engine/signal.scan-tracker.js";
import { economicEventService } from "./economic-calendar/economic.event.service.js";
import { selfOptimizer }        from "./signals-engine/self.optimizer.js";
import { signalTelemetry }      from "./signals-engine/signal.telemetry.js";
import { olosSignalService }    from "./signals-engine/olos.signal.service.js";

// ─── P6: WebSocket outbox (event persistence + recovery) ─────────────────────
import { outboxService }        from "./realtime-infra/outbox.service.js";

// ─── Startup services ─────────────────────────────────────────────────────────
import { killSwitch }           from "./risk-service/kill.switch.js";
import { recoveryService }      from "./settlement/recovery.service.js";
import { startCandleAggregator, getCandles } from "./market-data/candle.aggregator.js";
import { seedSyntheticCandles }  from "./market-data/synthetic.seeder.js";
import { randomUUID }           from "node:crypto";
import { hashPassword }         from "./auth-service/password.hasher.js";
import { autopilotPipeline }    from "./autopilot-service/autopilot.pipeline.js";
import { autopilotService }     from "./autopilot-service/autopilot.service.js";
import { autopilotPositionManager } from "./autopilot-service/autopilot.position.manager.js";
import { globalRiskSupervisor }  from "./risk-service/global.risk.supervisor.js";
import { secretRotation }        from "./security/secret.rotation.js";
import { notificationRouter }   from "./notification-service/notification.router.js";
import { dailySnapshotService }  from "./settlement/daily.snapshot.service.js";
import { reconciliationEngine }  from "./settlement/reconciliation.engine.js";
import { auditOutboxConsumer }   from "./compliance/audit.outbox.consumer.js";
import { notificationOutboxConsumer } from "./notification-service/notification.outbox.consumer.js";
import { pendingOrderBook }         from "./trading-service/pending.order.book.js";
import { orderTriggerWatcher }      from "./trading-service/order.trigger.watcher.js";
import { pendingOrderExpiryService } from "./trading-service/pending.order.expiry.js";
import { stopOutEngine }         from "./trading-service/stopout.engine.js";
import { riskWarningGenerator }  from "./risk-service/risk.warning.generator.js";
import { liquidationEngine }     from "./risk-service/liquidation.engine.js";
import { symbolCircuitBreaker }  from "./risk-service/symbol.circuit.breaker.js";
import { hedgeQueue }            from "./hedge-service/hedge.queue.js";
import { swapAccrualService }    from "./settlement/swap.accrual.service.js";
import { positionPriceMonitor }  from "./trading-service/position.price.monitor.js";
import { redisPubSub }           from "./realtime-infra/redis.pubsub.js";
import { jobCoordinator }        from "./realtime-infra/job.coordinator.js";
import { feedHealthMonitor }     from "./market-data/feed.health.monitor.js";
// ── Task 13: Horizontal Scaling ───────────────────────────────────────────────
import { wsCluster }             from "./realtime-infra/websocket.cluster.js";
import { distributedCache }      from "./realtime-infra/cache.layer.js";
import { eventArchive }          from "./realtime-infra/event.archive.js";
import { initReadReplica, disconnectReadReplica } from "./shared/read-replica.js";
// ── Task 14: DB Institutional Hardening ───────────────────────────────────────
import { dataRetentionService }          from "./settlement/data.retention.service.js";
import { enhancedReconciliationService } from "./settlement/enhanced.reconciliation.service.js";
// ── FIX 4.4 Gateway ───────────────────────────────────────────────────────────
import { initFixAcceptor }               from "./fix-gateway/fix.acceptor.js";
// ── Bloomberg-grade Observability ────────────────────────────────────────────
import { initAllMetrics }                from "./observability/index.js";
import { shutdownTelemetry }             from "./shared/telemetry.js";

// ─── Config ──────────────────────────────────────────────────────────────────
const port               = Number(process.env.PORT ?? 3000);
const corsOrigin         = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const liveTradingEnabled = process.env.LIVE_TRADING_ENABLED === "true";
const twelvedataKey      = process.env.TWELVEDATA_API_KEY ?? "";
const quoteIntervalMs    = Number(process.env.QUOTE_INTERVAL_MS ?? 1000);
const signalIntervalMs   = Number(process.env.SIGNAL_INTERVAL_MS ?? 60_000);

const jwtPrivateKey = process.env.JWT_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
const jwtPublicKey  = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, "\n") ?? "";
const jwtSecret     = process.env.JWT_SECRET ?? "";

const useRSA     = jwtPrivateKey.includes("BEGIN") && jwtPublicKey.includes("BEGIN");
const signingKey = useRSA ? jwtPrivateKey : jwtSecret;
const verifyKey  = useRSA ? jwtPublicKey  : jwtSecret;

assertValidSecret(signingKey, useRSA ? "JWT_PRIVATE_KEY" : "JWT_SECRET");

// ─── JWT Key Manager — kid-aware rotation ────────────────────────────────────
jwtKeyManager.init();
jwtKeyManager.scheduleAutoRotation();

// ─── Database ────────────────────────────────────────────────────────────────
const prisma = process.env.DATABASE_URL ? new PrismaClient() : undefined;

// ─── Redis + Rate Limiter + Distributed Execution Queue ──────────────────────
const redisUrl      = process.env.REDIS_URL ?? "redis://localhost:6379";
const _isProduction = process.env.NODE_ENV === "production";
let   rateLimiter: RateLimiter | undefined;
try {
  const redis = await initRedis(redisUrl);
  rateLimiter = new RateLimiter(redis);
  console.log("[igfxpro-apiv2] Redis connected — rate limiter + distributed execution queue active");

  // Task 13: Start distributed cache L1/L2 and register this node in the WS cluster
  await distributedCache.start().catch((err) =>
    console.warn("[distributed-cache] start failed (L1 only):", (err as Error).message),
  );
  await wsCluster.register().catch((err) =>
    console.warn("[ws-cluster] register failed (single-node mode):", (err as Error).message),
  );
} catch (redisErr) {
  if (_isProduction) {
    console.error(
      "[igfxpro-apiv2] FATAL: Redis unavailable — cannot start in production without rate limiting:",
      (redisErr as Error).message,
    );
    process.exit(1);
  }
  console.warn("[igfxpro-apiv2] Redis unavailable — rate limiting disabled, execution queue in-memory fallback (non-production only)");
}

// ─── Task 13: Read replica, distributed cache, WS cluster ────────────────────
// initReadReplica() is a no-op when READ_REPLICA_URL is not set.
initReadReplica();

// ─── Distributed job registrations ────────────────────────────────────────────
// Must be done before any interval that calls jobCoordinator.tryLead().
// signalIntervalMs is already defined above; all other intervals are fixed.
jobCoordinator.register({ id: "stop-out-scan",          ttlSeconds: 25,      intervalMs: 30_000,             description: "ESMA margin / stop-out liquidation sweep"              });
jobCoordinator.register({ id: "pending-order-expiry",  ttlSeconds: 25,      intervalMs: 30_000,             description: "Expire GTD/GTC/IOC orders past expiresAt"              });
jobCoordinator.register({ id: "outbox-retry-sweep",    ttlSeconds: 25,      intervalMs: 30_000,             description: "Replay undelivered WebSocket outbox events"            });
jobCoordinator.register({ id: "outbox-cleanup",        ttlSeconds: 780,     intervalMs: 15 * 60_000,        description: "Prune published OutboxEvent rows older than 2h"        });
jobCoordinator.register({ id: "audit-outbox-consumer", ttlSeconds: 8,       intervalMs: 10_000,             description: "FASE 2.4: turn order.filled/partial_filled/position.closed outbox rows into TradeAudit/AuditLog" });
jobCoordinator.register({ id: "liquidation-watchdog", ttlSeconds: 25,       intervalMs: 30_000,             description: "FASE 2.5: periodic SL/TP recovery sweep — catches positions missed by the tick-level monitor" });
jobCoordinator.register({ id: "position-monitor-reconciliation", ttlSeconds: 25, intervalMs: 30_000,         description: "MARKET_DATA_FREEZE.md §0.3: re-adds any OPEN position missing from PositionPriceMonitor's cache, bounding markPrice/pnl staleness to one sweep instead of forever" });
jobCoordinator.register({ id: "notification-outbox-consumer", ttlSeconds: 12, intervalMs: 15_000,           description: "FASE 2.6: turn order.filled/position.closed outbox rows into reliable Notification rows + email" });
jobCoordinator.register({ id: "symbol-circuit-breaker-recovery", ttlSeconds: 25, intervalMs: 30_000,         description: "FASE 3.2: auto re-enable symbols the circuit breaker halted, once their cooldown elapses" });
jobCoordinator.register({ id: "hedge-queue-sweep",     ttlSeconds: 45,      intervalMs: 60_000,             description: "FASE 3.8: evaluate house exposure and record hedge-order scaffold rows (no live provider — REJECTED by design)" });
jobCoordinator.register({ id: "signal-generator",      ttlSeconds: 50,      intervalMs: signalIntervalMs,   description: "OLOS technical signal evaluation"                      });
jobCoordinator.register({ id: "economic-calendar",     ttlSeconds: 20_000,  intervalMs: 6 * 60 * 60_000,   description: "Refresh economic calendar from Finnhub (every 6h)"     });
jobCoordinator.register({ id: "signal-expire",         ttlSeconds: 3_500,   intervalMs: 60 * 60_000,        description: "Expire unexecuted OLOS signals past 24h TTL"           });
jobCoordinator.register({ id: "olos-self-optimizer",   ttlSeconds: 86_000,  intervalMs: 7 * 24 * 60 * 60_000, description: "Weekly OLOS confidence weight recalibration"         });
jobCoordinator.register({ id: "autopilot-position-manager", ttlSeconds: 25, intervalMs: 30_000,             description: "Break-even/trailing/regime-exit/time-stop for autopilot positions" });
jobCoordinator.register({ id: "global-risk-supervisor",     ttlSeconds: 25, intervalMs: 30_000,             description: "Platform-wide autopilot safety evaluation (SAFE/EMERGENCY/STOP modes)" });
jobCoordinator.register({ id: "risk-warning-generator",      ttlSeconds: 25, intervalMs: 30_000,             description: "Fix #9: persists each active user's real risk-warning/dashboard state" });
// Task 14: DB hardening jobs
jobCoordinator.register({ id: "data-retention",           ttlSeconds: 3_500,   intervalMs: 24 * 60 * 60_000,     description: "Daily data retention sweep + partition auto-create"  });
jobCoordinator.register({ id: "enhanced-recon-daily",     ttlSeconds: 23 * 60 * 60, intervalMs: 24 * 60 * 60_000, description: "Daily enhanced reconciliation (swap/deposit/PnL audit)" });
jobCoordinator.register({ id: "ledger-partition-maintenance", ttlSeconds: 1_700, intervalMs: 30 * 24 * 60 * 60_000, description: "Monthly: create next 3 archive partitions"       });

// ─── Core broker state ───────────────────────────────────────────────────────
const state = new BrokerState({
  signingKey,
  verifyKey,
  tokenVerifier: (token) => jwtKeyManager.verifyToken(token),
  liveTradingEnabled,
  prisma,
});

try {
  await state.initializePersistence();
  console.log("[igfxpro-apiv2] database persistence initialised");
} catch (error) {
  console.warn("[igfxpro-apiv2] database unavailable — in-memory sandbox", error);
  // Reset IS_PERSISTENT and DATABASE_URL so every route uses in-memory
  // paths consistently — prevents split-brain between order execution
  // (DB path) and position/wallet reads (in-memory path).
  markDbUnavailable();
}

// ─── Startup services (run before accepting connections) ─────────────────────
await Promise.all([
  killSwitch.load().catch((err) =>
    console.error("[kill-switch] failed to load from DB:", (err as Error).message),
  ),
  globalRiskSupervisor.load().catch((err) =>
    console.error("[risk-supervisor] failed to load from DB:", (err as Error).message),
  ),
  secretRotation.loadAll().catch((err) =>
    console.error("[secret-rotation] failed to load secrets:", (err as Error).message),
  ),
  quoteCache.warmUp().catch((err) =>
    console.error("[quote-cache] warm-up failed:", (err as Error).message),
  ),
  brokerSpreadConfig.load().catch((err) =>
    console.error("[broker-spread] config load failed:", (err as Error).message),
  ),
  exposureRegistry.load().catch((err) =>
    console.error("[exposure-registry] load failed:", (err as Error).message),
  ),
]);

// Fix #6: cluster-wide kill-switch / risk-supervisor sync — must start after
// load() (above) so this worker doesn't briefly overwrite its own freshly-
// loaded state with an empty subscribe-time race, and after Redis is
// connected (initRedis(), earlier in this file). No-op without Redis.
await Promise.all([
  killSwitch.startSync().catch((err) =>
    console.error("[kill-switch] cross-worker sync failed to start:", (err as Error).message),
  ),
  globalRiskSupervisor.startSync().catch((err) =>
    console.error("[risk-supervisor] cross-worker sync failed to start:", (err as Error).message),
  ),
  brokerSpreadConfig.startSync().catch((err) =>
    console.error("[broker-spread] cross-worker sync failed to start:", (err as Error).message),
  ),
]);

// Seed synthetic placeholder candles synchronously so charts have data immediately.
// TwelveData historical seeder will overwrite these with real OHLCV when ENABLE_HISTORICAL_SEED=true.
seedSyntheticCandles();

// Start candle aggregator (subscribes to market.quote events from quoteCache)
startCandleAggregator();

// Wire notification router — subscribes to all domain events for user notifications
notificationRouter.subscribe();

// Task 13: Start event sourcing archive — captures all domain events to partitioned DB table
eventArchive.start();

// Unified autopilot: the public "flagship" demo bot (sys_olos_autopilot) is no
// longer a separate hardcoded engine (the old signal.autopilot.ts) — it's now
// a normal AutopilotConfig row running through the exact same per-user
// pipeline real customers use, including the safety gates the old bot-only
// engine had (event-lock, kill-switch, daily cap) and trade management.
// Idempotent: safe to run on every boot.
if (prisma) {
  try {
    const SYS_BOT_ID = "sys_olos_autopilot";
    const existing = await prisma.user.findUnique({ where: { id: SYS_BOT_ID } });
    if (!existing) {
      const hashed = await hashPassword(randomUUID());
      await prisma.user.create({
        data: {
          id: SYS_BOT_ID,
          email:    "olos-autopilot@igfxpro.internal",
          password: hashed,
          fullName: "OLOS Autopilot (Platform)",
          role:     "trader",
          roles:    ["trader"],
          permissions: [],
          tier:     "ENTERPRISE",
          kycStatus: "approved",
          tenantId: "tenant_igfxpro",
        },
      });
      await prisma.walletAccount.create({
        data: { userId: SYS_BOT_ID, currency: "USD", balance: 50_000, equity: 50_000, locked: 0 },
      });
      // Wallet balance must always be backed by a real ledger entry — a wallet
      // with no matching LedgerEntry is exactly the reconciliation mismatch
      // pattern fixed earlier for loadtest accounts. Never repeat it here.
      await prisma.ledgerEntry.create({
        data: {
          id: randomUUID(),
          userId: SYS_BOT_ID,
          currency: "USD",
          amount: 50_000,
          type: "ADMIN_CAPITAL_ALLOCATION",
          reference: `BOOTSTRAP:${SYS_BOT_ID}`,
          status: "COMPLETED",
          note: "Initial platform capital allocation for the unified OLOS autopilot demo account",
          debitAccount: "PLATFORM_CAPITAL",
          creditAccount: `CLIENT_FREE:${SYS_BOT_ID}`,
        },
      });
      console.log("[autopilot] created sys_olos_autopilot account + wallet + ledger entry");
    }
    await autopilotService.saveConfig(SYS_BOT_ID, {
      enabled: true,
      mode: "BALANCED",
      minConfidence: state.getOlosGovernance().minConfidence,
      allowedSymbols: [],
      eventLockMinutes: state.getOlosGovernance().eventLockMinutes,
    }, SYS_BOT_ID);
  } catch (err) {
    console.error("[autopilot] sys_olos_autopilot bootstrap failed:", (err as Error).message);
  }
}

// Pending order book — load resting orders from DB + start trigger watcher
await pendingOrderBook.initialize().catch((err) =>
  console.error("[pending-order-book] init failed:", (err as Error).message),
);
orderTriggerWatcher.start();
// Scan for expired pending orders every 30s; also runs startup catch-up scan
pendingOrderExpiryService.start(30_000);
void pendingOrderExpiryService.scanNow();

// Recovery runs after quoteCache is warm so P&L recomputation has prices
try {
  const report = await recoveryService.run();
  if (report) {
    console.log(
      `[recovery] positions=${report.positionsRecomputed} stuckOrders=${report.stuckOrdersRejected} marginWarnings=${report.marginWarnings.length}`,
    );
  }
} catch (err) {
  console.error("[recovery] startup recovery failed:", (err as Error).message);
}

// Position Price Monitor — starts after recovery so all positions are loaded clean
// This is the SL/TP enforcement engine and real-time M2M broadcaster.
await positionPriceMonitor.start().catch((err) =>
  console.error("[position-monitor] startup failed:", (err as Error).message),
);
console.log(`[position-monitor] ${positionPriceMonitor.getStats().trackedPositions} positions loaded`);

// ─── Per-socket metadata ──────────────────────────────────────────────────────
interface AuthenticatedSocket extends WebSocket {
  userId?: string;
  tenantId?: string;
  authenticated: boolean;
  isAlive?: boolean;
  // REALTIME_FREEZE.md H.2: role claims from the same JWT already used for
  // userId/tenantId (TokenPayload.roles -- always present on a valid token,
  // see shared/security.ts). Lets pushToStaff() target admin/compliance/risk
  // operators without a second auth round-trip.
  roles?: string[];
  // REALTIME_FREEZE.md H.3: true from connection-open until the outbox
  // replay for this socket finishes. While true, pushToUser() defers
  // instead of sending immediately -- see pushToUser's docstring for why.
  replaying?: boolean;
  // REALTIME_FREEZE.md H.4: consecutive WS_KEEPALIVE_MS ticks (30s each)
  // this socket has been found over WS_BACKPRESSURE_HIGH_WATER_MARK. Reset
  // to 0 the moment it's found under the mark again. See the keepalive
  // interval below for the terminate policy.
  backpressureStrikes?: number;
}

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────
const server = createApiServer({ state, routes, corsOrigin, rateLimiter });

const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient(info: { req: IncomingMessage }, cb: (result: boolean, code?: number, message?: string) => void) {
    const url   = new URL(info.req.url ?? "/ws", "ws://local");
    const token = url.searchParams.get("token");

    // In sandbox mode: always allow the connection — invalid/missing tokens
    // just mean the socket is unauthenticated (no user-specific pushes).
    if (!liveTradingEnabled) {
      if (token) {
        const payload = jwtKeyManager.verifyToken(token) ?? verifyToken(token, verifyKey);
        if (payload) {
          (info.req as IncomingMessage & { _jwtSub?: string; _jwtTenantId?: string; _jwtRoles?: string[] })._jwtSub      = payload.sub;
          (info.req as IncomingMessage & { _jwtSub?: string; _jwtTenantId?: string; _jwtRoles?: string[] })._jwtTenantId = payload.tenantId;
          (info.req as IncomingMessage & { _jwtSub?: string; _jwtTenantId?: string; _jwtRoles?: string[] })._jwtRoles    = payload.roles;
        }
      }
      cb(true);
      return;
    }

    // In live mode: token is mandatory and must be valid.
    if (!token) { cb(false, 4001, "JWT required"); return; }
    const payload = jwtKeyManager.verifyToken(token) ?? verifyToken(token, verifyKey);
    if (!payload) { cb(false, 4001, "Invalid or expired JWT"); return; }

    (info.req as IncomingMessage & { _jwtSub?: string; _jwtTenantId?: string; _jwtRoles?: string[] })._jwtSub      = payload.sub;
    (info.req as IncomingMessage & { _jwtSub?: string; _jwtTenantId?: string; _jwtRoles?: string[] })._jwtTenantId = payload.tenantId;
    (info.req as IncomingMessage & { _jwtSub?: string; _jwtTenantId?: string; _jwtRoles?: string[] })._jwtRoles    = payload.roles;
    cb(true);
  },
});

// Prevent a single socket error from propagating to an uncaught exception and
// crashing the entire server process. The ws library emits "error" on the
// server object for low-level TCP errors when no per-socket handler is set.
wss.on("error", (err) => {
  console.error("[wss] server-level socket error (non-fatal):", err.message);
});

// REALTIME_FREEZE.md H.4: zero backpressure handling existed anywhere --
// `ws` performs no automatic throttling, and a slow/backgrounded client
// (poor network, laptop lid closed) accumulated sends without limit in the
// underlying socket's write buffer as high-frequency events kept arriving
// (market.quotes ~1/s to every client, position.pnl_updated per tick per
// open position), unbounded by anything except the 30s ping/pong keepalive
// -- which only catches a socket that stopped responding, not one that's
// alive but draining slower than data arrives. 1MB is a conservative
// high-water mark: `ws` buffers in Node Buffer chunks in RAM per socket, so
// this bounds worst-case per-connection memory from this cause while being
// far above the size of any single message this app ever sends.
const WS_BACKPRESSURE_HIGH_WATER_MARK = 1_000_000;
// Sockets found over the mark 3 keepalive ticks running (~90s of sustained,
// non-transient backpressure) are terminated -- same recovery path as a
// dead socket: the client's own reconnect logic (api/websocket.ts) takes
// over, and outbox replay (H.3) repopulates anything that was missed.
const WS_BACKPRESSURE_STRIKE_LIMIT = 3;

function isBackpressured(client: AuthenticatedSocket): boolean {
  return client.bufferedAmount > WS_BACKPRESSURE_HIGH_WATER_MARK;
}

// ─── Server-side WS keepalive ─────────────────────────────────────────────────
// Pings every connected client every 30 s. Clients that don't respond within
// one interval are terminated. This prevents Vite-proxy / firewall / NAT
// timeouts from silently killing long-lived WebSocket connections.
const WS_KEEPALIVE_MS = 30_000;
setInterval(() => {
  for (const rawClient of wss.clients) {
    const client = rawClient as AuthenticatedSocket;
    if (client.readyState !== client.OPEN) continue;
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    // REALTIME_FREEZE.md H.4: forced-disconnect policy for a persistently
    // backpressured (alive, but not draining) socket -- see the constants'
    // docstring above.
    if (isBackpressured(client)) {
      client.backpressureStrikes = (client.backpressureStrikes ?? 0) + 1;
      if (client.backpressureStrikes >= WS_BACKPRESSURE_STRIKE_LIMIT) {
        console.warn(`[ws] terminating persistently backpressured socket (userId=${client.userId ?? "anon"}, bufferedAmount=${client.bufferedAmount})`);
        client.terminate();
        continue;
      }
    } else {
      client.backpressureStrikes = 0;
    }
    client.isAlive = false;
    try { client.ping(); } catch { /* ignore stale sockets */ }
  }
}, WS_KEEPALIVE_MS);

wss.on("connection", (rawSocket: WebSocket, req: IncomingMessage) => {
  const socket = rawSocket as AuthenticatedSocket;
  const extReq = req as IncomingMessage & { _jwtSub?: string; _jwtTenantId?: string; _jwtRoles?: string[] };

  socket.isAlive      = true;
  socket.userId       = extReq._jwtSub;
  socket.tenantId     = extReq._jwtTenantId;
  socket.roles        = extReq._jwtRoles;
  socket.authenticated = Boolean(socket.userId);

  socket.on("pong",  () => { socket.isAlive = true; });
  socket.on("error", (err) => {
    console.warn("[ws] per-socket error (non-fatal):", err.message);
    try { socket.terminate(); } catch { /* ignore */ }
  });

  // Task 13: Track connection in WS cluster registry
  if (socket.userId) {
    void wsCluster.onUserConnect(socket.userId);
  } else {
    wsCluster.onAnonConnect();
  }
  socket.on("close", () => {
    if (socket.userId) {
      void wsCluster.onUserDisconnect(socket.userId);
    } else {
      wsCluster.onAnonDisconnect();
    }
  });

  const coreStats = liquidityCore.getStats();

  socket.send(JSON.stringify({
    type: "system.connected",
    payload: {
      service:       "igfxpro-apiv2",
      mode:          liveTradingEnabled ? "live" : "sandbox",
      authenticated: socket.authenticated,
      userId:        socket.userId ?? null,
      auth:          useRSA ? "RS256" : "HS256",
      timestamp:     new Date().toISOString(),
      services: {
        marketData:      coreStats.externalPrices > 0 ? "live" : "awaiting-feed",
        liquidityEngine: "IGFX_INTERNAL",
        signalEngine:    "active",
        riskEngine:      "active",
        executionEngine: "active",
        database:        prisma ? "connected" : "in-memory",
      },
    },
  }));

  // P6 — Replay any undelivered outbox events for this user.
  // REALTIME_FREEZE.md H.3: `replaying` gates pushToUser() for this socket
  // for the whole window below (including the initial DB round-trip) --
  // see pushToUser's docstring. try/finally guarantees it's cleared even if
  // the replay loop breaks early on a send error, so a socket that fails
  // mid-replay doesn't stay permanently un-pushable.
  if (socket.userId) {
    socket.replaying = true;
    void (async () => {
      try {
        const pending = await outboxService.getPendingForUser(socket.userId!);
        for (const evt of pending) {
          if (socket.readyState !== socket.OPEN) break;
          if (!sendToSocket(socket, evt.eventType, evt.payload, { replayed: true })) break;
          // REALTIME_FREEZE.md M.2: awaited (not fire-and-forget) to shrink
          // the window where a concurrent path (retryUnpublished sweep) could
          // see this row as still-pending and redundantly re-deliver it.
          await outboxService.markPublished(evt.id);
        }
        if (pending.length) {
          console.log(`[outbox] replayed ${pending.length} event(s) for user ${socket.userId}`);
        }
      } finally {
        socket.replaying = false;
      }
    })();
  }
});

// ─── Internal Liquidity Core ──────────────────────────────────────────────────
//
// This is the ONLY component allowed to write bid/ask quotes to quoteCache.
// The onBatch callback fires once per tick cycle so the WS broadcast
// is synchronised with price generation (no double-interval jitter).
//
const SYMBOLS = [
  "EURUSD", "GBPUSD", "USDJPY", "EURGBP", "AUDUSD", "USDCHF",
  "XAUUSD", "US500",  "US100",  "DE40",   "UK100",
  "WTI",    "BRENT",  "BTCUSD", "ETHUSD", "SOLUSD", "XAGUSD",
  "AAPL",   "MSFT",   "NVDA",   "TSLA",   "AMZN",
];

// TwelveData symbol format (with slashes) for REST + WebSocket API.
// Not currently used for WS subscription (limited to TWELVEDATA_WS_SYMBOLS).
// Kept for paid-plan upgrade: set TWELVEDATA_WS_SYMBOLS = TWELVEDATA_SYMBOLS.
const _TWELVEDATA_SYMBOLS_ALL = [
  "EUR/USD", "GBP/USD", "USD/JPY", "EUR/GBP", "AUD/USD",
  "XAU/USD", "US500",   "US100",   "DE40",    "UK100",
  "WTI",     "BRENT",
  "AAPL",    "MSFT",    "NVDA",    "TSLA",    "AMZN",
];
void _TWELVEDATA_SYMBOLS_ALL; // referenced by paid-plan upgrade comment above

// Free plan claims an 8-symbol WS limit, but in practice it's a fixed
// allowlist, not a free choice of any 8: empirically (subscribe-status
// "fails" in the logs), GBP/USD, USD/JPY, AUD/USD, USD/CHF, US500 and US100
// ALL get rejected on this account regardless of which 8 are requested —
// only EUR/USD, XAU/USD, BTC/USD and AAPL have ever actually streamed.
// BTC/USD is kept for redundancy even though Binance now covers crypto too.
// Everything else falls back to the TwelveData-REST rotation (tertiary).
// Upgrade to TwelveData Basic ($8/mo) to unlock full real-time WS coverage.
const TWELVEDATA_WS_SYMBOLS = ["EUR/USD", "XAU/USD", "BTC/USD", "AAPL"];

const liquidityCore = new InternalLiquidityCore({
  symbols:  SYMBOLS,
  tickMs:   quoteIntervalMs,
  onBatch:  (quotes) => {
    // Broadcast the full quote batch to all connected WebSocket clients
    if (wss.clients.size === 0) return;
    const payload = JSON.stringify({ type: "market.quotes", payload: quotes });
    for (const rawClient of wss.clients) {
      const client = rawClient as AuthenticatedSocket;
      if (client.readyState !== client.OPEN) continue;
      if (liveTradingEnabled && !client.authenticated) continue;
      // REALTIME_FREEZE.md H.4: this is the highest-frequency broadcast in
      // the app (~1/s to every connected client) and the finding's own
      // primary example of unbounded backpressure -- skip a client that's
      // already behind rather than piling another full quote batch onto its
      // write buffer. Next tick (~1s) supersedes this one anyway (latest-
      // value-wins), so dropping one batch for a backpressured client loses
      // nothing a fresh tick won't immediately replace.
      if (isBackpressured(client)) continue;
      try { client.send(payload); } catch { /* ignore closed sockets */ }
    }
  },
});

liquidityCore.start();

// REALTIME_FREEZE.md M.9 (FASE 7 CLOSURE, Phase A): DOMDepthPage.tsx's
// "order book depth" was poll-only (10s) with no WS alternative -- reads as
// if it'd need new order-book-depth production from the liquidity engine to
// fix, which would be a genuine feature build. It doesn't: GET /dom/:symbol
// already synthesizes the whole book on every call via
// virtualOrderbook.build() (liquidity-engine/virtual.orderbook.ts), a pure,
// cheap (10 levels, O(1) arithmetic, no I/O) function of the SAME
// bid/ask/mid/spread/changePct that market.quotes already broadcasts live
// every ~1s -- there's no new state to produce, only an existing
// computation to also push instead of only serving on request. Matches the
// frontend's own 10s cadence (DOM_DEPTH_REFRESH_MS) rather than the 1s
// quote tick -- ladder structure genuinely is slower-moving than top-of-
// book, per DOMDepthPage.tsx's own existing comment; broadcasting all books
// every 1s would be pure waste. Broadcasts for the same SYMBOLS list
// market.quotes already covers (not a frontend-specific DOM_SYMBOLS subset)
// to avoid a second, independently-maintained symbol list drifting out of
// sync with the one the UI actually offers.
const DOM_BOOK_BROADCAST_MS = 10_000;
setInterval(() => {
  if (wss.clients.size === 0) return;
  // Same enriched shape GET /dom/:symbol already returns (gateway/routes.ts)
  // -- changePct/generatedAt aren't part of virtualOrderbook.build()'s own
  // return type, added here the same way the REST handler adds them, so the
  // frontend's DomBook shape (and its existing REST-populated cache entry)
  // is a drop-in match either way.
  const books: Record<string, unknown> = {};
  for (const symbol of SYMBOLS) {
    const quote = quoteCache.get(symbol);
    if (!quote) continue;
    const book = virtualOrderbook.build({
      symbol,
      bid:        quote.bid,
      ask:        quote.ask,
      mid:        quote.mid,
      spread:     quote.spread,
      changePct:  quote.changePct,
      assetClass: assetClassOf(symbol),
    });
    books[symbol] = {
      symbol:      book.symbol,
      provider:    book.provider,
      bid:         book.bid,
      ask:         book.ask,
      spread:      book.spread,
      spreadBps:   book.spreadBps,
      changePct:   quote.changePct,
      bids:        book.bids,
      asks:        book.asks,
      generatedAt: new Date().toISOString(),
    };
  }
  if (Object.keys(books).length > 0) broadcast("dom.book", books);
}, DOM_BOOK_BROADCAST_MS);

// ─── TwelveData: live price seed then historical candle seed ─────────────────
//
// 1. REST /quote seeds current prices for all instruments at startup.
//    liquidityCore.seedDailyData() makes these immediately available to execution.
// 2. REST /time_series seeds full OHLCV history for all symbols + timeframes.
//    Runs after the live seed to avoid 429 contention on the rate-limit budget.
//
if (twelvedataKey) {
  void (async () => {
    // 1. Live quote seed — fetch ALL 19 symbols in one REST call at startup.
    //    Costs 1 API credit (or 19 if TwelveData counts per-symbol).
    //    Gives every instrument a real anchor price before the WebSocket and
    //    batch-rotation catch up. Using _TWELVEDATA_SYMBOLS_ALL to cover
    //    symbols not on the free-plan WebSocket (DE40, WTI, MSFT, etc.).
    try {
      const quotes = await fetchLiveQuotes(twelvedataKey, _TWELVEDATA_SYMBOLS_ALL);
      let seeded = 0;
      for (const [_sym, q] of quotes) {
        liquidityCore.seedDailyData(q.symbol, q.close, q.prevClose);
        seeded++;
      }
      console.log(`[market-data] REST seed complete — ${seeded}/${_TWELVEDATA_SYMBOLS_ALL.length} symbols anchored to live prices`);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("429")) {
        console.warn("[market-data] REST seed skipped — TwelveData daily quota exhausted. WebSocket will provide real prices within seconds.");
      } else {
        console.warn("[market-data] REST seed failed — WebSocket will provide real prices:", msg);
      }
    }

    // 2. Historical candle seed — skipped on free plan to preserve REST quota.
    //    Enable by setting ENABLE_HISTORICAL_SEED=true (paid plan only).
    if (process.env.ENABLE_HISTORICAL_SEED !== "true") {
      console.log("[seeder] historical seed skipped — set ENABLE_HISTORICAL_SEED=true to enable (paid plan)");
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
    import("./market-data/historical.seeder.js").then(({ seedHistoricalCandles }) => {
      seedHistoricalCandles(twelvedataKey).catch((err: Error) =>
        console.error("[seeder] error:", err.message),
      );
    }).catch((err: Error) => {
      console.error("[seeder] failed to load historical.seeder:", err.message);
    });
  })();
}


// ── FeedManager: primary (TwelveData WS) + secondary (Binance WS, crypto) + tertiary (TwelveData REST) ──
// Finnhub was dropped from the price-feed path — this account's plan doesn't
// actually include real-time OANDA forex data despite WS subscriptions
// silently succeeding (confirmed via a direct REST call returning "You don't
// have access to this resource" for forex symbols). No Yahoo Finance/CoinGecko/
// Frankfurter integration exists — those were an earlier design replaced by
// TwelveData+Binance. All feeds independently call ingestExternalPrice() so
// any live source keeps quoteCache fresh (STALE_THRESHOLD_MS resets on each tick).
const feedManager = new FeedManager({
  apiKey:        twelvedataKey,
  symbols:       SYMBOLS,               // all 22 instruments
  wsSymbols:     TWELVEDATA_WS_SYMBOLS, // WS limited to 8 on free plan
  ingestPrice: (symbol, mid, bid, ask, source) => {
    // MARKET_DATA_FREEZE.md §0.2: normalize once, here, before handing the
    // symbol to EITHER consumer. feedHealthMonitor used to receive the raw
    // feed-format symbol (e.g. "EUR/USD" from the WS feed) while
    // liquidityCore normalized internally (-> "EURUSD") -- feedHealthMonitor
    // stored freshness under a key nothing else ever queried, so it reported
    // the WS-covered symbols (the freshest, best-covered ones) as
    // permanently stale. ingestExternalPrice() still normalizes internally
    // too (idempotent on an already-clean symbol), so this doesn't change
    // its behavior -- it just guarantees both consumers key off the exact
    // same string.
    const key = normaliseSymbol(symbol);
    // MARKET_DATA_FREEZE.md §0.6: forward which feed produced this tick so
    // a lower-priority source can't overwrite a higher-priority one's
    // fresher data purely by arriving later at the server.
    //
    // MARKET_DATA_FREEZE.md §0.8: feedHealthMonitor used to be recorded
    // BEFORE ingestExternalPrice() validated the tick at all -- a tick
    // ingestExternalPrice rejected (invalid, outlier, lower-priority) could
    // still be counted as a fresh, healthy quote by the health monitor,
    // with garbage bid=0/ask=0 when bid/ask were undefined. Now only a
    // tick this class actually accepted and wrote is recorded as fresh.
    const accepted = liquidityCore.ingestExternalPrice(key, mid, bid, ask, source);
    if (accepted) {
      feedHealthMonitor.recordQuote(key, bid ?? 0, ask ?? 0, "feed-manager");
      // MARKET_DATA_FREEZE.md §0.10: relay this worker's own local tick to
      // every other worker (no-op if Redis is unavailable — see
      // publishTick's own doc comment for why this is safe to fire from
      // exactly this call site and no other).
      void redisPubSub.publishTick(key, mid, bid, ask);
    }
  },
});

feedManager.start();
feedHealthMonitor.start(SYMBOLS);
(globalThis as Record<string, unknown>).__feedManager = feedManager;

// ─── Adaptive Intelligence: warm calendar + weights from DB ─────────────────
await Promise.all([
  economicEventService.warmFromDB().catch((err) =>
    console.warn("[economic-calendar] DB warm failed:", (err as Error).message),
  ),
]).catch(() => {/* non-fatal */});

// ─── Signal Generator ────────────────────────────────────────────────────────
const signalGenerator = new SignalGenerator(prisma);
console.log("[signal-engine] OLOS SignalGenerator initialised");

// Seed indicator engines from synthetic candle history so EMA200 (needs 200 bars)
// is ready immediately. Without this, warm-up takes ~16 hours at one tick per 60s.
{
  const SEED_SYMBOLS   = ["EURUSD", "XAUUSD", "US500", "BTCUSD", "GBPUSD"];
  const SEED_TIMEFRAME = "1H";
  for (const sym of SEED_SYMBOLS) {
    const history = getCandles(sym, SEED_TIMEFRAME, 250);
    if (history.length > 0) signalGenerator.seedEngines(sym, history);
  }
}

// ─── OLOS Signal Engine — periodic evaluation ─────────────────────────────────
// Reads from quoteCache (written by liquidityCore) — same source of truth.
const SIGNAL_SYMBOLS   = ["EURUSD", "XAUUSD", "US500", "BTCUSD", "GBPUSD"];
const SIGNAL_TIMEFRAME = "1H";
let signalTick = 0;
configureScanSchedule(signalIntervalMs, SIGNAL_SYMBOLS.length);

setInterval(async () => {
  if (!(await jobCoordinator.tryLead("signal-generator"))) return;

  try {
    recordScan();
    const symbol = SIGNAL_SYMBOLS[signalTick % SIGNAL_SYMBOLS.length];
    signalTick++;

    const quote = quoteCache.get(symbol); // ← reads from LiquidityCore output
    if (!quote) return;
    // MARKET_DATA_FREEZE.md §0.14: unlike order.controller.ts/liquidation.
    // engine.ts, this loop never checked quoteCache.isStale() -- a symbol
    // that HAD a quote once but whose feed has since died still passed the
    // `!quote` check (the last frozen quote is never cleared) and could
    // generate a signal off a stale price/candle, while a real order on
    // the same symbol would simultaneously be rejected with
    // NO_LIVE_MARKET_DATA at the same instant.
    if (quoteCache.isStale(symbol)) return;

    const utcHour = new Date().getUTCHours();
    const sessionMult = (utcHour >= 13 && utcHour <= 17) ? 1.4
                      : (utcHour >= 8  && utcHour <= 21) ? 1.0
                      : 0.5;
    const signalVol = Math.round(10_000 * sessionMult);

    // Prefer the last completed 1H candle from the aggregator — it has real
    // OHLCV structure with proper high/low range, making RSI/MACD meaningful.
    // Fall back to a spread-derived tick candle only when no history exists.
    const history1h  = getCandles(symbol, SIGNAL_TIMEFRAME, 2);
    const lastCandle = history1h.length > 0 ? history1h[history1h.length - 1] : null;
    const spread     = quote.spread ?? 0;
    const candle = lastCandle ?? {
      time:   Math.floor(Date.now() / 1_000),
      open:   quote.mid * (1 - spread * 0.3),
      high:   quote.mid * (1 + spread * 0.8),
      low:    quote.mid * (1 - spread * 0.8),
      close:  quote.mid,
      volume: signalVol,
    };

    const signal = await signalGenerator.evaluate(symbol, candle, SIGNAL_TIMEFRAME);
    if (signal) {
      console.log(
        `[signal-engine] ${symbol} → ${signal.signalType} conf=${signal.confidence.toFixed(1)}%`,
      );
    }
  } catch {
    // Non-blocking — signal errors never crash the server
  } finally {
    await jobCoordinator.release("signal-generator");
  }
}, signalIntervalMs);

// ─── Economic Calendar — refresh every 6 hours (ForexFactory + TE + FRED) ────
const CALENDAR_INTERVAL_MS = 6 * 60 * 60_000;
setInterval(async () => {
  if (!(await jobCoordinator.tryLead("economic-calendar"))) return;
  try {
    await economicEventService.refresh();
  } catch (err) {
    console.error("[economic-calendar] refresh error:", (err as Error).message);
  } finally {
    await jobCoordinator.release("economic-calendar");
  }
}, CALENDAR_INTERVAL_MS);
// Kick off an immediate first refresh at startup (non-blocking)
void economicEventService.refresh().catch(() => {/* logged inside */});

// ─── Signal Telemetry + OLOS signals — expire stale entries every hour ───────
async function runSignalExpiry(): Promise<void> {
  if (!(await jobCoordinator.tryLead("signal-expire"))) return;
  try {
    const telemetryCount = await signalTelemetry.expireStaleSignals();
    if (telemetryCount > 0) console.log(`[signal-telemetry] expired ${telemetryCount} stale signals`);
    const olosCount = await olosSignalService.expireStaleActiveSignals();
    if (olosCount > 0) console.log(`[olos-signal-service] expired ${olosCount} stale ACTIVE signals`);
  } catch (err) {
    // Was silently swallowed before — a real query failure here means stale
    // ACTIVE signals pile up for days and look like duplicated/fake signals
    // to users. Must be visible.
    console.error("[signal-expire] run failed:", (err as Error).message);
  } finally {
    await jobCoordinator.release("signal-expire");
  }
}
setInterval(runSignalExpiry, 60 * 60_000);
// Run once at startup too — otherwise a freshly (re)started server can leave
// days-old ACTIVE signals visible for up to an hour before the first tick.
void runSignalExpiry();

// ─── Self-Optimizer — weekly confidence weight recalibration ─────────────────
const OPTIMIZER_INTERVAL_MS = 7 * 24 * 60 * 60_000;
setInterval(async () => {
  if (!(await jobCoordinator.tryLead("olos-self-optimizer"))) return;
  try {
    const result = await selfOptimizer.run();
    if (!result.ran) {
      console.log(`[self-optimizer] skipped: ${result.skippedReason}`);
    }
  } catch (err) {
    console.error("[self-optimizer] run error:", (err as Error).message);
  } finally {
    await jobCoordinator.release("olos-self-optimizer");
  }
}, OPTIMIZER_INTERVAL_MS);

// ─── Task 13: Monthly partition maintenance ───────────────────────────────────
// Runs daily (the underlying SQL function is idempotent — it only creates
// partitions that don't exist yet) to pre-create next 3 months of archive
// partitions. Leader-elected so only one node runs it in a multi-worker cluster.
//
// NOTE: must stay well under Node's setInterval 32-bit limit (~24.8 days /
// 2_147_483_647 ms). A literal "30 days" value (2_592_000_000 ms) overflows
// that limit and gets silently clamped to 1ms, causing a runaway loop that
// hammers the distributed lock every millisecond — do not reintroduce it.
const PARTITION_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60_000;
setInterval(async () => {
  if (!prisma) return;
  if (!(await jobCoordinator.tryLead("ledger-partition-maintenance"))) return;
  try {
    await prisma.$queryRaw`SELECT monthly_partition_maintenance()`;
    console.log("[partition-maintenance] monthly partitions ensured");
  } catch (err) {
    console.warn("[partition-maintenance] failed:", (err as Error).message);
  } finally {
    await jobCoordinator.release("ledger-partition-maintenance");
  }
}, PARTITION_MAINTENANCE_INTERVAL_MS);

// ─── Per-user event dispatch ──────────────────────────────────────────────────

// REALTIME_FREEZE.md H.3: monotonic per-(node, user) counter attached to
// every per-user WS message as `seq`, so a client can detect a gap or
// out-of-order delivery on its current connection. Deliberately NOT a
// Redis-backed cross-node counter -- pushToUser/sendToSocket are called from
// hot synchronous paths (e.g. position.pnl_updated on every tick); awaiting
// a Redis round-trip there would (a) hurt latency on the highest-frequency
// push path and (b) risk two concurrent callers resolving their INCR out of
// send order, which is a WORSE ordering bug than the one this fix removes.
// Consequence: `seq` gives a real, gap-detectable total order for messages
// delivered to a single connection (which is always exactly one node), but
// does NOT provide a global cross-node order -- two nodes racing to deliver
// to the same user's two open tabs via Redis pub/sub can still interleave
// (per-tab order is still correct; cross-tab is not). A true distributed
// sequencer is a larger, separate piece of work, flagged in
// REALTIME_CERTIFICATION_REPORT.md.
const wsSeqCounters = new Map<string, number>();
function nextSeq(userId: string): number {
  const next = (wsSeqCounters.get(userId) ?? 0) + 1;
  wsSeqCounters.set(userId, next);
  return next;
}

/**
 * Returns false on a send failure (broken pipe) OR when the socket is
 * currently backpressured (REALTIME_FREEZE.md H.4 -- see
 * WS_BACKPRESSURE_HIGH_WATER_MARK's docstring), so callers can decide
 * whether to stop/retry exactly as they already do for a broken pipe:
 * pushToUser() falls back to durable outbox persistence for outbox-tracked
 * events, and the connection-handler's replay loop stops sending further
 * events to a socket that's already behind rather than piling on.
 */
function sendToSocket(client: AuthenticatedSocket, type: string, data: unknown, extra?: Record<string, unknown>): boolean {
  if (isBackpressured(client)) return false;
  const msg = JSON.stringify({ type, payload: data, seq: nextSeq(client.userId!), ...extra });
  try { client.send(msg); return true; } catch { return false; }
}

// REALTIME_FREEZE.md H.3: fixes the outbox-replay-vs-live race described in
// the finding -- on reconnect, the connection handler below replays pending
// outbox rows via an un-awaited async IIFE; a synchronous eventBus handler
// (e.g. position.pnl_updated) could previously deliver a LIVE event on the
// SAME socket before the (older) replay finished, so the client could see
// new-then-old with no way to detect it. While `client.replaying` is true
// (set for the whole replay window, see the connection handler), this
// treats the socket as not-yet-reachable rather than buffering the message
// in-process: `enqueueAndPush`'s existing "not delivered" branch then
// persists it to the outbox (or reuses `existingOutboxId` for financial
// events that already have one) and relays via Redis, so it's picked up by
// the very same replay this connection is already running, or -- if the
// row was created after this replay's query already ran -- by the
// pre-existing "outbox-retry-sweep" job (30s interval) or the next
// reconnect. Deliberately NOT an in-process buffer-then-flush: that would
// mean `enqueueAndPush` marks a financial event's outbox row published (via
// `existingOutboxId`) before it was actually sent, which is a real,
// permanent-loss risk if the socket drops in the gap between buffering and
// flush -- worse than the ordering bug this fix removes. Non-durable
// pushes with no outbox row at all (e.g. position.pnl_updated) are simply
// dropped for this narrow window, consistent with their already-documented
// fire-and-forget, no-durability-guarantee nature (see M.7).
/** Returns true if at least one socket for the user received the message. */
function pushToUser(userId: string, type: string, data: unknown): boolean {
  let delivered = false;
  for (const rawClient of wss.clients) {
    const client = rawClient as AuthenticatedSocket;
    if (client.readyState !== client.OPEN) continue;
    if (client.userId !== userId) continue;
    if (client.replaying) continue;
    if (sendToSocket(client, type, data)) delivered = true;
  }
  return delivered;
}

// REALTIME_FREEZE.md H.2: admin/compliance/risk staff previously had zero WS
// signal for anything -- MarginRiskBoard, AMLAlerts, etc. were pure poll
// (10-30s) with no live push of any kind, including for margin calls and AML
// flags an operator should see immediately. Local-node-only by design: unlike
// pushToUser/broadcast, this filters by role, and the existing cross-node
// relay (redisPubSub.publishBroadcast → onBroadcastEvent) fans a broadcast
// out to EVERY authenticated client on every other node with no role
// filtering -- reusing it here would leak compliance-sensitive alerts (AML
// flags) to any authenticated trader connected to a different node. A
// role-aware cross-node channel is a larger, separate piece of work (tracked
// in REALTIME_CERTIFICATION_REPORT.md); this delivers to staff connected to
// THIS node only, which is the same single-node reach pushToUser had before
// Task 9's Redis relay was added.
//
// `allowedRoles` are lowercase ("admin", "risk", "compliance", "super_admin")
// -- the actual vocabulary TokenPayload.roles carries end-to-end (issued by
// auth.service.ts straight from User.roles, matched against by
// access.policy.ts's real ROLE_PERMISSIONS table; see prisma/seed.ts's admin
// user: roles: ["admin", "compliance", "risk"]). Deliberately NOT
// security/rbac.engine.ts's RoleName ("ADMIN", "RISK_MANAGER", ...) -- that's
// a separate, uppercase vocabulary that permission.middleware.ts casts real
// lowercase roles into with `as RoleName[]`, an unsafe cast that never
// matches at runtime. Copying that mismatch here would make every staff push
// silently match nobody. Not fixing permission.middleware.ts itself -- that
// RBAC case-sensitivity bug is real but outside REALTIME_FREEZE.md's scope;
// flagged separately in REALTIME_CERTIFICATION_REPORT.md.
function pushToStaff(type: string, data: unknown, allowedRoles: readonly string[]): void {
  for (const rawClient of wss.clients) {
    const client = rawClient as AuthenticatedSocket;
    if (client.readyState !== client.OPEN) continue;
    if (!client.authenticated || !client.roles) continue;
    if (!client.roles.some((r) => allowedRoles.includes(r))) continue;
    sendToSocket(client, type, data);
  }
}

// ─── Redis cross-node delivery callbacks ─────────────────────────────────────
// These are registered with redisPubSub.start() below and called when a message
// arrives from another node that was NOT originated by this worker.

function onUserEvent(userId: string, eventType: string, payload: Record<string, unknown>): void {
  const outboxId = payload.__outboxId as string | undefined;
  const cleanPayload = outboxId
    ? (({ __outboxId: _, ...rest }) => rest)(payload)
    : payload;

  const delivered = pushToUser(userId, eventType, cleanPayload);
  if (delivered && outboxId) {
    void outboxService.markPublished(outboxId);
  }
}

function onBroadcastEvent(eventType: string, payload: Record<string, unknown>): void {
  const msg = JSON.stringify({ type: eventType, payload });
  for (const rawClient of wss.clients) {
    const client = rawClient as AuthenticatedSocket;
    if (client.readyState !== client.OPEN) continue;
    if (liveTradingEnabled && !client.authenticated) continue;
    if (isBackpressured(client)) continue; // REALTIME_FREEZE.md H.4
    try { client.send(msg); } catch { /* ignore */ }
  }
}

// MARKET_DATA_FREEZE.md §0.10: applies a tick relayed from another worker's
// own local feed connections. Always tagged "redis-relay" (the lowest
// SOURCE_PRIORITY rank) so this worker's own local feeds, when active,
// always win -- a relayed tick only fills in data this worker's own feeds
// haven't produced recently. Never re-published (see publishTick's own
// doc comment) -- this is strictly a one-hop relay, not a chain.
function onTickEvent(symbol: string, mid: number, bid?: number, ask?: number): void {
  liquidityCore.ingestExternalPrice(symbol, mid, bid, ask, "redis-relay");
}

/**
 * P6 — Push via WebSocket first; only persist to DB outbox if offline.
 *
 * Cross-node path (Task 9 Part A):
 *   Locally delivered → also publish to Redis so other nodes push to any
 *   additional sessions the same user has open on those nodes.
 *
 *   Not locally delivered → persist to outbox (survives reconnect), then
 *   publish to Redis with __outboxId so a remote node that has the user
 *   connected can deliver it AND mark the outbox row published — preventing
 *   the background sweep from re-delivering the same event.
 *
 * FASE 2.1 — existingOutboxId: for financial events (order.filled,
 * order.partial_filled, position.closed) the OutboxEvent row is now created
 * inside the same DB transaction as the position/wallet/ledger update
 * (execution.engine.ts / settlement.engine.ts), so it already exists by the
 * time this runs. Passing its id here means this function only ever marks it
 * published or references it for cross-node relay — it never creates a
 * second, redundant row for the same financial event. When omitted (every
 * other event type), behavior is unchanged: create-on-demand as before.
 */
function enqueueAndPush(
  userId: string,
  wsType: string,
  data:   Record<string, unknown>,
  existingOutboxId?: string,
): void {
  const delivered = pushToUser(userId, wsType, data);
  if (delivered) {
    // User is connected here — also notify other nodes (multi-device / multi-tab)
    void redisPubSub.publishUser(userId, wsType, data);
    if (existingOutboxId) void outboxService.markPublished(existingOutboxId);
  } else {
    // User not connected on this node — persist (unless already durable) then notify remote nodes
    void (async () => {
      const outboxId = existingOutboxId ?? await outboxService.enqueue(wsType, data, userId);
      const payload  = outboxId ? { ...data, __outboxId: outboxId } : data;
      void redisPubSub.publishUser(userId, wsType, payload);
    })();
  }
}

function broadcast(type: string, data: unknown): void {
  const msg = JSON.stringify({ type, payload: data });
  for (const rawClient of wss.clients) {
    const client = rawClient as AuthenticatedSocket;
    if (client.readyState !== client.OPEN) continue;
    if (isBackpressured(client)) continue; // REALTIME_FREEZE.md H.4
    try { client.send(msg); } catch { /* ignore */ }
  }
  // Notify other nodes to broadcast to their locally-connected clients
  void redisPubSub.publishBroadcast(type, data as Record<string, unknown>);
}

// ─── Event Bus → WebSocket bridge ────────────────────────────────────────────
//
// P6: critical user-facing events go through enqueueAndPush so they survive
//     disconnections.  High-frequency streaming events (pnl_updated, quotes)
//     stay fire-and-forget to avoid flooding the outbox table.
//
// ─── Unified event schemas (P6) ───────────────────────────────────────────────
// WebSocket event names are the canonical contract consumed by the frontend.
// Use consistent names that match the frontend stream subscriptions.

// PRODUCTION CUTOVER Stage 3 — see BrokerState.syncUserFromDatabase()'s
// comment: without this, a client registered via the real, persistent
// /auth/register/db path is invisible to the admin/CRM panel until the
// next process restart (hydrateFromDatabase only runs at boot).
eventBus.on("user.registered", (event) => {
  void state.syncUserFromDatabase(event.userId);
});

eventBus.on("order.filled", (event) => {
  // FASE 2.1: outboxId (if present) points at the row already committed
  // atomically with the fill in execution.engine.ts — strip it from the
  // client-facing payload and thread it through so enqueueAndPush marks that
  // row published instead of creating a new one.
  const { outboxId, ...rest } = event;
  const payload = { ...rest, status: "FILLED" } as Record<string, unknown>;
  // "execution" for backward compat + "order.filled" canonical — the alias
  // keeps its own independent outbox-on-demand behavior (unchanged).
  enqueueAndPush(event.userId, "order.filled", payload, outboxId);
  enqueueAndPush(event.userId, "execution", payload);
});
eventBus.on("order.partial_filled", (event) => {
  const { outboxId, ...rest } = event;
  const payload = { ...rest, status: "PARTIALLY_FILLED" } as Record<string, unknown>;
  enqueueAndPush(event.userId, "order.partial_filled", payload, outboxId);
});
eventBus.on("order.rejected", (event) => {
  const payload = { ...event, status: "REJECTED" } as Record<string, unknown>;
  enqueueAndPush(event.userId, "order.rejected", payload);
  enqueueAndPush(event.userId, "execution", payload);
});
// REALTIME_FREEZE.md L.1: intermediate order lifecycle states -- all
// actively emitted, all previously zero listener -- so the client only ever
// saw terminal states (FILLED/PARTIAL/REJECTED/CLOSED), never the states
// leading up to them. The frontend's trading.store.ts already had a
// wsClient.on("order.pending", ...) listener waiting for a message type
// this bridge never sent (dead frontend code, live-and-waiting -- see
// trading.store.ts's own commit for the L.1 frontend half).
eventBus.on("order.pending", (event) => {
  enqueueAndPush(event.userId, "order.pending", event as unknown as Record<string, unknown>);
});
eventBus.on("order.cancelled", (event) => {
  enqueueAndPush(event.userId, "order.cancelled", event as unknown as Record<string, unknown>);
});
eventBus.on("order.trigger_failed", (event) => {
  enqueueAndPush(event.userId, "order.trigger_failed", event as unknown as Record<string, unknown>);
});
eventBus.on("order.stop_limit_armed", (event) => {
  enqueueAndPush(event.userId, "order.stop_limit_armed", event as unknown as Record<string, unknown>);
});
eventBus.on("order.limit_expired", (event) => {
  enqueueAndPush(event.userId, "order.limit_expired", event as unknown as Record<string, unknown>);
});
eventBus.on("signal.generated", (event) => {
  broadcast("signal.generated", event);

  // Feed the signal into the autopilot pipeline for every user who has it enabled.
  // The pipeline checks per-user config internally — non-blocking.
  if (prisma) {
    void (async () => {
      const users = await (prisma as NonNullable<typeof prisma>).autopilotConfig.findMany({
        where: { enabled: true },
        select: { userId: true },
      });
      for (const { userId } of users) {
        void autopilotPipeline.evaluate({
          userId,
          symbol:     String(event.symbol ?? ""),
          signalType: (event.signalType ?? event.direction ?? "NEUTRAL") as "BUY" | "SELL" | "NEUTRAL",
          confidence: Number(event.confidence ?? 0),
          entryPrice: event.entryPrice ? Number(event.entryPrice) : undefined,
          stopLoss:   event.stopLoss   ? Number(event.stopLoss)   : undefined,
          takeProfit: event.targetLevels?.[0] ? Number(event.targetLevels[0]) : undefined,
          timeframe:  String(event.timeframe ?? "1H"),
          signalId:   String(event.signalId ?? event.id ?? ""),
        }, state).catch((err) => {
          console.error(`[autopilot] pipeline error for user ${userId}:`, (err as Error).message);
        });
      }
    })();
  }
});
// FASE 7 CLOSURE, Phase A (M.6): risk.warning is now margin/liquidation-risk
// only (settlement.engine.ts's post-liquidation summary) -- compliance
// alerts moved to their own compliance.alert event below.
eventBus.on("risk.warning", (event) => {
  enqueueAndPush(event.userId, "risk.warning", { warning: event });
});
// REALTIME_FREEZE.md H.2 (moved here under M.6's split, same logic):
// compliance-engine's 4 producers (AML, sanctions, transaction monitoring,
// generic compliance alerts) previously emitted under "risk.warning",
// disambiguated only by an optional `type` field every consumer either
// ignored or (risk.store.ts) would have rendered as a margin warning with
// marginLevel/riskScore silently defaulting to 0. HIGH/CRITICAL alerts
// reach staff live (compliance-engine's own producers already gate MEDIUM
// and below before emitting, except aml.engine.ts's `!== "LOW"` -- this
// filter still matters for that one case).
eventBus.on("compliance.alert", (event) => {
  enqueueAndPush(event.userId, "compliance.alert", event as unknown as Record<string, unknown>);
  if (event.severity === "HIGH" || event.severity === "CRITICAL") {
    pushToStaff("admin.aml_alert", event, ["super_admin", "admin", "compliance"]);
  }
});
eventBus.on("position.opened", (event) => {
  enqueueAndPush(event.userId, "position.opened", event as unknown as Record<string, unknown>);
});
// REALTIME_FREEZE.md H.6: position.service.ts has emitted this on every
// SL/TP edit since it was written, but nothing ever bridged it to WS -- a
// user who modified SL/TP got no live confirmation of their own change
// (only whatever the synchronous REST response showed). Discrete,
// low-frequency, meaningful edit -- durable via enqueueAndPush like
// position.opened, not fire-and-forget like the high-frequency
// position.pnl_updated tick stream below.
eventBus.on("position.updated", (event) => {
  enqueueAndPush(event.userId, "position.updated", event as unknown as Record<string, unknown>);
});
eventBus.on("position.closed", (event) => {
  // FASE 2.1: see order.filled above — outboxId points at the row already
  // committed atomically with the close in settlement.engine.ts.
  const { outboxId, ...rest } = event;
  enqueueAndPush(event.userId, "position.closed", rest as unknown as Record<string, unknown>, outboxId);
});
eventBus.on("position.pnl_updated", (event) => {
  // High-frequency streaming — no outbox persistence
  pushToUser(event.userId, "position.pnl_updated", event);
});
eventBus.on("wallet.event", (event) => {
  // Canonical name: wallet.updated
  const payload = event as unknown as Record<string, unknown>;
  enqueueAndPush(event.userId, "wallet.updated", payload);
  // Keep backward-compat alias
  enqueueAndPush(event.userId, "wallet.event", payload);
});
// REALTIME_FREEZE.md L.6: DepositPanel.tsx's 3s poll previously had no WS
// alternative for the async PSP-webhook-driven transitions (CONFIRMED/
// CREDITED/FAILED) it's watching for.
eventBus.on("deposit.status_changed", (event) => {
  enqueueAndPush(event.userId, "deposit.status_changed", event as unknown as Record<string, unknown>);
});
eventBus.on("margin.warning", (event) => {
  enqueueAndPush(event.userId, "margin.warning", event as unknown as Record<string, unknown>);
  // REALTIME_FREEZE.md H.2 (paired with Critical #1's margin.warning fix):
  // MARGIN_CALL/STOP_OUT are the two actionable thresholds an operator needs
  // to react to, not the softer WARNING level -- pushing WARNING too would
  // fire far more often than is useful for an admin alert. MarginRiskBoard.tsx
  // previously had zero live signal (15s poll only, per the finding's own
  // callout that it "could have been the second safety channel" for these
  // thresholds).
  if (event.threshold === "MARGIN_CALL" || event.threshold === "STOP_OUT") {
    pushToStaff("admin.margin_alert", event, ["super_admin", "admin", "risk"]);
  }
});
// REALTIME_FREEZE.md M.5: both previously reached only NotificationRouter
// (DB+email, itself poll-only per C.1's finding) / event.archive.ts --
// zero live WS push, so a user only saw a nightly swap charge or an
// autopilot-managed SL/TP change at their next positions refetch/poll, not
// as a live update. Low-frequency, meaningful state changes (daily swap
// job, autopilot sweep) -- durable via enqueueAndPush like position.updated
// (H.6), not fire-and-forget like the high-frequency pnl tick stream above.
eventBus.on("swap.accrued", (event) => {
  enqueueAndPush(event.userId, "swap.accrued", event as unknown as Record<string, unknown>);
});
eventBus.on("autopilot.position_managed", (event) => {
  enqueueAndPush(event.userId, "autopilot.position_managed", event as unknown as Record<string, unknown>);
});

// P6 — Background retry sweep: recover events for users who just came online.
// Runs every 30 s; only looks at events from the last 24 h.
// Leader-elected: one worker per cycle sweeps the DB — but the user it's
// trying to reach could be connected to ANY node, not just this leader.
// FASE 2.7: a local miss now falls back to the same Redis cross-node relay
// enqueueAndPush uses for the first delivery attempt — onUserEvent on
// whichever node actually has the user's socket marks the row published
// itself, asynchronously. Without this, a user on a non-leader node would
// never receive a re-delivery from this sweep no matter how many cycles ran.
setInterval(async () => {
  if (!(await jobCoordinator.tryLead("outbox-retry-sweep"))) return;
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const n = await outboxService.retryUnpublished(cutoff, (userId, eventType, payload, outboxId) => {
      const delivered = pushToUser(userId, eventType, payload);
      if (!delivered) {
        void redisPubSub.publishUser(userId, eventType, {
          ...(payload as Record<string, unknown>), __outboxId: outboxId,
        });
      }
      return delivered;
    });
    if (n > 0) console.log(`[outbox] background sweep recovered ${n} event(s) locally (cross-node relay attempted for the rest)`);
  } finally {
    await jobCoordinator.release("outbox-retry-sweep");
  }
}, 30_000);

// FASE 2.4 — Audit outbox consumer: turn order.filled/order.partial_filled/
// position.closed OutboxEvent rows into TradeAudit/AuditLog reliably.
// Runs every 10s so compliance records land close to real time without
// competing for the connection pool the way an inline write would.
// Leader-elected: one worker per cycle processes the batch; others skip.
setInterval(async () => {
  if (!prisma) return;
  if (!(await jobCoordinator.tryLead("audit-outbox-consumer"))) return;
  try {
    const r = await auditOutboxConsumer.processPending();
    if (r.failed > 0) console.warn(`[audit-consumer] processed=${r.processed} failed=${r.failed} skipped=${r.skipped}`);
  } catch (err) {
    console.error("[audit-consumer] run failed:", (err as Error).message);
  } finally {
    await jobCoordinator.release("audit-outbox-consumer");
  }
}, 10_000);

// FASE 2.6 — Notification outbox consumer: turn order.filled/position.closed
// OutboxEvent rows into reliable Notification rows (+ best-effort email).
// Runs every 15s — less urgent than audit (UX, not compliance), still close
// enough to real time that the client's in-app inbox and email land promptly.
// Leader-elected: one worker per cycle processes the batch; others skip.
setInterval(async () => {
  if (!prisma) return;
  if (!(await jobCoordinator.tryLead("notification-outbox-consumer"))) return;
  try {
    const r = await notificationOutboxConsumer.processPending();
    if (r.failed > 0) console.warn(`[notification-consumer] processed=${r.processed} failed=${r.failed} skipped=${r.skipped}`);
  } catch (err) {
    console.error("[notification-consumer] run failed:", (err as Error).message);
  } finally {
    await jobCoordinator.release("notification-outbox-consumer");
  }
}, 15_000);

// Outbox cleanup — delete published+audited+notified events older than 2h.
// Keeps the OutboxEvent table small (< 10k rows) to prevent INSERT latency
// growth as the index pages expand. Runs every 15 minutes.
// Leader-elected: prevents N workers each issuing the same DELETE at once.
// auditProcessed/notificationProcessed default to true for event types
// those consumers never touch, so this stays a no-op filter change for
// everything except the trade-lifecycle types — those must survive until
// both consumers (above) have actually processed them.
setInterval(async () => {
  if (!prisma) return;
  if (!(await jobCoordinator.tryLead("outbox-cleanup"))) return;
  try {
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const r = await (prisma as NonNullable<typeof prisma>).outboxEvent.deleteMany({
      where: { published: true, auditProcessed: true, notificationProcessed: true, createdAt: { lt: cutoff } },
    });
    if (r.count > 0) console.log(`[outbox] pruned ${r.count} published events`);
  } catch {
    // Non-fatal
  } finally {
    await jobCoordinator.release("outbox-cleanup");
  }
}, 15 * 60 * 1_000);

// ─── Schedulers ──────────────────────────────────────────────────────────────
//
// 1. Daily snapshot + swap accrual: 22:00 UTC (1-minute precision)
// 2. Reconciliation sweep: every 6 hours
// 3. Outbox retry: every 30s (already wired above)
//

function msUntilNext2200Utc(): number {
  const now  = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// Daily EOD jobs — fire at 22:00 UTC then every 24h
setTimeout(function eodJobs() {
  if (prisma) {
    console.log("[scheduler] running EOD jobs at 22:00 UTC");

    void dailySnapshotService.snapshotAll().then((r) => {
      console.log(`[daily-snapshot] ${r.usersSnapped} users snapped, ${r.errors} errors`);
    }).catch((err) => console.error("[daily-snapshot] failed:", (err as Error).message));

    // Swap accrual — persists to SwapAccrual table + LedgerEntry
    void swapAccrualService.accrueAll().then((r) => {
      console.log(`[swap-accrual] processed=${r.positionsProcessed} total=${r.totalSwapUsd.toFixed(2)} errors=${r.errors}`);
    }).catch((err) => console.error("[swap-accrual] failed:", (err as Error).message));
  }
  setTimeout(eodJobs, 24 * 60 * 60 * 1_000);
}, msUntilNext2200Utc());

// Stop-out monitor — every 30 seconds
// Scans all users with open positions for ESMA 50% margin level breach.
// Liquidates positions atomically via SettlementEngine.
setInterval(() => {
  if (prisma) {
    void stopOutEngine.scanAll().then((r) => {
      if (r.stopOuts > 0 || r.marginCalls > 0) {
        console.warn(`[stop-out] stopOuts=${r.stopOuts} marginCalls=${r.marginCalls} warnings=${r.warnings} scanned=${r.scannedUsers}`);
      }
      // LEDGER_FREEZE.md §0.11: per-user errors from this sweep used to be
      // collected into r.errors and never read by anyone -- a failure here
      // vanished with zero trace.
      if (r.errors.length > 0) {
        console.error(`[stop-out] ${r.errors.length} user(s) errored during scan:`, r.errors);
      }
    }).catch((err) => console.error("[stop-out] scan failed:", (err as Error).message));
  }
}, 30_000);

// FASE 2.5 — Liquidation watchdog: every 30 seconds.
// Periodic SL/TP recovery sweep — catches positions the tick-level monitor
// (position.price.monitor.ts) missed (capacity cap, restart gap, or a
// position whose ticks land on a different PM2 worker's cache). Not a
// second real-time engine: a stop-loss still reacts to the tick first,
// this only mops up what that path missed.
setInterval(async () => {
  if (!prisma) return;
  if (!(await jobCoordinator.tryLead("liquidation-watchdog"))) return;
  try {
    const r = await liquidationEngine.scanForMissedSlTp();
    if (r.closed > 0) {
      console.warn(`[liquidation-watchdog] recovered ${r.closed} missed SL/TP (scanned=${r.scanned} skippedStale=${r.skippedStale})`);
    }
  } catch (err) {
    console.error("[liquidation-watchdog] sweep failed:", (err as Error).message);
  } finally {
    await jobCoordinator.release("liquidation-watchdog");
  }
}, 30_000);

// MARKET_DATA_FREEZE.md §0.3 — Position monitor reconciliation: every 30 seconds.
// Re-adds any OPEN position missing from PositionPriceMonitor's in-memory
// cache (a failed addPosition()/position.opened event load, a restart race,
// or a position whose ticks land on a different worker's cache — same
// class of gap the liquidation watchdog above already covers for SL/TP).
// Bounds Position.markPrice/pnl staleness for a dropped position to one
// sweep interval instead of indefinitely.
setInterval(async () => {
  if (!prisma) return;
  if (!(await jobCoordinator.tryLead("position-monitor-reconciliation"))) return;
  try {
    const r = await positionPriceMonitor.reconcile();
    if (r.added > 0) {
      console.warn(`[position-monitor] reconcile: added ${r.added} missing position(s) (scanned=${r.scanned})`);
    }
  } catch (err) {
    console.error("[position-monitor] reconcile sweep failed:", (err as Error).message);
  } finally {
    await jobCoordinator.release("position-monitor-reconciliation");
  }
}, 30_000);

// FASE 3.2 — Symbol circuit breaker recovery: every 30 seconds.
// Auto re-enables a symbol the breaker itself halted, once its cooldown
// elapses (unless it re-tripped, which just extends the cooldown in-memory —
// see symbol.circuit.breaker.ts). Never touches a symbol an admin disabled
// directly through /admin/broker/spread.
setInterval(async () => {
  if (!(await jobCoordinator.tryLead("symbol-circuit-breaker-recovery"))) return;
  try {
    const r = await symbolCircuitBreaker.runRecoverySweep();
    if (r.recovered.length > 0) {
      console.log(`[symbol-circuit-breaker] resumed trading: ${r.recovered.join(", ")}`);
    }
  } catch (err) {
    console.error("[symbol-circuit-breaker] recovery sweep failed:", (err as Error).message);
  } finally {
    await jobCoordinator.release("symbol-circuit-breaker-recovery");
  }
}, 30_000);

// FASE 3.8 (Group D) — hedge queue sweep: every 60 seconds.
// Evaluates exposureRegistry's house-wide net position per symbol and
// records a HedgeOrder row for anything crossing hedge.policy.ts's
// threshold. With no external LP configured (NullExternalHedgeProvider is
// the only provider), every row resolves to REJECTED immediately — this is
// the audit trail the scaffold exists to produce, not a functioning hedge.
setInterval(async () => {
  if (!prisma) return;
  if (!(await jobCoordinator.tryLead("hedge-queue-sweep"))) return;
  try {
    const r = await hedgeQueue.runSweep();
    if (r.queued > 0) console.log(`[hedge-queue] recorded ${r.queued} hedge-order row(s) (evaluated ${r.evaluated} instruments)`);
  } catch (err) {
    console.error("[hedge-queue] sweep failed:", (err as Error).message);
  } finally {
    await jobCoordinator.release("hedge-queue-sweep");
  }
}, 60_000);

// Risk warning generator — every 30 seconds (Fix #9).
// Persists each active user's REAL current risk state (margin level,
// exposure heatmap, kill-switch status, etc.) so GET /risk/warning/*
// reflects reality instead of the previous hardcoded "STABLE"/"IDLE" stub.
setInterval(async () => {
  if (!prisma) return;
  if (!(await jobCoordinator.tryLead("risk-warning-generator"))) return;
  try {
    const r = await riskWarningGenerator.generateForAllActiveUsers();
    if (r.errors > 0) console.warn(`[risk-warning-generator] processed=${r.processed} errors=${r.errors}`);
  } catch (err) {
    console.error("[risk-warning-generator] run failed:", (err as Error).message);
  } finally {
    await jobCoordinator.release("risk-warning-generator");
  }
}, 30_000);

// Autopilot position manager — every 30 seconds.
// Break-even/trailing/regime-exit/time-stop for autopilot-opened positions,
// plus the platform-wide circuit breaker check.
setInterval(async () => {
  if (!prisma) return;
  if (!(await jobCoordinator.tryLead("autopilot-position-manager"))) return;
  try {
    const r = await autopilotPositionManager.manageOpenTrades(state);
    if (r.managed > 0) {
      console.log(`[autopilot-mgr] checked=${r.checked} managed=${r.managed}`);
    }
  } catch (err) {
    console.error("[autopilot-mgr] tick failed:", (err as Error).message);
  } finally {
    await jobCoordinator.release("autopilot-position-manager");
  }
}, 30_000);

// Global risk supervisor — every 30 seconds.
// Independent platform-wide safety evaluation (consecutive losses, drawdown,
// DB/Redis/feed health, execution failures/latency, volatility/spread anomalies).
// Only gates NEW autopilot entries (autopilot.pipeline.ts) — position management
// above always keeps running regardless of mode.
setInterval(async () => {
  if (!prisma) return;
  if (!(await jobCoordinator.tryLead("global-risk-supervisor"))) return;
  try {
    const r = await globalRiskSupervisor.evaluate();
    if (r.mode !== "NORMAL") {
      console.warn(`[risk-supervisor] mode=${r.mode} reason="${r.reason}"`);
    }
  } catch (err) {
    console.error("[risk-supervisor] tick failed:", (err as Error).message);
  } finally {
    await jobCoordinator.release("global-risk-supervisor");
  }
}, 30_000);

// Margin repair sweep — every 5 minutes.
// Detects and auto-releases orphan wallet.locked that arise when releaseMargin()
// exhausts all retries under extreme pool pressure (1000+ concurrent users).
setInterval(() => {
  if (prisma) {
    void reconciliationEngine.runFullWithRepair().then((r) => {
      if (r.repaired > 0) {
        console.warn(`[reconciliation] repaired ${r.repaired} user(s) — released ${r.totalReleased.toFixed(2)} USD orphan margin`);
      }
    }).catch((err) => console.error("[reconciliation] repair sweep failed:", (err as Error).message));
  }
}, 5 * 60 * 1_000);

// ─── Task 14: Data Retention + Enhanced Reconciliation ───────────────────────
//
// Data retention: daily at 03:30 UTC — after EOD snapshot (22:00) and swap
// accrual (22:00). Purges operational data, ensures next-month partitions exist.
//
// Enhanced reconciliation: daily at 03:00 UTC — checks swap accrual completeness,
// deposit integrity, P&L settlement, and position audit trail.

function msUntilNextUtcHour(hour: number, minuteOffset = 0): number {
  const now  = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    hour, minuteOffset, 0, 0,
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// Enhanced reconciliation — daily at 03:00 UTC
setTimeout(function enhancedReconJob() {
  if (prisma) {
    void enhancedReconciliationService.runDailyAudit().then((r) => {
      console.log(`[enhanced-recon] clean=${r.overallClean} mismatches=${r.totalMismatches} duration=${r.durationMs}ms`);
    }).catch((err) => console.error("[enhanced-recon] daily audit failed:", (err as Error).message));
  }
  setTimeout(enhancedReconJob, 24 * 60 * 60 * 1_000);
}, msUntilNextUtcHour(3, 0));

// Data retention sweep — daily at 03:30 UTC
setTimeout(function retentionJob() {
  if (prisma) {
    void dataRetentionService.run().then((r) => {
      console.log(`[retention] deleted=${r.totalDeleted} partitions=${r.partitionStatus.filter((p) => p.created).length} new`);
    }).catch((err) => console.error("[retention] sweep failed:", (err as Error).message));
  }
  setTimeout(retentionJob, 24 * 60 * 60 * 1_000);
}, msUntilNextUtcHour(3, 30));

// ─── Redis Pub/Sub: cross-node WebSocket delivery ────────────────────────────
// Start AFTER pushToUser / onUserEvent / onBroadcastEvent are defined above.
// Gracefully degrades to single-node-only if Redis is unavailable.
await redisPubSub.start(onUserEvent, onBroadcastEvent, onTickEvent).catch((err) => {
  console.warn("[redis-pubsub] start failed (single-node mode):", (err as Error).message);
});

// ─── Start ────────────────────────────────────────────────────────────────────
// Increase TCP listen backlog from the Node.js default (511) to handle
// burst connection queues at 1000+ VUs without returning ECONNREFUSED.
server.keepAliveTimeout = 30_000;
server.headersTimeout   = 35_000;

server.listen({ port, backlog: 10_000 }, async () => {
  const dbMode  = prisma ? "postgresql" : "in-memory";
  const mktMode = twelvedataKey
    ? `TwelveData feed active — stale symbols reject orders`
    : `NO MARKET DATA — TWELVEDATA_API_KEY not set — all orders will be rejected`;

  logger.info({ port, mode: liveTradingEnabled ? "LIVE" : "sandbox", auth: useRSA ? "RS256" : "HS256", dbMode, mktMode }, "server listening");
  console.log(`[igfxpro-apiv2] liquidity=IGFX_INTERNAL instruments=${SYMBOLS.length}`);
  console.log(`[igfxpro-apiv2] broker-spread-config=loaded defaults+DB overrides`);
  console.log(`[igfxpro-apiv2] signal-engine=active (interval=${signalIntervalMs / 1_000}s)`);
  console.log(`[igfxpro-apiv2] services: liquidity-core execution-engine risk-engine liquidation-engine events-bus outbox`);

  // ── Bloomberg-grade observability collectors ──────────────────────────────
  initAllMetrics();

  // Signal PM2 that this worker is ready to accept connections.
  // PM2 wait_ready: true waits for this before routing traffic.
  if (process.send) process.send("ready");

  // ── FIX 4.4 Acceptor — start only when explicitly enabled ─────────────────
  if (process.env.FIX_ENABLED === "true") {
    const { orderController } = await import("./trading-service/order.controller.js");
    const { cancelOrder }     = await import("./trading-service/order.cancel.js");

    initFixAcceptor(
      // Executor: NewOrderSingle → broker order engine
      async (req) => {
        try {
          // FIX account == userId for institutional sessions; tenantId isn't
          // carried on the wire, so resolve it from the user's own record.
          const fixUser = prisma ? await prisma.user.findUnique({ where: { id: req.account }, select: { tenantId: true } }) : null;
          if (!fixUser) throw new Error(`UNKNOWN_FIX_ACCOUNT: ${req.account}`);

          const result = await orderController.placeOrder(
            {
              symbol:   req.symbol,
              side:     req.side,
              type:     req.orderType,
              quantity: req.quantity,
              price:    req.price ?? req.stopPx,
              leverage: 1,
            },
            { userId: req.account, tenantId: fixUser.tenantId },
          );
          return {
            orderId:   result.id ?? "UNKNOWN",
            execId:    `EXEC-FIX-${Date.now()}`,
            status:    result.status === "FILLED" ? "FILLED" : "NEW",
            avgPx:     result.averageFillPrice ?? 0,
            cumQty:    result.status === "FILLED" ? req.quantity : 0,
            leavesQty: result.status === "FILLED" ? 0 : req.quantity,
          };
        } catch (err) {
          return {
            orderId: "REJECTED", execId: `EXEC-FIX-${Date.now()}`,
            status: "REJECTED", avgPx: 0, cumQty: 0, leavesQty: req.quantity,
            text: (err as Error).message,
          };
        }
      },
      // Canceller: OrderCancelRequest → cancel engine
      async (clOrdId, origClOrdId, account) => {
        try {
          await cancelOrder(origClOrdId || clOrdId, account, state);
          return {
            orderId: origClOrdId || clOrdId, execId: `EXEC-FIX-${Date.now()}`,
            status: "CANCELLED", avgPx: 0, cumQty: 0, leavesQty: 0,
          };
        } catch (err) {
          return {
            orderId: origClOrdId || clOrdId, execId: `EXEC-FIX-${Date.now()}`,
            status: "REJECTED", avgPx: 0, cumQty: 0, leavesQty: 0,
            text: (err as Error).message,
          };
        }
      },
    );
    console.log(`[igfxpro-apiv2] FIX 4.4 acceptor started on port ${process.env.FIX_PORT ?? 9878}`);
  }
});

// ─── Graceful shutdown (PM2 / Docker) ─────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "graceful shutdown starting");

  // 1. Stop accepting new HTTP connections
  server.close(() => {
    logger.info("HTTP server closed");
  });

  // 2. Close all existing WebSocket connections
  for (const client of wss.clients) {
    client.close(1001, "Server shutting down");
  }

  // 3. Stop market data feeds (no more price ticks)
  feedManager.stop();
  feedHealthMonitor.stop();

  // 4. Drain the Redis Pub/Sub subscriber connection
  await redisPubSub.stop().catch(() => { /* ignore */ });

  // 5. Task 13: Deregister from WS cluster, flush event archive, stop cache
  await wsCluster.deregister().catch(() => {});
  eventArchive.stop();
  distributedCache.stop();
  await disconnectReadReplica().catch(() => {});

  // 6. Flush in-flight DB writes then disconnect Prisma
  if (prisma) {
    try { await prisma.$disconnect(); } catch { /* ignore */ }
  }

  // Flush OTEL spans before exit
  await shutdownTelemetry().catch(() => undefined);

  logger.info("graceful shutdown complete");
  process.exit(0);
}

process.on("SIGINT",  () => { void shutdown("SIGINT");  });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

// PM2 sends "shutdown" message before SIGINT in cluster mode
process.on("message", (msg) => {
  if (msg === "shutdown") void shutdown("PM2_SHUTDOWN");
});

// Prevent unhandled promise rejections from crashing the server.
// Log them so they appear in server logs for debugging.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandledRejection (non-fatal)");
});

// Uncaught synchronous exceptions are fatal — log them and let the
// process manager (pm2 / tsx --watch) restart the server cleanly.
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException (fatal)");
  process.exit(1);
});
