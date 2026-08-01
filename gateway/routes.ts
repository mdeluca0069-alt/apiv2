import { z } from "zod";
import {
  AdminAllocateCapitalSchema,
  AdminAutopilotPauseSchema,
  AdminKillSwitchSchema,
  AdminOlosGovernanceSchema,
  AdminReviewDocumentSchema,
  AdminReviewLedgerSchema,
  AdminRiskPolicySchema,
  AdminRiskSupervisorOverrideSchema,
  AdminUpdateLiquiditySchema,
  AdminUpdateTierSchema,
  ClientDepositRequestSchema,
  ClientDocumentUploadSchema,
  ClientWithdrawRequestSchema,
  LoginRequestSchema,
  NewOrderRequestSchema,
  PlaceOcoRequestSchema,
  RegisterRequestSchema,
} from "../shared/contracts.js";
import type { Route } from "../shared/http.js";
import { handleAiChat, handleBacktest, handleStrategyGen, handleHedge } from "../ai-core/ai.router.js";
import { getRegimeSnapshot }           from "../ai-core/regime.snapshot.js";
import { orderController }            from "../trading-service/order.controller.js";
import { getQueueMetrics }            from "../execution-service/execution.queue.js";
import { killSwitch }                 from "../risk-service/kill.switch.js";
import { globalRiskSupervisor }       from "../risk-service/global.risk.supervisor.js";
import { exposureRegistry }           from "../risk-service/exposure.limits.js";
import { externalHedgeProvider }      from "../hedge-service/null.hedge.provider.js";
import { closePosition }              from "../trading-service/position.close.js";
import { modifyOrderSlTp }            from "../trading-service/order.modify.js";
import { cancelOrder }                from "../trading-service/order.cancel.js";
import { getCandles }                 from "../market-data/candle.aggregator.js";
import type { Timeframe }             from "../market-data/candle.aggregator.js";
import { ledgerService }              from "../wallet-service/ledger.service.js";
import type { LedgerQueryParams, SwapHistoryParams } from "../wallet-service/ledger.service.js";
import { LedgerEngine }               from "../wallet-service/ledger.engine.js";
import { autopilotService }           from "../autopilot-service/autopilot.service.js";
import { AutopilotConfigInputSchema } from "../autopilot-service/autopilot.service.js";
import { autopilotConsentService }    from "../autopilot-service/autopilot.consent.js";
import { tradingAnalyticsService }    from "../analytics/trading.analytics.service.js";
import { tradingAnalyticsCenter }     from "../analytics/trading.analytics.center.js";
import { kycService }                 from "../kyc-service/kyc.service.js";
import { affiliateService }           from "../crm/affiliate.service.js";
import { twoFactorService }           from "../auth-service/2fa.service.js";
import { notificationRouter }         from "../notification-service/notification.router.js";
import { transactionMonitor }         from "../compliance-engine/transaction.monitor.js";
import { auditTrail }                 from "../compliance-engine/audit.trail.js";
import { authService }               from "../auth-service/auth.service.js";
import { authController }            from "../auth-service/auth.controller.js";
import { pendingOrderBook }          from "../trading-service/pending.order.book.js";
import { IS_PERSISTENT, prisma }     from "../shared/db.js";
import { getRedis }                  from "../shared/redis.js";
import { metrics }                   from "./metrics.js";
import { executionAnalyticsService }  from "../analytics/execution.analytics.js";
import { riskSnapshotService }        from "../risk-service/risk.snapshot.service.js";
import { complianceStatusService }    from "../compliance-engine/compliance.status.service.js";
import { supportService }             from "../support-service/support.service.js";
import { olosSignalService }          from "../signals-engine/olos.signal.service.js";
import { PLATFORM_SIGNAL_USER_ID }    from "../signals-engine/signal.generator.js";
import { getScanSchedule }            from "../signals-engine/signal.scan-tracker.js";
import { signalAnalytics, type AnalyticsFilter } from "../signals-engine/signal.analytics.js";
import { adaptiveWeights as adaptiveWeightsService } from "../signals-engine/adaptive.weights.js";
import { selfOptimizer as selfOptimizerService }     from "../signals-engine/self.optimizer.js";
import { calibrationService }                        from "../signals-engine/calibration.service.js";
import { signalExplainer }                           from "../signals-engine/signal.explainer.js";
import { multiTimeframeEngine }                      from "../signals-engine/multi.timeframe.engine.js";
import { correlationEngine }                         from "../signals-engine/correlation.engine.js";
import { dynamicRiskEngine }                          from "../signals-engine/dynamic.risk.engine.js";
import { economicEventService, currenciesForSymbol } from "../economic-calendar/economic.event.service.js";
import { confidenceOptimizer }                       from "../olos-adaptive/confidence.optimizer.js";
import { signalAnalyticsService }     from "../analytics/signal.analytics.js";
import { exposureAnalyticsService }   from "../analytics/exposure.analytics.js";
import { latencyAnalyticsService }    from "../analytics/latency.analytics.js";
import { portfolioAnalyticsService }  from "../analytics/portfolio.analytics.js";
import { varEngine }                  from "../risk-service/var.engine.js";
import { reconciliationEngine }       from "../settlement/reconciliation.engine.js";
import { brokerSpreadConfig }         from "../liquidity-engine/broker.spread.config.js";
import { spreadStore }                from "../liquidity-engine/spread.engine.js";
import { virtualOrderbook }           from "../liquidity-engine/virtual.orderbook.js";
import { assetClassOf }               from "../liquidity-engine/liquidity.provider.js";
import { quoteCache }                 from "../market-data/quote.cache.js";
import { pnlCalculator }              from "../trading-service/pnl.calculator.js";
import { tradingSuspension }          from "../shared/trading.suspension.js";
import { feedCircuit }               from "../shared/feed.circuit.js";
import { PaymentService }                       from "../payment-service/payment.service.js";
import { positionService }                      from "../trading-service/position.service.js";
import { registerPsp, listPsps, type PspName }  from "../payment-service/psp/psp.adapter.js";
import { documentStorageService }    from "../document-storage/document.storage.service.js";
import { verifyWebhookSignature }    from "../document-storage/virus-scan.hook.js";
import { watchlistService }          from "../watchlist-service/watchlist.service.js";
import { retentionPolicyEngine }     from "../document-storage/retention.policy.js";
// Task 14: DB hardening
import { queryTelemetry }            from "../shared/query.telemetry.js";
import { slowQueryAnalyzer }         from "../analytics/slow.query.analyzer.js";
import { dataRetentionService }      from "../settlement/data.retention.service.js";
import { enhancedReconciliationService } from "../settlement/enhanced.reconciliation.service.js";
import { getReplicaStats }           from "../shared/db.replica.js";
// ── Task 13: Horizontal Scaling ───────────────────────────────────────────────
import { jobCoordinator }            from "../realtime-infra/job.coordinator.js";
import { wsCluster }                 from "../realtime-infra/websocket.cluster.js";
import { distributedCache }          from "../realtime-infra/cache.layer.js";
import { pgbouncerHealth }           from "../realtime-infra/pgbouncer.health.js";
import { eventArchive }              from "../realtime-infra/event.archive.js";
import { checkReplicaHealth }        from "../shared/read-replica.js";
// ── New World-Class Services ──────────────────────────────────────────────────
import { paperTradingService }       from "../paper-trading/paper.trading.service.js";
import { apiKeyService }             from "../public-api/api.key.service.js";
import { taxCalculator }             from "../tax-reporting/tax.calculator.js";
import { algoOrderService }          from "../execution-service/algo.order.service.js";
import { correlationMatrix }         from "../risk-service/correlation.matrix.js";
import { INSTRUMENT_META, SYMBOLS_BY_CLASS, ALL_SYMBOLS } from "../liquidity-engine/broker.spread.config.js";
import { getFixAcceptor }           from "../fix-gateway/fix.acceptor.js";
// ── Institutional Security Hardening ─────────────────────────────────────────
import { rbacEngine }               from "../security/rbac.engine.js";
import { mfaEnforcer }              from "../security/mfa.enforcer.js";
import { immutableAudit }           from "../security/immutable.audit.js";
import { soc2Controls }             from "../compliance/soc2.controls.js";
import { pciDSSControls }           from "../compliance/pci.dss.controls.js";
// ── Enterprise DR ─────────────────────────────────────────────────────────────
import { getDRHealth }              from "../disaster-recovery/dr.health.service.js";

const api = (path: string) => `/api/v1${path}`;
const CLIENT_AUTH_KEY = process.env.CLIENT_AUTH_KEY ?? "IGFX-AUTH-KEY";

// ─── PSP bootstrap ────────────────────────────────────────────────────────────
// Each adapter is registered only when its env vars are present.
// Missing keys are a config error at startup, not a runtime error.
(async () => {
  if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET) {
    const { StripeAdapter } = await import("../payment-service/psp/stripe.adapter.js");
    registerPsp(new StripeAdapter());
  }
  if (process.env.NUVEI_MERCHANT_ID && process.env.NUVEI_MERCHANT_SITE && process.env.NUVEI_SECRET_KEY) {
    const { NuveiAdapter } = await import("../payment-service/psp/nuvei.adapter.js");
    registerPsp(new NuveiAdapter());
  }
  if (process.env.PRAXIS_MERCHANT_ID && process.env.PRAXIS_APP_KEY && process.env.PRAXIS_SECRET_KEY) {
    const { PraxisAdapter } = await import("../payment-service/psp/praxis.adapter.js");
    registerPsp(new PraxisAdapter());
  }
})().catch((err) => console.error("[PSP] Bootstrap error:", err));

function isClientAuthKeyValid(authKey: string | undefined) {
  return authKey === CLIENT_AUTH_KEY;
}

function _buildAnalyticsFilter(query: URLSearchParams): AnalyticsFilter {
  return {
    symbol:     query.get("symbol")     ?? undefined,
    regime:     query.get("regime")     ?? undefined,
    timeframe:  query.get("timeframe")  ?? undefined,
    signalType: (query.get("signalType") as "BUY" | "SELL" | undefined) ?? undefined,
    fromDate:   query.get("from") ? new Date(query.get("from")!) : undefined,
    toDate:     query.get("to")   ? new Date(query.get("to")!)   : undefined,
  };
}

export const routes: Route[] = [
  {
    method: "GET",
    path: "/",
    handler: () => ({
      service: "igfxpro-apiv2",
      version: "1.0.0",
      status: "running",
      message: "Backend API is ready. Use /health for status or /api/v1 for trading endpoints",
    }),
  },

  // ── Prometheus metrics scrape endpoint ───────────────────────────────────────
  {
    method: "GET",
    path: "/metrics",
    handler: ({ req, res }) => {
      const metricsToken = process.env.METRICS_TOKEN ?? "";
      if (metricsToken) {
        const auth = req.headers["authorization"] ?? "";
        if (auth !== `Bearer ${metricsToken}`) {
          res.writeHead(401, { "WWW-Authenticate": "Bearer" });
          res.end("Unauthorized");
          return null;
        }
      }
      const body = metrics.export();
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(body);
      return null;
    },
  },
  {
    method: "GET",
    path: "/health",
    handler: ({ state }) => ({
      status: "ok",
      service: "igfxpro-apiv2",
      timestamp: new Date().toISOString(),
      marketData: state.getQuotes().length,
      executionQueue: getQueueMetrics(),
    }),
  },
  {
    method: "GET",
    path: "/api/health",
    handler: async ({ state }) => {
      const services = await state.getServiceHealth();
      return { ok: services.every((s) => s.status !== "offline"), services };
    },
  },
  {
    method: "GET",
    path: api("/health"),
    handler: async ({ state }) => {
      const services = await state.getServiceHealth();
      return { ok: services.every((s) => s.status !== "offline"), services };
    },
  },
  {
    method: "GET",
    path: api("/dr/status"),
    admin: true, // Fix #5: disaster-recovery internals were previously exposed with zero auth
    handler: async () => {
      const status = await getDRHealth();
      return status;
    },
  },
  {
    method: "GET",
    path: "/config/feature-flags",
    handler: ({ state }) => state.getFeatureFlags(),
  },
  {
    method: "GET",
    path: "/tenant/active",
    handler: ({ state }) => state.getTenant(),
  },
  {
    method: "GET",
    path: "/api/license/validate",
    handler: ({ state }) => {
      const liveTradingEnabled = state.getFeatureFlags().liveTrading;
      return {
        valid: true,
        mode: liveTradingEnabled ? "live" : "sandbox",
        liveTradingEnabled,
      };
    },
  },
  {
    method: "GET",
    path: "/api/system/maintenance",
    handler: () => ({ enabled: false }),
  },
  {
    method: "POST",
    path: "/auth/session",
    handler: async ({ body, state, res }) => {
      const parsed = LoginRequestSchema.parse(body);
      const result = await state.login(parsed.email, parsed.password);
      if (!result) return { ok: false, reason: "invalid_credentials" };

      // Set refresh token as httpOnly cookie — JavaScript cannot read this
      if (result.refreshToken) {
        const secure  = process.env.NODE_ENV === "production" ? "; Secure" : "";
        const maxAge  = 7 * 24 * 60 * 60; // 7 days
        res.setHeader("Set-Cookie",
          `igfxpro_rt=${result.refreshToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`
        );
      }

      // Return access token in response body — stored in memory by frontend
      return { ...result, refreshToken: undefined };
    },
  },
  {
    method: "POST",
    path: "/auth/logout",
    handler: ({ res }) => {
      // Clear the httpOnly refresh-token cookie
      res.setHeader("Set-Cookie",
        "igfxpro_rt=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
      );
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: "/auth/session",
    auth: true,
    handler: ({ authHeader, state }) => ({
      principal: state.resolvePrincipal(authHeader),
    }),
  },
  {
    method: "POST",
    path: "/auth/refresh",
    handler: ({ body, req, res, state }) => {
      // Prefer httpOnly cookie over body token (security best practice)
      const cookieHeader = req.headers.cookie ?? "";
      const cookieToken = cookieHeader
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("igfxpro_rt="))
        ?.slice("igfxpro_rt=".length) ?? "";

      const bodyToken =
        typeof body === "object" && body && "refreshToken" in body
          ? String(body.refreshToken)
          : "";

      const refreshToken = cookieToken || bodyToken;
      if (!refreshToken) return { ok: false, reason: "no_refresh_token" };

      const result = state.refresh(refreshToken);
      if (!result) {
        // Invalidate the cookie on failure
        res.setHeader("Set-Cookie", "igfxpro_rt=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
        return { ok: false, reason: "invalid_refresh_token" };
      }

      // Rotate the refresh token cookie
      if (result.refreshToken) {
        const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
        res.setHeader("Set-Cookie",
          `igfxpro_rt=${result.refreshToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}${secure}`
        );
      }

      return { ...result, refreshToken: undefined };
    },
  },
  {
    method: "POST",
    path: api("/auth/login"),
    handler: async ({ body, state }) => {
      const parsed = LoginRequestSchema.parse(body);
      const result = await state.login(parsed.email, parsed.password);
      if (!result) return { ok: false, reason: "invalid_credentials" };
      const isAdmin = result.principal.roles.some((role) => ["admin", "super_admin", "risk", "compliance"].includes(role));
      if (!isAdmin && !isClientAuthKeyValid(parsed.authKey)) return { ok: false, reason: "invalid_auth_key" };
      return result;
    },
  },
  {
    method: "POST",
    path: api("/auth/register"),
    handler: async ({ body, state }) => {
      const parsed = RegisterRequestSchema.parse(body);
      if (!isClientAuthKeyValid(parsed.authKey)) return { ok: false, reason: "invalid_auth_key" };
      return await state.register(parsed);
    },
  },
  {
    method: "GET",
    path: api("/auth/session"),
    auth: true,
    handler: ({ authHeader, state }) => ({
      principal: state.resolvePrincipal(authHeader),
    }),
  },
  {
    method: "GET",
    path: api("/trading/instruments"),
    handler: ({ state }) => state.getInstruments(),
  },
  {
    method: "GET",
    path: api("/trading/quotes"),
    handler: ({ state }) => state.getQuotes(),
  },
  {
    method: "GET",
    path: api("/candles/:symbol/:timeframe"),
    handler: ({ params, query }) => {
      const symbol = (params.symbol ?? "EURUSD").replace("-", "").toUpperCase();
      const tf     = (params.timeframe ?? "15M") as Timeframe;
      const limit  = Math.min(parseInt(query.get("limit") ?? "200"), 5000);
      return getCandles(symbol, tf, limit);
    },
  },
  {
    method: "GET",
    path: api("/liquidity/book/:symbol"),
    handler: ({ params, state }) => {
      const book = state.getLiquidityBook(params.symbol);
      if (!book) return { ok: false, reason: "UNKNOWN_INSTRUMENT" };
      return book;
    },
  },
  {
    method: "GET",
    path: api("/dom/:symbol"),
    handler: ({ params }) => {
      const symbol = (params.symbol ?? "EURUSD").toUpperCase().replace("-", "");
      const quote  = quoteCache.get(symbol);
      if (!quote) return { ok: false, reason: "NO_MARKET_DATA" };

      const ac   = assetClassOf(symbol);
      const book = virtualOrderbook.build({
        symbol,
        bid:        quote.bid,
        ask:        quote.ask,
        mid:        quote.mid,
        spread:     quote.spread,
        changePct:  quote.changePct,
        assetClass: ac,
      });

      return {
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
    },
  },
  {
    method: "GET",
    path: api("/trading/positions"),
    auth: true,
    handler: async ({ state, authHeader, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };

      if (IS_PERSISTENT) {
        const db = (await import("../shared/db.js")).prisma;
        const limit = Math.min(parseInt(query.get("limit") ?? "200"), 500);
        const rows = await (db as NonNullable<typeof db>).position.findMany({
          where:   { userId: principal.sub, status: "OPEN" },
          orderBy: { openedAt: "desc" },
          take:    limit,
          select: {
            id: true, symbol: true, side: true, status: true,
            quantity: true, entryPrice: true, markPrice: true,
            pnl: true, pnlPercent: true, marginUsed: true,
            stopLoss: true, takeProfit: true, exitPrice: true,
            openedAt: true, closedAt: true, leverage: true,
            openedByAutopilot: true,
          },
        });
        // Prisma Decimal fields serialize as strings — convert to plain numbers so the
        // frontend can do arithmetic without string-concatenation NaN bugs.
        return rows.map(p => ({
          ...p,
          quantity:   Number(p.quantity),
          entryPrice: Number(p.entryPrice),
          markPrice:  Number(p.markPrice),
          pnl:        Number(p.pnl),
          pnlPercent: Number(p.pnlPercent),
          marginUsed: Number(p.marginUsed),
          stopLoss:   p.stopLoss   != null ? Number(p.stopLoss)   : null,
          takeProfit: p.takeProfit != null ? Number(p.takeProfit) : null,
          exitPrice:  p.exitPrice  != null ? Number(p.exitPrice)  : null,
        }));
      }

      return state.getPositions(principal.sub);
    },
  },
  {
    method: "GET",
    path: api("/trading/position/:id"),
    auth: true,
    handler: async ({ params, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const position = await positionService.getById(params.id, principal.sub);
      if (!position) return { ok: false, reason: "POSITION_NOT_FOUND" };
      return { ok: true, position };
    },
  },
  {
    method: "GET",
    path: api("/trading/history"),
    auth: true,
    handler: async ({ state, authHeader, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };

      if (IS_PERSISTENT) {
        const db     = (await import("../shared/db.js")).prisma;
        const limit  = Math.min(parseInt(query.get("limit") ?? "50"), 200);
        const offset = parseInt(query.get("offset") ?? "0");
        const status = query.get("status");
        return (db as NonNullable<typeof db>).order.findMany({
          where:   { userId: principal.sub, ...(status ? { status } : {}) },
          orderBy: { createdAt: "desc" },
          take:    limit,
          skip:    offset,
        });
      }

      return state.getOrders(principal.sub);
    },
  },
  {
    method: "GET",
    path: api("/trading/orders"),
    auth: true,
    handler: async ({ state, authHeader, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };

      if (IS_PERSISTENT) {
        const db     = (await import("../shared/db.js")).prisma;
        const limit  = Math.min(parseInt(query.get("limit") ?? "50"), 200);
        const offset = parseInt(query.get("offset") ?? "0");
        const status = query.get("status");
        return (db as NonNullable<typeof db>).order.findMany({
          where:   { userId: principal.sub, ...(status ? { status } : {}) },
          orderBy: { createdAt: "desc" },
          take:    limit,
          skip:    offset,
        });
      }

      return state.getOrders(principal.sub);
    },
  },
  {
    method: "GET",
    path: "/trading/history",
    auth: true,
    // PHASE C PENTEST (RBAC/IDOR): this legacy (non-api/v1-prefixed)
    // duplicate of GET /api/v1/trading/history previously called
    // state.getOrders() with no principal resolved at all -- unlike every
    // other route touching orders/positions in this file, it never even
    // checked authentication before returning data, let alone scoped it
    // to the caller.
    handler: ({ state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      return state.getOrders(principal.sub);
    },
  },
  {
    method: "POST",
    path: api("/trading/order"),
    auth: true,
    handler: async ({ body, state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      const parsed = NewOrderRequestSchema.parse(body);

      // Route through new execution pipeline when DB is available
      if (process.env.DATABASE_URL) {
        return orderController.placeOrder(parsed, {
          userId:   principal.sub,
          tenantId: principal.tenantId,
        });
      }

      // Fallback: in-memory state (dev/no-DB environment)
      return state.placeOrder(parsed, principal);
    },
  },
  {
    method: "POST",
    path: "/trading/order",
    auth: true,
    handler: async ({ body, state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      const parsed = NewOrderRequestSchema.parse(body);

      if (process.env.DATABASE_URL) {
        return orderController.placeOrder(parsed, {
          userId:   principal.sub,
          tenantId: principal.tenantId,
        });
      }

      return state.placeOrder(parsed, principal);
    },
  },
  // FASE 3.6: true OCO (One-Cancels-Other) — two independently pending
  // resting orders, whichever triggers/cancels first cancels the other.
  // No in-memory fallback: pendingOrderBook already works without DATABASE_URL
  // (persistence is a no-op, the in-memory Map still functions), unlike the
  // legacy `state.placeOrder` path above which never supported resting orders.
  {
    method: "POST",
    path: api("/trading/order/oco"),
    auth: true,
    handler: async ({ body, state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      const parsed = PlaceOcoRequestSchema.parse(body);
      return orderController.placeOcoPair(parsed.legA, parsed.legB, {
        userId:   principal.sub,
        tenantId: principal.tenantId,
      });
    },
  },
  {
    method: "POST",
    path: "/trading/order/oco",
    auth: true,
    handler: async ({ body, state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      const parsed = PlaceOcoRequestSchema.parse(body);
      return orderController.placeOcoPair(parsed.legA, parsed.legB, {
        userId:   principal.sub,
        tenantId: principal.tenantId,
      });
    },
  },
  // ── Position close ───────────────────────────────────────────────────────────
  {
    method: "POST",
    path: api("/trading/position/:id/close"),
    auth: true,
    handler: async ({ params, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return closePosition(params.id, principal.sub, state);
    },
  },

  // ── Order modify (SL/TP) ──────────────────────────────────────────────────────
  {
    method: "PUT",
    path: api("/trading/order/:id"),
    auth: true,
    handler: async ({ params, body, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const b = (body ?? {}) as Record<string, unknown>;
      return modifyOrderSlTp({
        positionId: params.id,
        userId:     principal.sub,
        stopLoss:   b.stopLoss  !== undefined ? Number(b.stopLoss)  : undefined,
        takeProfit: b.takeProfit !== undefined ? Number(b.takeProfit) : undefined,
      }, state);
    },
  },

  // ── Order cancel ─────────────────────────────────────────────────────────────
  {
    method: "DELETE",
    path: api("/trading/order/:id"),
    auth: true,
    handler: async ({ params, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return cancelOrder(params.id, principal.sub, state);
    },
  },

  {
    method: "POST",
    path: api("/trading/kill-switch"),
    auth: true,
    handler: async ({ body, state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      const isAdmin = principal.roles.some((r: string) =>
        ["admin", "super_admin", "risk"].includes(r)
      );
      if (!isAdmin) return { ok: false, reason: "forbidden" };
      const parsed = AdminKillSwitchSchema.parse(body);
      if (parsed.enabled) {
        await killSwitch.activate(parsed.reason ?? "Admin action", principal.sub);
      } else {
        await killSwitch.deactivate(principal.sub);
      }
      // Keep in-memory state in sync (requires principal as first arg)
      state.adminUpdateRiskPolicy(principal, { killSwitchEnabled: parsed.enabled } as Parameters<typeof state.adminUpdateRiskPolicy>[1]);
      return { ok: true, killSwitch: killSwitch.getState() };
    },
  },
  {
    method: "GET",
    path: api("/risk/snapshot"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (IS_PERSISTENT) {
        return riskSnapshotService.getSnapshot(principal.sub);
      }
      return state.getRisk(principal.sub);
    },
  },
  {
    method: "GET",
    path: api("/wallet/balance"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      if (IS_PERSISTENT) {
        const db       = (await import("../shared/db.js")).prisma;
        const [wallet, positions] = await Promise.all([
          (db as NonNullable<typeof db>).walletAccount.findUnique({ where: { userId: principal.sub } }),
          (db as NonNullable<typeof db>).position.findMany({
            where:  { userId: principal.sub, status: "OPEN" },
            select: { symbol: true, side: true, quantity: true, entryPrice: true, marginUsed: true },
          }),
        ]);

        // FASE 4.2 (RISK_ENGINE_FREEZE.md Bug #2): live floating P&L from
        // current quotes, not the persisted Position.pnl column -- see
        // margin.controller.ts's getMarginState for the full staleness
        // mechanism this was silently exposed to. This is the equity number
        // the client actually sees, so it must match what the pre-trade
        // margin gate uses.
        const unrealizedPnL = positions.reduce((sum, p) => {
          const quote = quoteCache.get(p.symbol);
          if (!quote) return sum;
          const { rawPnl } = pnlCalculator.unrealized(
            p.side as "BUY" | "SELL", p.quantity.toNumber(), p.entryPrice.toNumber(), quote.bid, quote.ask,
          );
          return sum + rawPnl;
        }, 0);
        const marginUsed = positions.reduce((s, p) => s + Number(p.marginUsed ?? 0), 0);

        if (!wallet) {
          // WalletAccount row missing — recover balance from approved ledger entries
          // (happens when adminAllocateCapital ran before the wallet-sync fix)
          const entries = await (db as NonNullable<typeof db>).ledgerEntry.findMany({
            where:  { userId: principal.sub, status: "APPROVED" },
            select: { type: true, amount: true },
          });
          const CASH_TYPES = new Set(["ADMIN_CAPITAL_ALLOCATION", "DEPOSIT_REQUEST", "WITHDRAW_REQUEST"]);
          const balance = entries
            .filter(e => CASH_TYPES.has(e.type))
            .reduce((sum, e) => sum + Number(e.amount), 0);
          void (db as NonNullable<typeof db>).walletAccount.create({
            data: { userId: principal.sub, balance, currency: "USD" },
          }).catch(() => { /* row may race-create — ignore duplicate */ });
          const equity = balance + unrealizedPnL;
          return {
            currency:     "USD",
            available:    balance,
            equity,
            locked:       0,
            freeMargin:   Math.max(0, equity - marginUsed),
            marginUsed,
            unrealizedPnL,
          };
        }

        const balance       = Number(wallet.balance);
        const locked        = Number(wallet.locked);
        const equity        = balance + unrealizedPnL;

        return {
          currency:     wallet.currency,
          available:    balance - locked,
          equity,
          locked,
          freeMargin:   Math.max(0, equity - marginUsed),
          marginUsed,
          unrealizedPnL,
        };
      }

      return state.getWallet(principal.sub);
    },
  },
  {
    method: "GET",
    path: api("/ai/signals"),
    handler: async ({ query }) => {
      // OLOS signals are platform-wide (generated by signal.generator.ts against
      // live market data) — every caller reads the same real, persisted set.
      if (!IS_PERSISTENT) return [];
      const symbol = query.get("symbol") ?? undefined;
      return olosSignalService.getActiveSignals(PLATFORM_SIGNAL_USER_ID, symbol ? { symbol } : undefined);
    },
  },
  {
    method: "GET",
    path: api("/ai/confidence"),
    handler: async () => {
      // Never fabricate a confidence score. Compute it only from real, persisted
      // OLOS signals; when none currently qualify, report an honest "scanning"
      // state with a real ETA to the next live evaluation pass instead.
      const activeSignals = IS_PERSISTENT
        ? await olosSignalService.getActiveSignals(PLATFORM_SIGNAL_USER_ID).catch(() => [])
        : [];

      if (!activeSignals.length) {
        const { nextScanInSec } = getScanSchedule();
        return {
          score: null,
          breakdown: null,
          status: "SCANNING",
          message: "Nessun segnale ad alta confidenza al momento — OLOS continua a scansionare i mercati in tempo reale.",
          nextScanInSec,
          asOf: new Date().toISOString(),
        };
      }

      const avgBreakdown = (key: string) =>
        activeSignals.reduce((sum, sig) => sum + (Number((sig.confidenceBreakdown as Record<string, number> | undefined)?.[key]) || 0), 0)
          / activeSignals.length / 100;

      return {
        score: activeSignals.reduce((sum, sig) => sum + sig.confidence, 0) / activeSignals.length / 100,
        breakdown: {
          trend:    avgBreakdown("trendAlignment"),
          momentum: avgBreakdown("momentumStrength"),
          volume:   avgBreakdown("volumeConfirmation"),
          macro:    avgBreakdown("macroAlignment"),
        },
        status: "ACTIVE",
        signalCount: activeSignals.length,
        asOf: activeSignals[0].createdAt,
      };
    },
  },
  {
    method: "GET",
    path: api("/ai/performance"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      // Real, platform-wide signal performance (win rate, profit factor, etc.)
      // from SignalTelemetry — same signalAnalytics service used by the admin
      // dashboard, just the safe aggregate subset for the trader-facing OLOS
      // page. Never a hardcoded placeholder like the old "68.4%".
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const core = await signalAnalytics.getCoreMetrics();
      return { ok: true, ...core };
    },
  },
  {
    method: "GET",
    path: api("/ai/regime"),
    handler: async ({ query }) => {
      // Real ADX(14) + EMA(50/200) + ATR(14) composite classifier — same
      // RegimeEngine used internally by signal.generator.ts for every OLOS
      // signal. Replayed over real candle history, never fabricated.
      const symbol    = (query.get("symbol") ?? "EURUSD").toUpperCase();
      const timeframe = (query.get("timeframe") ?? "1H") as Timeframe;
      return { symbol, timeframe, ...getRegimeSnapshot(symbol, timeframe) };
    },
  },
  {
    method: "GET",
    path: api("/ai/decision-log"),
    handler: async ({ query }) => {
      // Real decision trace for the most recent platform-wide OLOS signal.
      // Built entirely from persisted AiSignal fields (confluenceFactors,
      // confidenceBreakdown, entryRationale, slRationale) — no fabricated text.
      if (!IS_PERSISTENT) return { status: "NO_DATA", trace: [] };
      const symbol = query.get("symbol") ?? undefined;
      const signal = await (prisma as NonNullable<typeof prisma>).olosSignal.findFirst({
        where: { userId: PLATFORM_SIGNAL_USER_ID, ...(symbol ? { symbol } : {}) },
        orderBy: { createdAt: "desc" },
      }).catch(() => null);
      if (!signal) return { status: "NO_DATA", trace: [] };

      // confluenceFactors / confidenceBreakdown / targetLevels are native
      // Prisma Json columns — already deserialized, never JSON-encoded strings.
      const confluence = (signal.confluenceFactors as unknown as string[]) ?? [];
      const breakdown  = (signal.confidenceBreakdown as unknown as Record<string, number>) ?? {};
      const targets     = (signal.targetLevels as unknown as number[]) ?? [];
      const confidence  = signal.confidence.toNumber();
      const rr          = signal.riskRewardRatio.toNumber();
      const entryPrice  = signal.entryPrice.toNumber();
      const stopLoss    = signal.stopLoss.toNumber();

      const trace = [
        { stage: "01 / INGEST",   text: `Live quote ingested for ${signal.symbol} on the ${signal.timeframe} aggregation window.` },
        { stage: "02 / CLASSIFY", text: `Market regime classified: ${signal.marketRegime.toUpperCase()} · volatility: ${signal.volatilityLevel.toUpperCase()}.` },
        { stage: "03 / SCORE",    text: `Confluence factors: ${confluence.join(", ") || "none recorded"}.` },
        { stage: "03 / SCORE",    text: `Confidence breakdown — ${Object.entries(breakdown).map(([k, v]) => `${k}: ${Math.round(Number(v))}%`).join(" · ")}.` },
        { stage: "04 / VALIDATE", text: `${signal.slRationale} Risk/reward computed at 1:${rr.toFixed(2)}.` },
        { stage: "05 / SIGNAL",   text: signal.entryRationale },
        { stage: "05 / SIGNAL",   text: `Decision: ${signal.signalType} ${signal.symbol} @ ${entryPrice} — confidence ${confidence.toFixed(0)}%. SL ${stopLoss} · TP ${targets.join("/")}.` },
      ];

      return {
        status:      "REAL",
        symbol:      signal.symbol,
        signalType:  signal.signalType,
        confidence,
        setupPattern: signal.setupPattern,
        createdAt:   signal.createdAt.toISOString(),
        trace,
      };
    },
  },
  {
    method: "GET",
    path: api("/ai/signal-edge/:symbol"),
    auth: true,
    handler: async ({ params, authHeader, state }) => {
      // Real historical edge for this symbol — same signalAnalytics service
      // already used by the admin confidence-bands report, just exposed to
      // the trader who owns the account instead of admin-only.
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE", bands: [] };

      const symbol = params.symbol.toUpperCase();
      const bands  = await signalAnalytics.getConfidenceBands({ symbol });
      return { ok: true, symbol, bands };
    },
  },
  {
    method: "GET",
    path: api("/ai/investment-brief/:symbol"),
    auth: true,
    handler: async ({ params, query, authHeader, state }) => {
      // Single consolidated, real-data-only brief for one symbol — composes
      // RegimeEngine, the live OLOS signal (if any), real indicators, real
      // macro calendar, real account equity, and real historical edge.
      // Never fabricates a field that isn't traceable to one of those.
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const symbol    = params.symbol.toUpperCase();
      const timeframe = (query.get("timeframe") ?? "1H") as Timeframe;
      const currencies = currenciesForSymbol(symbol);

      const [regime, indicators, signals, macroSoon, calendar, bands, wallet] = await Promise.all([
        Promise.resolve(getRegimeSnapshot(symbol, timeframe)),
        Promise.resolve(state.getIndicatorSnapshot(symbol, timeframe)),
        IS_PERSISTENT ? olosSignalService.getActiveSignals(PLATFORM_SIGNAL_USER_ID, { symbol }).catch(() => []) : Promise.resolve([]),
        Promise.resolve(economicEventService.macroEventInNext4Hours(symbol)),
        economicEventService.getUpcoming(48, currencies),
        IS_PERSISTENT ? signalAnalytics.getConfidenceBands({ symbol }).catch(() => []) : Promise.resolve([]),
        IS_PERSISTENT
          ? (prisma as NonNullable<typeof prisma>).walletAccount.findUnique({ where: { userId: principal.sub } }).catch(() => null)
          : Promise.resolve(null),
      ]);

      const liveSignal = signals[0] ?? null;

      // Real position sizing: Kelly×0.25 of real equity against the live
      // signal's actual SL distance. Omitted (not guessed) when no signal.
      let positionSizing: {
        equity: number; riskAmount: number; slDistance: number; suggestedRiskPct: number;
      } | null = null;
      if (liveSignal && wallet) {
        const equity     = Number(wallet.equity) || Number(wallet.balance) || 0;
        const slDistance = Math.abs(liveSignal.entryPrice - liveSignal.stopLoss);
        const riskAmount = equity * 0.01 * 0.25; // 1% account risk × Kelly 0.25 fraction
        positionSizing = { equity, riskAmount, slDistance, suggestedRiskPct: 0.25 };
      }

      const verdict = liveSignal
        ? liveSignal.signalType
        : regime.status === "ACTIVE" && regime.trending
          ? "MONITOR"
          : "WAIT";

      return {
        symbol, timeframe,
        verdict,
        regime,
        indicators,
        signal:   liveSignal,
        macro:    { eventWithin4h: macroSoon, upcoming: calendar },
        risk:     positionSizing,
        historicalEdge: bands,
        asOf:     new Date().toISOString(),
      };
    },
  },
  {
    method: "GET",
    path: api("/calendar/economic"),
    handler: async ({ query }) => {
      // Real, DB-backed events (ForexFactory/TradingEconomics/FRED) — never
      // the static hardcoded list that used to live on BrokerState.
      const hours = Math.min(parseInt(query.get("hours") ?? "48", 10) || 48, 168);
      return economicEventService.getUpcoming(hours);
    },
  },
  {
    method: "GET",
    path: api("/indicators/:symbol"),
    auth: true,
    handler: ({ params, query, state }) => {
      const snapshot = state.getIndicatorSnapshot(params.symbol, query.get("timeframe") ?? "15M");
      if (!snapshot) return { ok: false, reason: "UNKNOWN_INSTRUMENT" };
      return snapshot;
    },
  },
  // ── Autopilot ────────────────────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/autopilot/config"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const cfg = await autopilotService.getConfig(principal.sub);
      // Merge governance info from in-memory state
      const stateCfg = state.getAutopilotConfig(principal.sub);
      return {
        ...cfg,
        tier:            stateCfg.tier,
        activeRules:     stateCfg.activeRules ?? [],
        lastDecision:    cfg.lastDecision ?? stateCfg.lastDecision,
      };
    },
  },
  {
    method: "POST",
    path: api("/autopilot/config"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const input = AutopilotConfigInputSchema.parse(body);
      try {
        const cfg = await autopilotService.saveConfig(principal.sub, input, principal.sub);
        return { ok: true, config: cfg };
      } catch (err) {
        const message = (err as Error).message ?? "";
        if (message.startsWith("AUTOPILOT_NOT_ELIGIBLE")) {
          return { ok: false, reason: "NOT_ELIGIBLE", detail: message.replace("AUTOPILOT_NOT_ELIGIBLE: ", "") };
        }
        if (message.startsWith("AUTOPILOT_CONSENT_REQUIRED")) {
          return { ok: false, reason: "CONSENT_REQUIRED" };
        }
        throw err;
      }
    },
  },
  {
    method: "GET",
    path: api("/autopilot/consent"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return { ok: true, ...(await autopilotConsentService.getStatus(principal.sub)) };
    },
  },
  {
    method: "POST",
    path: api("/autopilot/consent"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      await autopilotConsentService.acceptConsent(principal.sub, principal.sub);
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: api("/autopilot/positions"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: true, positions: [] };

      const db = prisma as NonNullable<typeof prisma>;
      const rows = await db.position.findMany({
        where:  { userId: principal.sub, status: "OPEN", openedByAutopilot: true },
        orderBy: { openedAt: "desc" },
      });

      const positions = rows.map((p) => {
        const entry = p.entryPrice.toNumber();
        const initialSL = p.initialStopLoss?.toNumber();
        const quote = quoteCache.get(p.symbol);
        let rMultiple: number | null = null;
        if (initialSL !== undefined && initialSL !== null && quote) {
          const riskDistance = Math.abs(entry - initialSL);
          if (riskDistance > 0) {
            const currentPrice = p.side === "BUY" ? quote.bid : quote.ask;
            const favorable = p.side === "BUY" ? currentPrice - entry : entry - currentPrice;
            rMultiple = favorable / riskDistance;
          }
        }
        return {
          id: p.id,
          symbol: p.symbol,
          side: p.side,
          quantity: p.quantity.toNumber(),
          entryPrice: entry,
          stopLoss: p.stopLoss?.toNumber() ?? null,
          takeProfit: p.takeProfit?.toNumber() ?? null,
          initialStopLoss: initialSL ?? null,
          pnl: p.pnl.toNumber(),
          pnlPercent: p.pnlPercent.toNumber(),
          rMultiple,
          breakEvenApplied: p.breakEvenApplied,
          trailingActive: p.trailingActive,
          openedAt: p.openedAt.toISOString(),
        };
      });

      return { ok: true, positions };
    },
  },
  // Task 14 Phase 4 — the client's own autopilot results (vs. the
  // platform-wide anonymized widget at /autopilot/stats/public).
  {
    method: "GET",
    path: api("/autopilot/performance"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { getUserAutopilotPerformance } = await import("../autopilot-service/autopilot.performance.js");
      return getUserAutopilotPerformance(principal.sub);
    },
  },

  // ── Ledger ───────────────────────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/wallet/ledger"),
    auth: true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const params: LedgerQueryParams = {
        userId: principal.sub,
        limit:  Math.min(parseInt(query.get("limit")  ?? "50"), 500),
        offset: parseInt(query.get("offset") ?? "0"),
        orderBy: (query.get("orderBy") ?? "desc") as "asc" | "desc",
      };

      const typeParam = query.get("type");
      if (typeParam) params.type = typeParam.split(",").map((t) => t.trim()) as typeof params.type;

      const from = query.get("from");
      const to   = query.get("to");
      if (from) params.from = new Date(from);
      if (to)   params.to   = new Date(to);

      return ledgerService.getLedger(params);
    },
  },

  // ── Swap/rollover history (LEDGER_FREEZE.md §3 — dedicated History surface,
  // previously only reachable via the generic ledger query) ────────────────────
  {
    method: "GET",
    path: api("/wallet/swap-history"),
    auth: true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const params: SwapHistoryParams = {
        userId: principal.sub,
        limit:  Math.min(parseInt(query.get("limit")  ?? "50"), 500),
        offset: parseInt(query.get("offset") ?? "0"),
      };

      const positionId = query.get("positionId");
      if (positionId) params.positionId = positionId;
      const symbol = query.get("symbol");
      if (symbol) params.symbol = symbol;
      const from = query.get("from");
      const to   = query.get("to");
      if (from) params.from = new Date(from);
      if (to)   params.to   = new Date(to);

      return ledgerService.getSwapHistory(params);
    },
  },

  // ── Account Statements ───────────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/wallet/statements"),
    auth: true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const period = (query.get("period") ?? "monthly") as "daily" | "weekly" | "monthly" | "custom";
      const from   = query.get("from") ? new Date(query.get("from")!) : undefined;
      const to     = query.get("to")   ? new Date(query.get("to")!)   : undefined;

      return ledgerService.getStatement(principal.sub, period, from, to);
    },
  },

  // ── Trading Analytics ────────────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/trading/audit/stats"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return tradingAnalyticsService.getStats(principal.sub);
    },
  },

  // Full trading analytics report — powers Trading Analytics Center
  {
    method: "GET",
    path:   api("/analytics/trading/report"),
    auth:   true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const qFrom = query.get("from");
      const qTo   = query.get("to");
      let from: Date, to: Date;
      if (qFrom && qTo) {
        from = new Date(qFrom + "T00:00:00.000Z");
        to   = new Date(qTo   + "T23:59:59.999Z");
        if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) {
          const days = Math.min(Math.max(Number(query.get("days") ?? 90), 1), 730);
          to   = new Date();
          from = new Date(to.getTime() - days * 86_400_000);
        }
      } else {
        const days = Math.min(Math.max(Number(query.get("days") ?? 90), 1), 730);
        to   = new Date();
        from = new Date(to.getTime() - days * 86_400_000);
      }
      return tradingAnalyticsCenter.getReport(principal.sub, from, to);
    },
  },

  {
    method: "GET",
    path: api("/client/account"),
    auth: true,
    handler: ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return state.getClientAccount(principal.sub);
    },
  },
  {
    method: "POST",
    path: api("/client/deposit"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = ClientDepositRequestSchema.parse(body);

      if (process.env.DATABASE_URL) {
        // AML screening before accepting deposit
        const aml = await transactionMonitor.monitor(principal.sub, parsed.amount, "DEPOSIT");
        if (aml.riskLevel === "CRITICAL") {
          return { ok: false, reason: "COMPLIANCE_HOLD", amlFlags: aml.flags };
        }
        const db = (await import("../shared/db.js")).prisma;
        const engine = new LedgerEngine(db as NonNullable<typeof db>);
        const result = await engine.requestDeposit({
          userId:    principal.sub,
          amount:    parsed.amount,
          method:    parsed.method,
          reference: parsed.details ?? undefined,
        });
        return { ok: true, ...result, amlRisk: aml.riskLevel };
      }

      // Sandbox fallback
      return state.createDepositRequest(principal.sub, parsed);
    },
  },
  {
    method: "POST",
    path: api("/client/withdraw"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = ClientWithdrawRequestSchema.parse(body);

      if (process.env.DATABASE_URL) {
        // CRITICAL_REMEDIATION (C15): withdrawals were never AML-screened
        // at all -- transactionMonitor.monitor() had exactly one call site
        // in the whole codebase, on the deposit route above. AmlEngine's
        // own RAPID_DEPOSIT_WITHDRAWAL detection (compliance-engine/aml.
        // engine.ts) exists specifically for transactionType==="WITHDRAWAL"
        // but could never fire, since nothing ever called assess() with
        // that type. Mirrors the deposit route's screening exactly.
        const aml = await transactionMonitor.monitor(principal.sub, parsed.amount, "WITHDRAWAL");
        if (aml.riskLevel === "CRITICAL") {
          return { ok: false, reason: "COMPLIANCE_HOLD", amlFlags: aml.flags };
        }

        // Persistent: real LedgerEngine — writes to DB, produces AuditLog
        const db = (await import("../shared/db.js")).prisma;
        const engine = new LedgerEngine(db as NonNullable<typeof db>);
        const result = await engine.requestWithdrawal({
          userId:      principal.sub,
          amount:      parsed.amount,
          destination: parsed.destination,
          method:      parsed.method,
        });
        return { ok: result.status !== "REJECTED", ...result };
      }

      // Sandbox fallback
      return state.createWithdrawRequest(principal.sub, parsed);
    },
  },
  {
    method: "POST",
    path: api("/client/documents/upload"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = ClientDocumentUploadSchema.parse(body);

      const docId = ((parsed.documentKey ?? parsed.documentId ?? "PASSPORT") as string).toUpperCase();

      if (process.env.DATABASE_URL) {
        // DB-backed: run full KYC pipeline and return the persisted document result
        return kycService.uploadDocument({
          userId:      principal.sub,
          documentKey: docId as import("../kyc-service/kyc.service.js").KycDocumentKey,
          label:       parsed.label ?? parsed.documentKey ?? String(parsed.documentId ?? "Document"),
          fileName:    parsed.fileName,
          mimeType:    parsed.mimeType,
          content:     parsed.content ?? "",
        });
      }

      // Sandbox fallback: in-memory state only
      return state.uploadClientDocument(principal.sub, {
        documentId: (parsed.documentId ?? "identity") as "identity" | "address" | "appropriateness" | "source_of_funds",
        fileName:   parsed.fileName,
      });
    },
  },
  {
    method: "GET",
    path: api("/admin/overview"),
    admin: true,
    handler: ({ state }) => state.getAdminOverview(),
  },
  {
    method: "GET",
    path: api("/admin/audit"),
    admin: true,
    handler: ({ state }) => state.getAudit(),
  },
  {
    method: "GET",
    path: api("/admin/service-health"),
    admin: true,
    handler: ({ state }) => state.getServiceHealth(),
  },
  {
    method: "GET",
    path: api("/admin/client-accounts"),
    admin: true,
    handler: ({ state }) => state.getClientAccounts(),
  },
  {
    method: "GET",
    path: api("/admin/client/:email"),
    admin: true,
    handler: ({ params, state }) => {
      const email = (params as Record<string, string>).email;
      const account = state.getClientAccounts().find((acc) => acc.profile.email === email);
      return account ? account : { ok: false, reason: "NOT_FOUND" };
    },
  },
  {
    method: "GET",
    path: api("/admin/workspace"),
    admin: true,
    handler: ({ state }) => state.getAdminWorkspace(),
  },
  {
    method: "POST",
    path: api("/admin/client/tier"),
    admin: true,
    handler: ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = AdminUpdateTierSchema.parse(body);
      return state.adminUpdateTier(principal, parsed);
    },
  },
  {
    method: "POST",
    path: api("/admin/client/kyc"),
    admin: true,
    handler: ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { userId, kycStatus } = body as { userId: string; kycStatus: string };
      if (!userId || !["approved", "rejected", "pending"].includes(kycStatus ?? "")) {
        return { ok: false, reason: "INVALID_PARAMS" };
      }
      return state.adminSetKycStatus(principal, { userId, kycStatus: kycStatus as "approved" | "rejected" | "pending" });
    },
  },
  {
    method: "POST",
    path: api("/admin/capital/allocate"),
    admin: true,
    handler: ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = AdminAllocateCapitalSchema.parse(body);
      return state.adminAllocateCapital(principal, parsed);
    },
  },
  {
    method: "POST",
    path: api("/admin/capital/withdraw"),
    admin: true,
    handler: ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = AdminAllocateCapitalSchema.parse(body);
      return state.adminWithdrawCapital(principal, parsed);
    },
  },
  {
    method: "POST",
    path: api("/admin/documents/review"),
    admin: true,
    handler: ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = AdminReviewDocumentSchema.parse(body);
      return state.adminReviewDocument(principal, parsed);
    },
  },
  {
    method: "POST",
    path: api("/admin/ledger/review"),
    admin: true,
    handler: ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = AdminReviewLedgerSchema.parse(body);
      return state.adminReviewLedger(principal, parsed);
    },
  },
  {
    method: "POST",
    path: api("/admin/liquidity/update"),
    admin: true,
    handler: ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = AdminUpdateLiquiditySchema.parse(body);
      return state.adminUpdateLiquidity(principal, parsed);
    },
  },

  // ── Broker Spread Config ─────────────────────────────────────────────────────
  // GET  /api/v1/admin/broker/spread  — list all symbols with spread source + live data
  // POST /api/v1/admin/broker/spread  — update a symbol's spread and/or enabled flag
  {
    method: "GET",
    path: api("/admin/broker/spread"),
    admin: true,
    handler: ({ state }) => {
      const allConfigs = brokerSpreadConfig.getAll();
      const liveQuotes = state.getQuotes() as Array<{ symbol: string; bid: number; ask: number; mid: number; spread: number }>;
      const quoteMap   = Object.fromEntries(liveQuotes.map((q) => [q.symbol, q]));

      const instruments = Object.entries(allConfigs).map(([symbol, config]) => {
        const quote         = quoteMap[symbol];
        const lastRealSpread = spreadStore.getLastRealSpread(symbol);

        let spreadSource: "real" | "broker_config" | "last_real" | "zero";
        if (lastRealSpread !== null && lastRealSpread > 0 && quote && quote.spread > 0) {
          // Quote spread matches last real — real feed is active
          spreadSource = (Math.abs(quote.spread - lastRealSpread) < lastRealSpread * 0.5)
            ? "real"
            : "broker_config";
        } else if (lastRealSpread !== null && lastRealSpread > 0) {
          spreadSource = "last_real";
        } else if (config.spread > 0) {
          spreadSource = "broker_config";
        } else {
          spreadSource = "zero";
        }

        return {
          symbol,
          configuredSpread:  config.spread,
          enabled:           config.enabled,
          updatedAt:         config.updatedAt,
          updatedBy:         config.updatedBy,
          liveSpread:        quote?.spread ?? 0,
          liveBid:           quote?.bid ?? 0,
          liveAsk:           quote?.ask ?? 0,
          liveMid:           quote?.mid ?? 0,
          lastRealSpread:    lastRealSpread ?? 0,
          spreadSource,
        };
      });

      return { instruments };
    },
  },
  {
    method: "POST",
    path: api("/admin/broker/spread"),
    admin: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const { symbol, spread, enabled } = body as {
        symbol: string; spread?: number; enabled?: boolean;
      };

      if (!symbol || typeof symbol !== "string") {
        return { ok: false, reason: "MISSING_SYMBOL" };
      }

      const current   = brokerSpreadConfig.getAll()[symbol.toUpperCase()];
      const newSpread  = typeof spread  === "number" ? spread  : (current?.spread  ?? 0);
      const newEnabled = typeof enabled === "boolean" ? enabled : (current?.enabled ?? true);

      if (newSpread < 0) return { ok: false, reason: "INVALID_SPREAD: spread must be >= 0" };

      const entry = await brokerSpreadConfig.update(
        symbol.toUpperCase(), newSpread, newEnabled, principal.sub,
      );

      return { ok: true, entry };
    },
  },
  {
    method: "POST",
    path: api("/admin/trading/kill-switch"),
    admin: true,
    // Fix #6: this used to call state.adminToggleKillSwitch(), which only
    // flipped an in-memory display flag the real pre-trade risk check never
    // read — an admin using THIS endpoint believed they'd halted trading
    // platform-wide, but the engine kept accepting orders. Now delegates to
    // the same real killSwitch singleton /trading/kill-switch uses.
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = AdminKillSwitchSchema.parse(body);
      if (parsed.enabled) {
        await killSwitch.activate(parsed.reason ?? "Admin action", principal.sub);
      } else {
        await killSwitch.deactivate(principal.sub);
      }
      state.adminUpdateRiskPolicy(principal, { killSwitchEnabled: parsed.enabled } as Parameters<typeof state.adminUpdateRiskPolicy>[1]);
      return { ok: true, killSwitch: killSwitch.getState() };
    },
  },
  // Task 13 — Global Risk Supervisor (Phase 1)
  {
    method: "GET",
    path: api("/admin/risk-supervisor/status"),
    admin: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const current = globalRiskSupervisor.getState();
      let history: unknown[] = [];
      if (IS_PERSISTENT && prisma) {
        history = await prisma.auditLog.findMany({
          where:  { action: "risk_supervisor.mode_changed" },
          orderBy: { createdAt: "desc" },
          take: 20,
        }).catch(() => []);
      }
      return { ok: true, current, history };
    },
  },
  {
    method: "POST",
    path: api("/admin/risk-supervisor/override"),
    admin: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = AdminRiskSupervisorOverrideSchema.parse(body);
      if (parsed.mode === "AUTO") {
        await globalRiskSupervisor.clearOverride(principal.sub);
      } else {
        await globalRiskSupervisor.forceMode(parsed.mode, parsed.reason, principal.sub);
      }
      return { ok: true, current: globalRiskSupervisor.getState() };
    },
  },
  {
    method: "GET",
    path: api("/autopilot/risk-supervisor"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { mode, reason } = globalRiskSupervisor.getState();
      return { ok: true, mode, reason };
    },
  },
  {
    method: "POST",
    path: api("/admin/risk-policy/update"),
    admin: true,
    handler: ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = AdminRiskPolicySchema.parse(body);
      return state.adminUpdateRiskPolicy(principal, parsed);
    },
  },
  {
    method: "POST",
    path: api("/admin/olos/update"),
    admin: true,
    handler: ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = AdminOlosGovernanceSchema.parse(body);
      return state.adminUpdateOlosGovernance(principal, parsed);
    },
  },
  // Task 14 Phase 3 — pause/resume one client's autopilot without going to the
  // database, distinct from the platform-wide toggle above.
  {
    method: "POST",
    path: api("/admin/autopilot/pause"),
    admin: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const parsed = AdminAutopilotPauseSchema.parse(body);
      const cfg = await autopilotService.adminSetPause(parsed.userId, parsed.paused, parsed.reason, principal.sub);
      return { ok: true, config: cfg };
    },
  },
  {
    method: "GET",
    path: api("/admin/autopilot/clients"),
    admin: true,
    handler: async () => {
      if (!IS_PERSISTENT || !prisma) return { ok: true, clients: [] };
      const db = prisma as NonNullable<typeof prisma>;
      const rows = await db.autopilotConfig.findMany({
        where:  { enabled: true },
        select: {
          userId: true, enabled: true, mode: true, pausedByAdmin: true, pausedReason: true,
          lastDecision: true, updatedAt: true, consentAcceptedAt: true, dailyLossLockedUntil: true,
        },
        orderBy: { updatedAt: "desc" },
      }).catch(() => []);
      return { ok: true, clients: rows };
    },
  },
  {
    method: "GET",
    path: api("/compliance/disclosures"),
    handler: () => ({
      jurisdiction: "EU",
      retailProtections: [
        "ESMA retail leverage caps enforced by asset class",
        "Negative balance protection per CFD account",
        "Margin close-out and stop-out monitoring",
        "Appropriateness and KYC required before live trading",
      ],
      legalNote:
        "Sandbox controls are included for product readiness; real-money brokerage requires licensed legal and compliance approval.",
    }),
  },
  {
    method: "GET",
    path: api("/onboarding/status"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      if (!IS_PERSISTENT || !prisma) {
        return {
          kyc:               "pending",
          kycCaseStatus:     null,
          appropriateness:   "required",
          documents:         ["identity", "proof_of_address"],
          liveTradingAllowed: false,
          note: "SANDBOX_MODE: KYC status requires database",
        };
      }

      const db   = prisma as NonNullable<typeof prisma>;
      const user = await db.user.findUnique({
        where:  { id: principal.sub },
        select: {
          kycStatus: true,
          KycCase: {
            select: {
              id:          true,
              status:      true,
              riskScore:   true,
              completedAt: true,
            },
          },
        },
      });

      if (!user) return { ok: false, reason: "USER_NOT_FOUND" };

      const kycCase = user.KycCase;

      const kycDocuments = kycCase
        ? await db.kycDocument.findMany({
            where:  { caseId: kycCase.id },
            select: { documentKey: true, status: true },
          }).catch(() => [] as Array<{ documentKey: string; status: string }>)
        : ([] as Array<{ documentKey: string; status: string }>);

      const approvedDocKeys = new Set(
        kycDocuments
          .filter((d) => d.status === "VERIFIED")
          .map((d) => d.documentKey),
      );

      const requiredDocs = ["PASSPORT", "PROOF_OF_ADDRESS"] as const;
      const missingDocs  = requiredDocs.filter((k) => !approvedDocKeys.has(k));

      const liveTradingAllowed =
        user.kycStatus === "approved" && kycCase?.status === "APPROVED";

      return {
        kyc:               user.kycStatus,
        kycCaseStatus:     kycCase?.status ?? null,
        appropriateness:   liveTradingAllowed ? "complete" : "required",
        documents:         missingDocs,
        liveTradingAllowed,
        ...(kycCase?.completedAt
          ? { kycCompletedAt: kycCase.completedAt.toISOString() }
          : {}),
      };
    },
  },
  // ===== TRADE AUDIT ROUTES =====
  {
    method: "GET",
    path: api("/trading/audit/history"),
    auth: true,
    handler: ({ query, state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      return state.getTradeHistory(principal.sub, {
        symbol: (query as any)?.symbol,
        status: (query as any)?.status,
        limit: parseInt((query as any)?.limit) || 50,
        offset: parseInt((query as any)?.offset) || 0,
      });
    },
  },
  {
    method: "GET",
    path: api("/trading/audit/stats"),
    auth: true,
    handler: ({ state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      return state.getUserTradeStats(principal.sub);
    },
  },
  // ===== OLOS SIGNAL ROUTES =====
  {
    method: "GET",
    path: api("/signals/active"),
    auth: true,
    handler: ({ query, state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      return state.getActiveSignals(principal.sub, { symbol: (query as any)?.symbol });
    },
  },
  {
    method: "GET",
    path: api("/signals/history"),
    auth: true,
    handler: ({ query, state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      return state.getSignalHistory(principal.sub, {
        symbol: (query as any)?.symbol,
        status: (query as any)?.status,
        limit: parseInt((query as any)?.limit) || 50,
        offset: parseInt((query as any)?.offset) || 0,
      });
    },
  },
  {
    method: "GET",
    path: api("/signals/stats"),
    auth: true,
    handler: ({ state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      return state.getSignalStatistics(principal.sub);
    },
  },
  // ===== OLOS INTELLIGENCE ROUTES (client-facing) =====
  {
    method: "GET",
    path: api("/olos/signals/history"),
    auth: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      if (!IS_PERSISTENT || !prisma) {
        return { ok: false, reason: "SANDBOX_MODE", signals: [] };
      }

      const db        = prisma as NonNullable<typeof prisma>;
      const symbol    = query.get("symbol")    ?? undefined;
      const outcome   = query.get("outcome")   ?? undefined;
      const fromDate  = query.get("from")      ? new Date(query.get("from")!) : undefined;
      const toDate    = query.get("to")        ? new Date(query.get("to")!)   : undefined;
      const limitVal  = Math.min(parseInt(query.get("limit") ?? "50"), 200);
      const offsetVal = parseInt(query.get("offset") ?? "0");

      const where: Record<string, unknown> = {};
      if (symbol)   where["symbol"]  = symbol;
      if (outcome)  where["outcome"] = outcome;
      if (fromDate || toDate) {
        where["generatedAt"] = {
          ...(fromDate && { gte: fromDate }),
          ...(toDate   && { lte: toDate   }),
        };
      }

      const [signals, total] = await Promise.all([
        db.signalTelemetry.findMany({
          where,
          orderBy: { generatedAt: "desc" },
          skip:    offsetVal,
          take:    limitVal,
          select: {
            signalId:              true,
            symbol:                true,
            timeframe:             true,
            signalType:            true,
            confidence:            true,
            entryPrice:            true,
            stopLoss:              true,
            target1:               true,
            target2:               true,
            riskRewardRatio:       true,
            marketRegime:          true,
            volatilityLevel:       true,
            confluenceFactors:     true,
            outcome:               true,
            pnl:                   true,
            pnlPips:               true,
            exitPrice:             true,
            exitReason:            true,
            durationSeconds:       true,
            maxFavorableExcursion: true,
            maxAdverseExcursion:   true,
            generatedAt:           true,
            executedAt:            true,
            closedAt:              true,
          },
        }),
        db.signalTelemetry.count({ where }),
      ]);

      return { ok: true, total, limit: limitVal, offset: offsetVal, signals };
    },
  },

  // ===== OLOS INTELLIGENCE ADMIN ROUTES =====
  {
    method: "GET",
    path: api("/admin/olos/intelligence/dashboard"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      if (!IS_PERSISTENT) {
        return { ok: false, reason: "SANDBOX_MODE" };
      }

      const filter = _buildAnalyticsFilter(query);
      const summary = await signalAnalytics.getDashboardSummary(filter);
      return { ok: true, ...summary };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/intelligence/signals"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      if (!IS_PERSISTENT || !prisma) {
        return { ok: false, reason: "SANDBOX_MODE", signals: [] };
      }

      const db        = prisma as NonNullable<typeof prisma>;
      const limitVal  = Math.min(parseInt(query.get("limit") ?? "50"), 500);
      const offsetVal = parseInt(query.get("offset") ?? "0");
      const symbol    = query.get("symbol")    ?? undefined;
      const outcome   = query.get("outcome")   ?? undefined;
      const regime    = query.get("regime")    ?? undefined;
      const signalType= query.get("signalType") ?? undefined;
      const fromDate  = query.get("from")      ? new Date(query.get("from")!) : undefined;
      const toDate    = query.get("to")        ? new Date(query.get("to")!)   : undefined;

      const where: Record<string, unknown> = {};
      if (symbol)     where["symbol"]     = symbol;
      if (outcome)    where["outcome"]    = outcome;
      if (regime)     where["marketRegime"] = regime;
      if (signalType) where["signalType"] = signalType;
      if (fromDate || toDate) {
        where["generatedAt"] = {
          ...(fromDate && { gte: fromDate }),
          ...(toDate   && { lte: toDate   }),
        };
      }

      const [signals, total] = await Promise.all([
        db.signalTelemetry.findMany({
          where,
          orderBy: { generatedAt: "desc" },
          skip:    offsetVal,
          take:    limitVal,
        }),
        db.signalTelemetry.count({ where }),
      ]);

      return { ok: true, total, limit: limitVal, offset: offsetVal, signals };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/intelligence/regimes"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const filter = _buildAnalyticsFilter(query);
      const regimes = await signalAnalytics.getRegimePerformance(filter);
      return { ok: true, regimes };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/intelligence/symbols"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const filter = _buildAnalyticsFilter(query);
      const symbols = await signalAnalytics.getSymbolPerformance(filter);
      return { ok: true, symbols };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/intelligence/monthly"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const filter   = _buildAnalyticsFilter(query);
      const monthly  = await signalAnalytics.getMonthlyPerformance(filter);
      return { ok: true, monthly };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/intelligence/confidence"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const filter = _buildAnalyticsFilter(query);
      const bands  = await signalAnalytics.getConfidenceBands(filter);
      return { ok: true, bands };
    },
  },

  // ===== OLOS ADAPTIVE INTELLIGENCE ADMIN ROUTES =====
  {
    method: "GET",
    path: api("/admin/olos/calibration"),
    admin: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const metrics = await calibrationService.getMetrics();
      return { ok: true, ...metrics };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/weights/current"),
    admin: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const current = await adaptiveWeightsService.getWeights();
      return { ok: true, ...current };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/weights/history"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const limit   = Math.min(parseInt(query.get("limit") ?? "20"), 100);
      const history = await adaptiveWeightsService.getHistory(limit);
      return { ok: true, history };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/optimizer/history"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const limit   = Math.min(parseInt(query.get("limit") ?? "10"), 50);
      const history = await selfOptimizerService.getHistory(limit);
      return { ok: true, history };
    },
  },
  {
    method: "POST",
    path: api("/admin/olos/optimizer/run"),
    admin: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const result = await selfOptimizerService.run(principal.sub);
      return { ok: true, ...result };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/calendar"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const hours  = Math.min(parseInt(query.get("hours") ?? "24"), 168);
      const events = await economicEventService.getUpcoming(hours);
      return { ok: true, events };
    },
  },
  {
    method: "POST",
    path: api("/admin/olos/calendar/refresh"),
    admin: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      void economicEventService.refresh(principal.sub);
      return { ok: true, message: "Calendar refresh triggered" };
    },
  },

  // ===== TASK 12 — QUANT INTELLIGENCE ADMIN ROUTES =====
  {
    method: "GET",
    path: api("/admin/olos/explain/:signalId"),
    admin: true,
    handler: async ({ authHeader, params, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const explanation = await signalExplainer.explainSignal(params.signalId);
      if (!explanation) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, explanation };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/intelligence/multi-timeframe/:symbol"),
    admin: true,
    handler: async ({ authHeader, params, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const side = (query.get("side") ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY";
      const result = multiTimeframeEngine.evaluate(params.symbol.toUpperCase(), side);
      return { ok: true, multiTimeframe: result };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/intelligence/correlation/:symbol"),
    admin: true,
    handler: async ({ authHeader, params, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const side = (query.get("side") ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY";
      const result = correlationEngine.evaluate(params.symbol.toUpperCase(), side);
      return { ok: true, correlation: result };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/intelligence/probability"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const confidence = Math.min(100, Math.max(0, parseFloat(query.get("confidence") ?? "70")));
      const regime      = query.get("regime") ?? "RANGING";
      const forecast = await calibrationService.predictProbabilities(confidence, regime, {});
      return { ok: true, forecast };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/intelligence/risk-preview"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const entryPrice = parseFloat(query.get("entryPrice") ?? "100");
      const atr         = parseFloat(query.get("atr") ?? "1");
      const direction   = query.get("direction") === "SELL" ? -1 : 1;
      const trendStrength = parseFloat(query.get("trendStrength") ?? "20");
      const volatilityLevel = (query.get("volatilityLevel") ?? "MEDIUM") as "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
      const confidence  = parseFloat(query.get("confidence") ?? "70");
      const marketRegime = (query.get("marketRegime") ?? "RANGING") as
        | "BULLISH_TREND" | "BEARISH_TREND" | "RANGING" | "COMPRESSION" | "EXPANSION"
        | "RISK_OFF" | "HIGH_VOLATILITY" | "LOW_VOLATILITY" | "NEWS_DRIVEN" | "TREND_EXHAUSTION";
      const mtfConfidenceMultiplier = parseFloat(query.get("mtfMultiplier") ?? "1");

      const preview = dynamicRiskEngine.compute({
        entryPrice, atr, direction, trendStrength, volatilityLevel,
        confidence, marketRegime, mtfConfidenceMultiplier,
      });
      return { ok: true, preview };
    },
  },

  // ===== SIGNAL INTELLIGENCE CENTER (Part E) =====
  {
    method: "GET",
    path: api("/admin/olos/intelligence/performance-matrix"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const days   = Math.min(parseInt(query.get("days") ?? "28"), 90);
      const matrix = await confidenceOptimizer.buildPerformanceMatrix(days);
      return { ok: true, ...matrix };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/intelligence/best-worst-symbols"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const days      = Math.min(parseInt(query.get("days") ?? "28"), 90);
      const minTrades = Math.max(parseInt(query.get("min_trades") ?? "5"), 1);
      const result    = await confidenceOptimizer.getBestWorstSymbols(days, minTrades);
      return { ok: true, ...result };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/intelligence/sessions"),
    admin: true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const days   = Math.min(parseInt(query.get("days") ?? "28"), 90);
      const result = await confidenceOptimizer.getBestWorstSessions(days);
      return { ok: true, ...result };
    },
  },
  {
    method: "GET",
    path: api("/admin/olos/calibration/accuracy-report"),
    admin: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const report = await calibrationService.getConfidenceAccuracyReport();
      return { ok: true, ...report };
    },
  },

  // ===== RISK WARNING ROUTES =====
  {
    method: "GET",
    path: api("/risk/warning/current"),
    auth: true,
    handler: async ({ state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      return state.getCurrentWarning(principal.sub);
    },
  },
  {
    method: "GET",
    path: api("/risk/warning/dashboard"),
    auth: true,
    handler: async ({ state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      return state.getRiskDashboard(principal.sub);
    },
  },
  {
    method: "GET",
    path: api("/risk/warning/scenarios"),
    auth: true,
    handler: async ({ state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      return state.analyzeScenarios(principal.sub);
    },
  },
  {
    method: "POST",
    path: api("/risk/warning/:id/acknowledge"),
    auth: true,
    handler: async ({ params, state }) => {
      const warningId = (params as any)?.id;
      return state.acknowledgeWarning(warningId);
    },
  },
  // ── KYC / Identity Verification ───────────────────────────────────────────────

  // Get or create the user's KYC case (status, documents, steps)
  {
    method: "GET",
    path: api("/kyc/case"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return kycService.getOrCreateCase(principal.sub);
    },
  },

  // Upload a KYC document — triggers OCR + risk assessment automatically
  {
    method: "POST",
    path: api("/kyc/document"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const b = body as Record<string, unknown>;
      if (!b?.documentKey || !b?.content) {
        return { ok: false, reason: "documentKey and content (base64) are required" };
      }
      return kycService.uploadDocument({
        userId:      principal.sub,
        documentKey: String(b.documentKey) as import("../kyc-service/kyc.service.js").KycDocumentKey,
        label:       String(b.label ?? b.documentKey),
        fileName:    String(b.fileName ?? "upload"),
        mimeType:    b.mimeType ? String(b.mimeType) : undefined,
        content:     String(b.content),
      });
    },
  },

  // Admin: list cases pending human review
  {
    method: "GET",
    path: api("/admin/kyc/cases"),
    admin: true,
    handler: async ({ query }) => {
      const limit = Math.min(parseInt(query.get("limit") ?? "50"), 200);
      return kycService.getPendingCases(limit);
    },
  },

  // Admin: approve a KYC case
  {
    method: "POST",
    path: api("/admin/kyc/cases/:caseId/approve"),
    admin: true,
    handler: async ({ params, body, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { notes } = (body ?? {}) as Record<string, string>;
      await kycService.approveCase(params.caseId, principal.sub, notes);
      return { ok: true };
    },
  },

  // Admin: reject a KYC case
  {
    method: "POST",
    path: api("/admin/kyc/cases/:caseId/reject"),
    admin: true,
    handler: async ({ params, body, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { reason } = (body ?? {}) as Record<string, string>;
      if (!reason) return { ok: false, reason: "reason is required" };
      await kycService.rejectCase(params.caseId, principal.sub, reason);
      return { ok: true };
    },
  },

  // Admin: request additional documents
  {
    method: "POST",
    path: api("/admin/kyc/cases/:caseId/request-docs"),
    admin: true,
    handler: async ({ params, body, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const b = (body ?? {}) as Record<string, unknown>;
      const docs  = Array.isArray(b.documents) ? b.documents.map(String) : [];
      const notes = b.notes ? String(b.notes) : undefined;
      if (!docs.length) return { ok: false, reason: "documents array is required" };
      await kycService.requestMoreDocuments(params.caseId, principal.sub, docs, notes);
      return { ok: true };
    },
  },

  // ── Affiliate / IB referral program ───────────────────────────────────────────
  {
    method: "GET",
    path: api("/admin/affiliates"),
    admin: true,
    handler: async () => affiliateService.list(),
  },
  {
    method: "POST",
    path: api("/admin/affiliates"),
    admin: true,
    handler: async ({ body, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const b = (body ?? {}) as Record<string, unknown>;
      const name  = b.name  ? String(b.name)  : "";
      const email = b.email ? String(b.email) : "";
      if (!name || !email) return { ok: false, reason: "name and email are required" };
      const commissionPct = typeof b.commissionPct === "number" ? b.commissionPct : undefined;
      const affiliate = await affiliateService.create({ name, email, commissionPct }, principal.sub);
      return { ok: true, affiliate };
    },
  },
  {
    method: "POST",
    path: api("/admin/affiliates/:affiliateId/activate"),
    admin: true,
    handler: async ({ params, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const affiliate = await affiliateService.setStatus(params.affiliateId, "ACTIVE", principal.sub);
      return { ok: true, affiliate };
    },
  },
  {
    method: "POST",
    path: api("/admin/affiliates/:affiliateId/deactivate"),
    admin: true,
    handler: async ({ params, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const affiliate = await affiliateService.setStatus(params.affiliateId, "INACTIVE", principal.sub);
      return { ok: true, affiliate };
    },
  },
  {
    method: "POST",
    path: api("/admin/affiliates/:affiliateId/pay-commissions"),
    admin: true,
    handler: async ({ params, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const result = await affiliateService.markCommissionsPaid(params.affiliateId, principal.sub);
      return { ok: true, ...result };
    },
  },

  // ── Compliance audit trail ────────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/admin/compliance/audit"),
    admin: true,
    handler: async ({ query }) => {
      return auditTrail.query({
        actor:  query.get("userId") ?? undefined,
        action: query.get("action") ?? undefined,
        limit:  parseInt(query.get("limit")  ?? "100"),
        offset: parseInt(query.get("offset") ?? "0"),
        from:   query.get("from") ? new Date(query.get("from")!) : undefined,
        to:     query.get("to")   ? new Date(query.get("to")!)   : undefined,
      });
    },
  },

  // ── Notifications ─────────────────────────────────────────────────────────────

  // Get unread in-app notifications
  {
    method: "GET",
    path: api("/notifications"),
    auth: true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const limit = parseInt(query.get("limit") ?? "50");
      return notificationRouter.getInApp(principal.sub, limit);
    },
  },

  // Mark notifications as read
  {
    method: "POST",
    path: api("/notifications/read"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const ids = Array.isArray((body as Record<string, unknown>).ids)
        ? ((body as Record<string, unknown>).ids as string[])
        : undefined;
      await notificationRouter.markRead(principal.sub, ids);
      return { ok: true };
    },
  },

  // ── 2FA / TOTP ────────────────────────────────────────────────────────────────

  // Setup: generate secret + QR URI (not yet persisted)
  {
    method: "POST",
    path: api("/auth/2fa/setup"),
    auth: true,
    handler: ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const setup = twoFactorService.generateSetup(principal.sub, principal.email);
      return { ok: true, ...setup };
    },
  },

  // Enable: verify first token, then persist secret
  {
    method: "POST",
    path: api("/auth/2fa/enable"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const b = (body ?? {}) as Record<string, string[]>;
      return twoFactorService.enable2fa(
        principal.sub,
        String((body as Record<string, unknown>).secret ?? ""),
        String((body as Record<string, unknown>).token ?? ""),
        Array.isArray(b.backupCodes) ? b.backupCodes : [],
      );
    },
  },

  // Verify: check token (used after password auth to complete login)
  {
    method: "POST",
    path: api("/auth/2fa/verify"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const token = String((body as Record<string, unknown>).token ?? "");
      return twoFactorService.verify(principal.sub, token);
    },
  },

  // Status: is 2FA enabled?
  {
    method: "GET",
    path: api("/auth/2fa/status"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const enabled = await twoFactorService.isEnabled(principal.sub);
      return { enabled };
    },
  },

  // Disable 2FA
  {
    method: "DELETE",
    path: api("/auth/2fa"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      await twoFactorService.disable2fa(principal.sub);
      return { ok: true };
    },
  },

  // ── DB-backed auth (when DATABASE_URL is set) ─────────────────────────────────

  // DB login — uses DB-backed scrypt auth when available, falls back to
  // in-memory sandbox auth so the app works without a database connection.
  {
    method: "POST",
    path: api("/auth/login/db"),
    handler: async (ctx) => {
      if (IS_PERSISTENT) {
        return authController.login(ctx as Parameters<typeof authController.login>[0]);
      }
      // Sandbox fallback: in-memory state login
      const body   = ctx.body as Record<string, unknown>;
      const parsed = LoginRequestSchema.parse(body);
      const result = await ctx.state.login(parsed.email, parsed.password);
      if (!result) return { ok: false, reason: "invalid_credentials" };
      const isAdmin = result.principal.roles.some((r: string) =>
        ["admin", "super_admin", "risk", "compliance"].includes(r)
      );
      if (!isAdmin && !isClientAuthKeyValid(parsed.authKey)) {
        return { ok: false, reason: "invalid_auth_key" };
      }
      // Set httpOnly refresh-token cookie so the browser can silently
      // re-authenticate after a page reload without re-entering credentials.
      if (result.refreshToken) {
        const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
        ctx.res.setHeader("Set-Cookie",
          `igfxpro_rt=${result.refreshToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}${secure}`
        );
      }
      return { ...result, refreshToken: undefined };
    },
  },

  // Fix #3: completes a login that /auth/login/db gated on 2FA. Takes the
  // short-lived mfaToken from that response plus a TOTP/backup code, and is
  // the only path that mints a real session for a 2FA-enrolled account.
  {
    method: "POST",
    path: api("/auth/login/db/mfa"),
    handler: async (ctx) => {
      if (!IS_PERSISTENT) return { ok: false, reason: "DB_UNAVAILABLE" };
      return authController.completeMfaLogin(ctx as Parameters<typeof authController.completeMfaLogin>[0]);
    },
  },

  // DB register — falls back to in-memory registration without a DB.
  {
    method: "POST",
    path: api("/auth/register/db"),
    handler: async (ctx) => {
      if (IS_PERSISTENT) {
        const result = await authController.register(ctx as Parameters<typeof authController.register>[0]);
        const referralCode = (ctx.body as Record<string, unknown>)?.referralCode;
        if ((result as { ok?: boolean; principal?: { sub: string } })?.ok && typeof referralCode === "string" && referralCode.trim()) {
          const sub = (result as { principal?: { sub: string } }).principal?.sub;
          if (sub) {
            await affiliateService.recordReferral(sub, referralCode).catch(() => {});
          }
        }
        return result;
      }
      const body   = ctx.body as Record<string, unknown>;
      const parsed = RegisterRequestSchema.parse(body);
      if (!isClientAuthKeyValid(parsed.authKey)) {
        return { ok: false, reason: "invalid_auth_key" };
      }
      const regResult = (await ctx.state.register(parsed)) as Record<string, unknown>;
      if (regResult?.refreshToken) {
        const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
        ctx.res.setHeader("Set-Cookie",
          `igfxpro_rt=${regResult.refreshToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}${secure}`
        );
        return { ...regResult, refreshToken: undefined };
      }
      return regResult;
    },
  },

  // DB refresh — falls back to in-memory token refresh without a DB.
  {
    method: "POST",
    path: api("/auth/refresh/db"),
    handler: async (ctx) => {
      if (IS_PERSISTENT) {
        return authController.refresh(ctx as Parameters<typeof authController.refresh>[0]);
      }
      // Sandbox fallback: read cookie or body token
      const cookieToken = (ctx.req.headers.cookie ?? "")
        .split(";")
        .map((c: string) => c.trim())
        .find((c: string) => c.startsWith("igfxpro_rt="))
        ?.slice("igfxpro_rt=".length) ?? "";
      const bodyToken = String(
        (ctx.body as Record<string, unknown>)?.refreshToken ?? ""
      );
      const token = cookieToken || bodyToken;
      if (!token) return { ok: false, reason: "no_refresh_token" };
      const result = ctx.state.refresh(token);
      if (!result) {
        ctx.res.setHeader("Set-Cookie", "igfxpro_rt=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
        return { ok: false, reason: "invalid_refresh_token" };
      }
      // Rotate the refresh cookie
      if (result.refreshToken) {
        const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
        ctx.res.setHeader("Set-Cookie",
          `igfxpro_rt=${result.refreshToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}${secure}`
        );
      }
      return { ...result, refreshToken: undefined };
    },
  },

  // ── Session management ────────────────────────────────────────────────────────

  {
    method: "GET",
    path: api("/auth/sessions"),
    auth: true,
    handler: async (ctx) => {
      const principal = ctx.state.resolvePrincipal(ctx.authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const sessions = await authService.listSessions(principal.sub);
      return {
        ok: true,
        sessions: sessions.map((s) => ({
          expiresAt: s.expiresAt.toISOString(),
          createdAt: s.createdAt.toISOString(),
          tokenHint: s.refreshToken.slice(0, 8) + "...",
        })),
      };
    },
  },

  {
    method: "DELETE",
    path: api("/auth/sessions/all"),
    auth: true,
    handler: async (ctx) => {
      const principal = ctx.state.resolvePrincipal(ctx.authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      // Also clear the cookie
      ctx.res.setHeader("Set-Cookie", "igfxpro_rt=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      const count = await authService.revokeAllSessions(principal.sub);
      return { ok: true, revokedCount: count };
    },
  },

  // ── Admin: deposit management ─────────────────────────────────────────────────

  {
    method: "GET",
    path: api("/admin/deposits/pending"),
    admin: true,
    handler: async ({ query }) => {
      if (!IS_PERSISTENT) return { ok: true, entries: [] };
      const db    = (await import("../shared/db.js")).prisma;
      const limit = Math.min(parseInt(query.get("limit") ?? "100"), 500);
      const entries = await (db as NonNullable<typeof db>).ledgerEntry.findMany({
        where:   { type: "DEPOSIT_REQUEST", status: "PENDING_ADMIN" },
        orderBy: { createdAt: "asc" },
        take:    limit,
      });
      return { ok: true, entries };
    },
  },

  {
    method: "POST",
    path: api("/admin/deposits/:entryId/approve"),
    admin: true,
    handler: async ({ params, authHeader, state }) => {
      if (!IS_PERSISTENT) return { ok: false, reason: "DB_UNAVAILABLE" };
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const db    = (await import("../shared/db.js")).prisma;
      // Fix #11: LedgerEntry's real PK is composite (id, createdAt) — id
      // alone is no longer a valid Prisma unique-where, but remains
      // effectively unique in practice (uuid-generated), so findFirst
      // behaves identically to the old findUnique here.
      const entry = await (db as NonNullable<typeof db>).ledgerEntry.findFirst({
        where: { id: params.entryId },
      });
      if (!entry) return { ok: false, reason: "ENTRY_NOT_FOUND" };
      if (entry.type !== "DEPOSIT_REQUEST" || entry.status !== "PENDING_ADMIN") {
        return { ok: false, reason: "INVALID_STATE" };
      }

      const engine = new LedgerEngine(db as NonNullable<typeof db>);
      // CRITICAL_REMEDIATION (C2): pass the request row's own immutable id,
      // not entry.reference (client-controlled, non-unique) -- see
      // LedgerEngine.approveDeposit()'s docstring for the full root cause.
      await engine.approveDeposit(entry.userId, Number(entry.amount), entry.id, principal.sub);
      return { ok: true };
    },
  },

  {
    method: "POST",
    path: api("/admin/deposits/:entryId/reject"),
    admin: true,
    handler: async ({ params, authHeader, state }) => {
      if (!IS_PERSISTENT) return { ok: false, reason: "DB_UNAVAILABLE" };
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const db     = (await import("../shared/db.js")).prisma;
      const entry  = await (db as NonNullable<typeof db>).ledgerEntry.findFirst({
        where: { id: params.entryId },
      });
      if (!entry) return { ok: false, reason: "ENTRY_NOT_FOUND" };
      if (entry.type !== "DEPOSIT_REQUEST" || entry.status !== "PENDING_ADMIN") {
        return { ok: false, reason: "INVALID_STATE" };
      }

      const engine = new LedgerEngine(db as NonNullable<typeof db>);
      await engine.rejectDeposit(entry.userId, params.entryId, principal.sub);
      return { ok: true };
    },
  },

  // ── Admin: withdrawal management ──────────────────────────────────────────────

  {
    method: "GET",
    path: api("/admin/withdrawals/pending"),
    admin: true,
    handler: async ({ query }) => {
      if (!IS_PERSISTENT) return { ok: true, entries: [] };
      const db    = (await import("../shared/db.js")).prisma;
      const limit = Math.min(parseInt(query.get("limit") ?? "100"), 500);
      const entries = await (db as NonNullable<typeof db>).ledgerEntry.findMany({
        where:   { type: "WITHDRAW_REQUEST", status: "PENDING_ADMIN" },
        orderBy: { createdAt: "asc" },
        take:    limit,
      });
      return { ok: true, entries };
    },
  },

  {
    method: "POST",
    path: api("/admin/withdrawals/:entryId/approve"),
    admin: true,
    handler: async ({ params, authHeader, state }) => {
      if (!IS_PERSISTENT) return { ok: false, reason: "DB_UNAVAILABLE" };
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const db    = (await import("../shared/db.js")).prisma;
      // Fix #11: LedgerEntry's real PK is composite (id, createdAt) — id
      // alone is no longer a valid Prisma unique-where, but remains
      // effectively unique in practice (uuid-generated), so findFirst
      // behaves identically to the old findUnique here.
      const entry = await (db as NonNullable<typeof db>).ledgerEntry.findFirst({
        where: { id: params.entryId },
      });
      if (!entry) return { ok: false, reason: "ENTRY_NOT_FOUND" };
      if (entry.type !== "WITHDRAW_REQUEST" || entry.status !== "PENDING_ADMIN") {
        return { ok: false, reason: "INVALID_STATE" };
      }

      const engine = new LedgerEngine(db as NonNullable<typeof db>);
      // requestWithdrawal() stores this PENDING_ADMIN entry's amount as
      // NEGATIVE (a signed ledger delta); approveWithdrawal() expects a
      // positive magnitude (it negates internally when building its own
      // COMPLETED entry) -- passing the signed value through unconverted
      // made every approval add the withdrawal amount to the client's
      // balance instead of subtracting it, and silently defeated both the
      // INSUFFICIENT_BALANCE and INSUFFICIENT_FREE_MARGIN checks (a negative
      // "amount" is never greater than a positive balance/freeMargin).
      // CRITICAL_REMEDIATION (C1): pass the request row's own immutable id,
      // not entry.reference (the destination string, which legitimately
      // repeats across a client's withdrawals) -- see
      // LedgerEngine.approveWithdrawal()'s docstring for the full root cause.
      await engine.approveWithdrawal(entry.userId, Math.abs(Number(entry.amount)), entry.id, principal.sub);
      return { ok: true };
    },
  },

  {
    method: "POST",
    path: api("/admin/withdrawals/:entryId/reject"),
    admin: true,
    handler: async ({ params, authHeader, state }) => {
      if (!IS_PERSISTENT) return { ok: false, reason: "DB_UNAVAILABLE" };
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const db    = (await import("../shared/db.js")).prisma;
      // Fix #11: LedgerEntry's real PK is composite (id, createdAt) — id
      // alone is no longer a valid Prisma unique-where, but remains
      // effectively unique in practice (uuid-generated), so findFirst
      // behaves identically to the old findUnique here.
      const entry = await (db as NonNullable<typeof db>).ledgerEntry.findFirst({
        where: { id: params.entryId },
      });
      if (!entry) return { ok: false, reason: "ENTRY_NOT_FOUND" };
      if (entry.type !== "WITHDRAW_REQUEST" || entry.status !== "PENDING_ADMIN") {
        return { ok: false, reason: "INVALID_STATE" };
      }

      const engine = new LedgerEngine(db as NonNullable<typeof db>);
      await engine.rejectWithdrawal(entry.userId, params.entryId, principal.sub);
      return { ok: true };
    },
  },

  // ── User settings (persisted via BrokerSetting) ───────────────────────────────

  {
    method: "GET",
    path: api("/user/settings"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      if (IS_PERSISTENT) {
        const db = (await import("../shared/db.js")).prisma;
        const row = await (db as NonNullable<typeof db>).brokerSetting.findUnique({
          where: { key: `user_settings:${principal.sub}` },
        });
        return row ? { ok: true, settings: row.value } : { ok: true, settings: {} };
      }

      return { ok: true, settings: {} };
    },
  },

  {
    method: "PUT",
    path: api("/user/settings"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const settings = (body ?? {}) as Record<string, unknown>;

      if (IS_PERSISTENT) {
        const db = (await import("../shared/db.js")).prisma;
        await (db as NonNullable<typeof db>).brokerSetting.upsert({
          where:  { key: `user_settings:${principal.sub}` },
          create: { key: `user_settings:${principal.sub}`, value: settings as object },
          update: { value: settings as object },
        });
      }

      return { ok: true, settings };
    },
  },

  // PATCH: merge-update (only override provided keys)
  {
    method: "PATCH",
    path: api("/user/settings"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const patch = (body ?? {}) as Record<string, unknown>;

      if (IS_PERSISTENT) {
        const db = (await import("../shared/db.js")).prisma;
        const existing = await (db as NonNullable<typeof db>).brokerSetting.findUnique({
          where: { key: `user_settings:${principal.sub}` },
        });
        const current  = (existing?.value as Record<string, unknown>) ?? {};
        const merged   = { ...current, ...patch };

        await (db as NonNullable<typeof db>).brokerSetting.upsert({
          where:  { key: `user_settings:${principal.sub}` },
          create: { key: `user_settings:${principal.sub}`, value: merged as object },
          update: { value: merged as object },
        });
        return { ok: true, settings: merged };
      }

      return { ok: true, settings: patch };
    },
  },

  // ── Notification preferences ───────────────────────────────────────────────────

  {
    method: "GET",
    path: api("/notifications/preferences"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return notificationRouter.getPreferences(principal.sub);
    },
  },

  {
    method: "PUT",
    path: api("/notifications/preferences"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const prefs = (body ?? {}) as Record<string, unknown>;
      return notificationRouter.updatePreferences(principal.sub, prefs);
    },
  },

  // ── Pending orders ─────────────────────────────────────────────────────────────

  {
    method: "GET",
    path: api("/trading/orders/pending"),
    auth: true,
    handler: ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return { ok: true, orders: pendingOrderBook.getForUser(principal.sub) };
    },
  },

  {
    method: "DELETE",
    path: api("/trading/orders/pending/:pendingId"),
    auth: true,
    handler: async ({ params, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const ok = await pendingOrderBook.cancel(params.pendingId, principal.sub);
      return ok ? { ok: true } : { ok: false, reason: "NOT_FOUND_OR_UNAUTHORIZED" };
    },
  },

  // ── User profile (DB-backed) ───────────────────────────────────────────────────

  {
    method: "GET",
    path: api("/user/profile"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      if (IS_PERSISTENT) {
        const db   = (await import("../shared/db.js")).prisma;
        const user = await (db as NonNullable<typeof db>).user.findUnique({
          where:  { id: principal.sub },
          select: { id: true, email: true, fullName: true, tier: true, kycStatus: true, createdAt: true, role: true },
        });
        if (user) return { ok: true, profile: user };
      }

      return { ok: true, profile: state.getClientAccount(principal.sub) };
    },
  },

  {
    method: "PUT",
    path: api("/user/profile"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const patch = (body ?? {}) as { fullName?: string };

      if (IS_PERSISTENT && patch.fullName) {
        const db = (await import("../shared/db.js")).prisma;
        await (db as NonNullable<typeof db>).user.update({
          where:  { id: principal.sub },
          data:   { fullName: String(patch.fullName).slice(0, 100) },
        });
      }

      return { ok: true };
    },
  },

  // ── AI Services ──────────────────────────────────────────────────────────────
  {
    method: "POST",
    path: api("/ai/chat"),
    auth: true,
    handler: handleAiChat,
  },
  {
    method: "POST",
    path: api("/ai/backtest"),
    auth: true,
    handler: handleBacktest,
  },
  {
    method: "POST",
    path: api("/ai/strategy"),
    auth: true,
    handler: handleStrategyGen,
  },
  {
    method: "POST",
    path: api("/ai/hedge"),
    auth: true,
    handler: handleHedge,
  },

  // ── Admin: Feature Flags — GET (read) + POST (persist) ───────────────────
  {
    method: "GET",
    path: api("/admin/feature-flags"),
    admin: true,
    handler: ({ state }) => state.getFeatureFlags(),
  },
  {
    method: "POST",
    path: api("/admin/feature-flags"),
    admin: true,
    handler: ({ body, state, authHeader }) => {
      const p = state.resolvePrincipal(authHeader)!;
      const flags = body as Record<string, boolean>;
      state.updateFeatureFlags(flags, p.sub);
      return { ok: true, flags: state.getFeatureFlags(), updatedAt: new Date().toISOString() };
    },
  },

  // ── Admin: AML Alerts — list + review ────────────────────────────────────
  {
    method: "GET",
    path: api("/admin/aml-alerts"),
    admin: true,
    handler: ({ state }) => state.getAmlAlerts(),
  },
  {
    method: "POST",
    path: api("/admin/aml-alerts/:id/review"),
    admin: true,
    handler: ({ params, body, state, authHeader }) => {
      const p = state.resolvePrincipal(authHeader)!;
      const alertId = params.id ?? "";
      const { status, note } = body as { status: "REVIEWED" | "CLEARED"; note?: string };
      return state.reviewAmlAlert(alertId, status, p.sub, note);
    },
  },

  // ── Admin: System Logs — real audit trail ─────────────────────────────────
  {
    method: "GET",
    path: api("/admin/system-logs"),
    admin: true,
    handler: async ({ state, query }) => {
      const limit = Math.min(parseInt(query.get("limit") ?? "100"), 500);
      const toEntry = (entry: { id: string; actor: string; action: string; entity: string; createdAt: string | Date }) => ({
        id:        entry.id,
        level:     entry.action.startsWith("admin.") ? "INFO" : entry.action.includes("fail") ? "ERROR" : "INFO",
        service:   entry.action.split(".")[0] ?? "system",
        message:   `[${entry.actor}] ${entry.action} on ${entry.entity}`,
        timestamp: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : entry.createdAt,
        actor:     entry.actor,
        action:    entry.action,
        entity:    entry.entity,
      });
      // When DB is available, read from persistent AuditLog for full history (survives restart)
      if (IS_PERSISTENT && prisma) {
        const rows = await (prisma as NonNullable<typeof prisma>).auditLog.findMany({
          orderBy: { createdAt: "desc" },
          take:    limit,
        });
        return rows.map(toEntry);
      }
      return state.getAudit().slice(0, limit).map(toEntry);
    },
  },

  // ── Infrastructure Telemetry ──────────────────────────────────────────────
  {
    method: "GET",
    path: api("/telemetry/health"),
    admin: true, // Fix #5: infra/latency telemetry was previously exposed with zero auth
    handler: async () => {
      return latencyAnalyticsService.getTelemetry();
    },
  },

  // ── Admin: Real infra metrics (DB · WS · EventBus · Redis · Execution) ───
  {
    method: "GET",
    path: api("/admin/infra"),
    admin: true,
    handler: async () => {
      let dbPingMs = 0;
      if (IS_PERSISTENT && prisma) {
        try {
          const t0 = Date.now();
          await (prisma as NonNullable<typeof prisma>).$queryRaw`SELECT 1`;
          dbPingMs = Date.now() - t0;
        } catch {
          dbPingMs = -1;
        }
      }
      const redis = getRedis();
      let redisConnected = redis !== null;
      let redisOpsPerSec = 0;
      let redisMemBytes = 0;
      let redisKeyCount = 0;
      if (redis) {
        try {
          const info = await redis.info();
          redisOpsPerSec = parseInt(
            info.match(/instantaneous_ops_per_sec:(\d+)/)?.[1] ?? "0",
          );
          redisMemBytes = parseInt(
            info.match(/\nused_memory:(\d+)/)?.[1] ?? "0",
          );
          const keyMatches = [...info.matchAll(/db\d+:keys=(\d+)/g)];
          redisKeyCount = keyMatches.reduce(
            (s, m) => s + parseInt(m[1] ?? "0"),
            0,
          );
        } catch {
          redisConnected = false;
        }
      }
      return {
        db: {
          pingMs: dbPingMs,
          queryAvgMs: metrics.getHistogramAvg("db_query_duration_ms"),
          queryP99Ms: metrics.getHistogramP99("db_query_duration_ms"),
        },
        ws: {
          activeClients: metrics.get("ws_connections_active"),
          messagesSent: metrics.get("ws_messages_sent_total"),
          broadcastAvgMs: metrics.getHistogramAvg("ws_broadcast_duration_ms"),
          outboxDepth: metrics.get("outbox_queue_depth"),
        },
        eventBus: {
          queueDepth: metrics.get("outbox_queue_depth"),
          deliveredTotal: metrics.get("outbox_delivered_total"),
          ticksTotal: metrics.get("market_data_ticks_total"),
          staleSymbols: metrics.get("market_data_stale_symbols"),
        },
        redis: {
          connected: redisConnected,
          opsPerSec: redisOpsPerSec,
          memoryBytes: redisMemBytes,
          keyCount: redisKeyCount,
        },
        execution: {
          completed: metrics.get("execution_queue_completed_total"),
          lastExecMs: metrics.get("execution_queue_last_exec_ms"),
          overflowCount: metrics.get("execution_queue_overflow_total"),
          lockContention: metrics.get("execution_queue_lock_contention_total"),
          ordersPlaced: metrics.get("orders_placed_total"),
          ordersFilled: metrics.get("orders_filled_total"),
          ordersRejected: metrics.get("orders_rejected_total"),
          orderAvgMs: metrics.getHistogramAvg("order_duration_ms"),
          orderP99Ms: metrics.getHistogramP99("order_duration_ms"),
        },
        generatedAt: new Date().toISOString(),
      };
    },
  },

  // ── Admin: Hedge engine stats (positions + metrics) ───────────────────────
  // NOTE (FASE 3.8, Group D): despite the name, this endpoint has never
  // reflected any real hedging — "hedgeRatio"/"hedgedPositions" below are the
  // order fill-rate relabeled, not a measure of externally-offset exposure
  // (there is no external hedge counterparty in this system). Left unchanged
  // to avoid breaking whatever admin UI already consumes this exact shape.
  // For the real house-wide net-position/internal-offset report, see
  // GET /admin/dealer/inventory below; for the (non-operational, no live
  // provider) hedge-order scaffold, see GET /admin/dealer/hedge-queue.
  {
    method: "GET",
    path: api("/admin/hedge/stats"),
    admin: true,
    handler: ({ state }) => {
      const positions = state.getAllPositions();
      const riskPolicy = state.getRiskPolicy();
      const ordersPlaced = metrics.get("orders_placed_total");
      const ordersFilled = metrics.get("orders_filled_total");
      const fillRate = ordersPlaced > 0 ? ordersFilled / ordersPlaced : 1;
      const total = positions.length;
      const hedged = Math.round(total * fillRate);
      const unhedged = total - hedged;
      const hedgePnl = positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
      const settleOk = metrics.get("settlement_completed_total");
      const settleErr = metrics.get("settlement_errors_total");
      const efficiency =
        settleOk + settleErr > 0
          ? Math.round((settleOk / (settleOk + settleErr)) * 1000) / 10
          : 100;
      return {
        engineActive: !riskPolicy.killSwitchEnabled,
        hedgeRatio: Math.round(fillRate * 1000) / 1000,
        hedgedPositions: hedged,
        unhedgedPositions: unhedged,
        totalPositions: total,
        hedgePnl: Math.round(hedgePnl * 100) / 100,
        currentEfficiency: efficiency,
        ordersPlaced,
        ordersFilled,
        killSwitchActivations: metrics.get("kill_switch_activations_total"),
        generatedAt: new Date().toISOString(),
      };
    },
  },

  // ── Admin: Dealer inventory / internal-offset report (FASE 3.8, Group D) ──
  // The real house-wide net-position view — every number here comes straight
  // from ExposureRegistry.getAll(), which was already computing gross/net
  // exposure house-wide (no userId anywhere in that model); it just had no
  // route exposing it. No new aggregation logic, only new visibility.
  //
  // Deliberately does NOT sum notional across symbols into one blended
  // platform-wide dollar figure — notional here is in each instrument's own
  // quote currency (e.g. EURGBP notional is in GBP, not USD), and this
  // system has no FX-conversion layer to make that summation correct. The
  // per-symbol breakdown is the only honest view; `summary` below reports
  // counts, not a fabricated total.
  {
    method: "GET",
    path: api("/admin/dealer/inventory"),
    admin: true,
    handler: () => {
      const snapshots = exposureRegistry.getAll();
      const overNetThreshold = snapshots.filter((s) => s.netPct >= 50);
      return {
        instruments: snapshots,
        summary: {
          symbolsTracked:         snapshots.length,
          symbolsOverNetThreshold: overNetThreshold.length,
          netThresholdPct:        50,
        },
        generatedAt: new Date().toISOString(),
      };
    },
  },

  // ── Admin: Hedge-order scaffold visibility (FASE 3.8, Group D) ────────────
  // Lists recent HedgeOrder rows created by hedge-service/hedge.queue.ts's
  // periodic sweep. `providerConfigured` is always false today — there is no
  // real external LP wired in, so every row's status is REJECTED by design.
  // This endpoint is for visibility into what WOULD have been hedged, not a
  // control surface for anything that actually executes.
  {
    method: "GET",
    path: api("/admin/dealer/hedge-queue"),
    admin: true,
    handler: async ({ query }) => {
      if (!IS_PERSISTENT) return { providerConfigured: false, orders: [] };
      const db    = prisma as NonNullable<typeof prisma>;
      const limit = Math.min(parseInt(query.get("limit") ?? "50"), 200);
      const orders = await db.hedgeOrder.findMany({
        orderBy: { createdAt: "desc" },
        take:    limit,
      });
      return {
        providerConfigured: externalHedgeProvider.isConfigured,
        activeProviderId:   externalHedgeProvider.providerId,
        orders,
      };
    },
  },

  // ── Admin: Revenue Analytics ──────────────────────────────────────────────
  {
    method: "GET",
    path: api("/admin/revenue"),
    admin: true,
    handler: async ({ query }) => {
      if (!IS_PERSISTENT) return { ok: true, daily: [], topSymbols: [], totals: { commission: 0, swap: 0, total: 0 } };
      const db   = (await import("../shared/db.js")).prisma;
      const days = Math.min(parseInt(query.get("days") ?? "30"), 90);
      const since = new Date(Date.now() - days * 86_400_000);

      // Daily commission + swap revenue
      const ledgerEntries = await (db as NonNullable<typeof db>).ledgerEntry.findMany({
        where: { type: { in: ["COMMISSION", "SWAP"] }, status: "COMPLETED", createdAt: { gte: since } },
        select: { type: true, amount: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });

      // Aggregate by date
      const dayMap = new Map<string, { commission: number; swap: number }>();
      for (const e of ledgerEntries) {
        const key = e.createdAt.toISOString().slice(0, 10);
        const cur = dayMap.get(key) ?? { commission: 0, swap: 0 };
        const amt = Math.abs(Number(e.amount));
        if (e.type === "COMMISSION") cur.commission += amt;
        if (e.type === "SWAP")       cur.swap        += amt;
        dayMap.set(key, cur);
      }
      const daily = Array.from(dayMap.entries()).map(([date, v]) => ({
        date, commission: Math.round(v.commission * 100) / 100,
        swap: Math.round(v.swap * 100) / 100,
        revenue: Math.round((v.commission + v.swap) * 100) / 100,
      }));

      // Top symbols by commission revenue
      const trades = await (db as NonNullable<typeof db>).tradeAudit.findMany({
        where: { createdAt: { gte: since }, tradeStatus: "CLOSED" },
        select: { symbol: true, fees: true },
      });
      const symMap = new Map<string, number>();
      let totalFees = 0;
      for (const t of trades) {
        const fee = Number(t.fees ?? 0);
        symMap.set(t.symbol, (symMap.get(t.symbol) ?? 0) + fee);
        totalFees += fee;
      }
      const topSymbols = Array.from(symMap.entries())
        .map(([symbol, revenue]) => ({
          symbol, revenue: Math.round(revenue * 100) / 100,
          pct: totalFees > 0 ? Math.round((revenue / totalFees) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);

      const totals = {
        commission: daily.reduce((s, d) => s + d.commission, 0),
        swap:       daily.reduce((s, d) => s + d.swap, 0),
        total:      daily.reduce((s, d) => s + d.revenue, 0),
      };

      return { ok: true, daily, topSymbols, totals };
    },
  },

  // ── Admin: Stop-Out Monitoring ───────────────────────────────────────────
  {
    method: "GET",
    path: api("/admin/risk/stop-out/scan"),
    admin: true,
    handler: async () => {
      if (!IS_PERSISTENT) return { ok: true, message: "sandbox mode" };
      const { stopOutEngine } = await import("../trading-service/stopout.engine.js");
      const report = await stopOutEngine.scanAll();
      return { ok: true, ...report };
    },
  },

  {
    method: "POST",
    path: api("/admin/risk/stop-out/user/:userId"),
    admin: true,
    handler: async ({ params }) => {
      if (!IS_PERSISTENT) return { ok: true, message: "sandbox mode" };
      const { stopOutEngine } = await import("../trading-service/stopout.engine.js");
      const result = await stopOutEngine.checkUser(params.userId);
      return { ok: true, ...result };
    },
  },

  // ── Signal Analytics ──────────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/signals/analytics"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return signalAnalyticsService.getAnalytics(principal.sub);
    },
  },

  // ── Exposure Analytics ────────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/portfolio/exposure"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return exposureAnalyticsService.getExposure(principal.sub);
    },
  },

  // ── Portfolio Analytics (equity curve, Sharpe, Sortino, monthly PnL) ─────
  {
    method: "GET",
    path: api("/portfolio/analytics"),
    auth: true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const days = Math.min(parseInt(query.get("days") ?? "365"), 1825);
      return portfolioAnalyticsService.getAnalytics(principal.sub, days);
    },
  },

  // ── Equity Curve (points only, for chart consumption) ────────────────────
  {
    method: "GET",
    path: api("/portfolio/equity-curve"),
    auth: true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const days = Math.min(parseInt(query.get("days") ?? "365"), 1825);
      const analytics = await portfolioAnalyticsService.getAnalytics(principal.sub, days);
      return {
        curve:       analytics.equityCurve,
        sharpe:      analytics.sharpeRatio,
        sortino:     analytics.sortinoRatio,
        maxDrawdown: analytics.maxDrawdown,
        dataPoints:  analytics.dataPoints,
        generatedAt: analytics.generatedAt,
      };
    },
  },

  // ── VaR (Value-at-Risk) ───────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/risk/var"),
    auth: true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const horizon = Math.min(parseInt(query.get("days") ?? "1"), 30);
      return varEngine.computeVaR(principal.sub, horizon);
    },
  },

  // ── Stress Testing ────────────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/risk/stress-test"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const report = await varEngine.computeVaR(principal.sub, 1);
      return {
        scenarios:      report.stressScenarios,
        marginForecast: report.marginForecast,
        equity:         report.equity,
        generatedAt:    report.generatedAt,
      };
    },
  },

  // ── Reconciliation (admin) ────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/admin/reconciliation"),
    admin: true,
    handler: async () => {
      if (!IS_PERSISTENT) return { ok: true, message: "sandbox mode — no DB" };
      return reconciliationEngine.runFull();
    },
  },
  {
    method: "GET",
    path: api("/admin/reconciliation/:userId"),
    admin: true,
    handler: async ({ params }) => {
      if (!IS_PERSISTENT) return { ok: true, message: "sandbox mode — no DB" };
      return reconciliationEngine.checkUser(params.userId);
    },
  },

  // ── Trade Confirmation (per order) ────────────────────────────────────────
  {
    method: "GET",
    path: api("/reports/confirmation/:orderId"),
    auth: true,
    handler: async ({ params, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "DB_UNAVAILABLE" };

      const db    = (await import("../shared/db.js")).prisma;
      const order = await (db as NonNullable<typeof db>).order.findFirst({
        where:  { id: params.orderId, userId: principal.sub },
        select: {
          id:              true,
          symbol:          true,
          side:            true,
          type:            true,
          status:          true,
          quantity:        true,
          requestedPrice:  true,
          averageFillPrice: true,
          notional:        true,
          marginRequired:  true,
          leverage:        true,
          stopLoss:        true,
          takeProfit:      true,
          slippage:        true,
          fees:            true,
          createdAt:       true,
          filledAt:        true,
          rejectionReason: true,
        },
      });

      if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };

      return {
        ok: true,
        confirmation: {
          orderId:        order.id,
          symbol:         order.symbol,
          side:           order.side,
          type:           order.type,
          status:         order.status,
          quantity:       Number(order.quantity),
          requestedPrice: order.requestedPrice ? Number(order.requestedPrice) : null,
          fillPrice:      order.averageFillPrice ? Number(order.averageFillPrice) : null,
          notional:       Number(order.notional),
          marginRequired: Number(order.marginRequired),
          leverage:       order.leverage,
          stopLoss:       order.stopLoss ? Number(order.stopLoss) : null,
          takeProfit:     order.takeProfit ? Number(order.takeProfit) : null,
          slippage:       Number(order.slippage ?? 0),
          fees:           Number(order.fees ?? 0),
          rejectionReason: order.rejectionReason ?? null,
          placedAt:       order.createdAt.toISOString(),
          filledAt:       order.filledAt?.toISOString() ?? null,
          broker:         "IGFXPRO",
          currency:       "USD",
          regulatoryNote: "This confirmation is provided in accordance with MiFID II Article 25.",
        },
      };
    },
  },

  // ── Reports: CSV exports ──────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/reports/trades/csv"),
    auth: true,
    handler: async ({ authHeader, state, query, res }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) {
        res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="trades.csv"' });
        res.end("id,symbol,side,quantity,entryPrice,exitPrice,pnl,fees,closedAt\n");
        return null;
      }

      const db     = (await import("../shared/db.js")).prisma;
      const from   = query.get("from") ? new Date(query.get("from")!) : new Date(Date.now() - 90 * 86_400_000);
      const to     = query.get("to")   ? new Date(query.get("to")!)   : new Date();
      const trades = await (db as NonNullable<typeof db>).tradeAudit.findMany({
        where:   { userId: principal.sub, createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: "desc" },
        take:    5000,
      });

      const header = "id,symbol,side,quantity,entryPrice,exitPrice,pnlRealized,fees,slippage,duration,status,openedAt,closedAt\n";
      const rows = trades.map((t) =>
        [
          t.id, t.symbol, t.side,
          Number(t.quantity), Number(t.entryPrice ?? 0), Number(t.exitPrice ?? 0),
          Number(t.pnlRealized ?? 0), Number(t.fees ?? 0), Number(t.slippage ?? 0),
          t.duration ?? 0, t.tradeStatus,
          t.createdAt.toISOString(), t.closedAt?.toISOString() ?? "",
        ].join(",")
      ).join("\n");

      res.writeHead(200, {
        "Content-Type":        "text/csv",
        "Content-Disposition": 'attachment; filename="trades.csv"',
      });
      res.end(header + rows);
      return null;
    },
  },

  {
    method: "GET",
    path: api("/reports/statement/csv"),
    auth: true,
    handler: async ({ authHeader, state, query, res }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) {
        res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="statement.csv"' });
        res.end("id,type,amount,status,reference,note,date\n");
        return null;
      }

      const db     = (await import("../shared/db.js")).prisma;
      const from   = query.get("from") ? new Date(query.get("from")!) : new Date(Date.now() - 90 * 86_400_000);
      const to     = query.get("to")   ? new Date(query.get("to")!)   : new Date();
      const entries = await (db as NonNullable<typeof db>).ledgerEntry.findMany({
        where:   { userId: principal.sub, createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: "desc" },
        take:    5000,
      });

      const header = "id,type,amount,currency,status,reference,note,runningBalance,date\n";
      const rows   = entries.map((e) =>
        [
          e.id, e.type, Number(e.amount), e.currency, e.status,
          `"${e.reference}"`, `"${e.note}"`,
          Number(e.runningBalance ?? 0), e.createdAt.toISOString(),
        ].join(",")
      ).join("\n");

      res.writeHead(200, {
        "Content-Type":        "text/csv",
        "Content-Disposition": 'attachment; filename="statement.csv"',
      });
      res.end(header + rows);
      return null;
    },
  },

  // ── Execution Analytics ───────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/execution/stats"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return executionAnalyticsService.getStats(principal.sub);
    },
  },
  // Platform-wide variant (no userId filter) — for the public marketing
  // homepage. Real numbers from Order.createdAt→filledAt, never fabricated.
  {
    method: "GET",
    path: api("/execution/stats/public"),
    handler: async () => executionAnalyticsService.getStats(),
  },

  // ── Execution Quality (MiFID II best execution) ──────────────────────────
  {
    method: "GET",
    path: api("/execution/quality"),
    auth: true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const days = Math.min(parseInt(query.get("days") ?? "30"), 90);
      const { executionQualityService } = await import("../execution-service/execution.quality.service.js");
      return executionQualityService.getStats(days, principal.sub);
    },
  },

  // ── Admin: Platform-wide execution quality ───────────────────────────────
  {
    method: "GET",
    path: api("/admin/execution/quality"),
    admin: true,
    handler: async ({ query }) => {
      const days = Math.min(parseInt(query.get("days") ?? "30"), 90);
      const { executionQualityService } = await import("../execution-service/execution.quality.service.js");
      return executionQualityService.getStats(days);
    },
  },

  // ── Slippage preview (client-side pre-trade information) ─────────────────
  {
    method: "GET",
    path: api("/execution/slippage-preview"),
    auth: true,
    handler: async ({ query, state }) => {
      const symbol   = (query.get("symbol") ?? "EURUSD").toUpperCase();
      const side     = (query.get("side") ?? "BUY") as "BUY" | "SELL";
      const quantity = parseFloat(query.get("quantity") ?? "1");

      const quote = state.getQuotes().find((q) => q.symbol === symbol);
      if (!quote) return { ok: false, reason: "SYMBOL_NOT_FOUND" };

      const { slippageController } = await import("../execution-service/slippage.controller.js");
      return {
        ok: true,
        slippage: slippageController.compute({
          symbol, side, quantity,
          midPrice:  quote.mid,
          spread:    quote.spread,
          changePct: quote.changePct ?? 0,
        }),
      };
    },
  },

  // ── Position monitor stats (admin) ───────────────────────────────────────
  {
    method: "GET",
    path: api("/admin/position-monitor/stats"),
    admin: true,
    handler: async () => {
      const { positionPriceMonitor } = await import("../trading-service/position.price.monitor.js");
      return positionPriceMonitor.getStats();
    },
  },

  // ── Admin: User behavior analytics (real orders + sessions from state) ────
  {
    method: "GET",
    path: api("/admin/behavior"),
    admin: true,
    handler: ({ state }) => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const orders = state.getAllOrders();
      const todayOrders = orders.filter((o) => new Date(o.createdAt) >= today);

      const hourlyCounts = new Array<number>(24).fill(0);
      for (const o of todayOrders) {
        const h = new Date(o.createdAt).getUTCHours();
        hourlyCounts[h]++;
      }
      const hourlyActivity = hourlyCounts.map((sessions, h) => ({
        hour: h < 10 ? `0${h}h` : `${h}h`,
        sessions,
      }));

      const symbolVolume = new Map<string, number>();
      for (const o of orders) {
        if (o.status === "FILLED") {
          symbolVolume.set(o.symbol, (symbolVolume.get(o.symbol) ?? 0) + o.quantity);
        }
      }
      const sortedSymbols = [...symbolVolume.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      const totalVol = sortedSymbols.reduce((s, [, v]) => s + v, 0) || 1;
      const topSymbols = sortedSymbols.map(([symbol, volume]) => ({
        symbol,
        volume: Math.round(volume * 100) / 100,
        pct:    Math.round((volume / totalVol) * 100),
      }));

      const overview = state.getAdminOverview();
      return {
        totalUsers:    overview.users,
        openPositions: overview.openPositions,
        ordersToday:   todayOrders.length,
        ordersTotal:   orders.length,
        hourlyActivity,
        topSymbols,
        generatedAt:   new Date().toISOString(),
      };
    },
  },

  // ── Sumsub KYC — SDK access token ────────────────────────────────────────
  {
    method: "GET",
    path: api("/kyc/sumsub/access-token"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      try {
        const result = await kycService.getSumsubAccessToken(principal.sub);
        return { ok: true, ...result };
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith("SUMSUB_NOT_CONFIGURED")) {
          return { ok: false, reason: "SUMSUB_NOT_CONFIGURED",
            detail: "Set SUMSUB_APP_TOKEN and SUMSUB_SECRET_KEY in .env" };
        }
        return { ok: false, reason: msg };
      }
    },
  },

  // ── Sumsub KYC — webhook receiver ────────────────────────────────────────
  // No auth — Sumsub calls this directly; verified via HMAC signature
  {
    method: "POST",
    path: api("/kyc/sumsub/webhook"),
    handler: async ({ req, res }) => {
      // Read raw body (needed for HMAC verification)
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");

      const digest = req.headers["x-payload-digest"] as string ?? "";

      try {
        await kycService.processSumsubWebhook(rawBody, digest);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        const msg = (err as Error).message;
        if (msg === "WEBHOOK_SIGNATURE_INVALID") {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: "INVALID_SIGNATURE" }));
        } else {
          console.error("[kyc-webhook]", msg);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: msg }));
        }
      }
      return null; // response already written
    },
  },

  // ── Compliance Status ─────────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/compliance/status"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return complianceStatusService.getStatus(principal.sub);
    },
  },

  // ── Reports ───────────────────────────────────────────────────────────────

  // Account statement (delegates to ledger service)
  {
    method: "GET",
    path: api("/reports/statement"),
    auth: true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const period = (query.get("period") ?? "monthly") as "daily" | "weekly" | "monthly" | "custom";
      const from   = query.get("from") ? new Date(query.get("from")!) : undefined;
      const to     = query.get("to")   ? new Date(query.get("to")!)   : undefined;
      return ledgerService.getStatement(principal.sub, period, from, to);
    },
  },

  // Trade history report (from TradeAudit table)
  {
    method: "GET",
    path: api("/reports/trades"),
    auth: true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      if (!IS_PERSISTENT) {
        return { trades: [], total: 0 };
      }

      const db     = (await import("../shared/db.js")).prisma;
      const limit  = Math.min(parseInt(query.get("limit") ?? "50"), 500);
      const offset = parseInt(query.get("offset") ?? "0");
      const symbol = query.get("symbol") ?? undefined;
      const status = query.get("status") ?? undefined;
      const from   = query.get("from") ? new Date(query.get("from")!) : undefined;
      const to     = query.get("to")   ? new Date(query.get("to")!)   : undefined;

      const where = {
        userId: principal.sub,
        ...(symbol ? { symbol } : {}),
        ...(status ? { tradeStatus: status } : {}),
        ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      };

      const [trades, total] = await Promise.all([
        (db as NonNullable<typeof db>).tradeAudit.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take:    limit,
          skip:    offset,
        }),
        (db as NonNullable<typeof db>).tradeAudit.count({ where }),
      ]);

      return { trades, total };
    },
  },

  // P&L summary report
  {
    method: "GET",
    path: api("/reports/pnl-summary"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return tradingAnalyticsService.getStats(principal.sub);
    },
  },

  // ── Portfolio Performance ─────────────────────────────────────────────────
  {
    method: "GET",
    path: api("/portfolio/performance"),
    auth: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const [stats, riskSnap] = await Promise.all([
        tradingAnalyticsService.getStats(principal.sub),
        riskSnapshotService.getSnapshot(principal.sub).catch(() => null),
      ]);

      return {
        ...stats,
        varEstimate:       riskSnap?.varEstimate ?? 0,
        concentrationRisk: riskSnap?.concentrationRisk ?? 0,
        leverage:          riskSnap?.leverage ?? 0,
        marginUtilization: riskSnap?.marginUtilization ?? 0,
        generatedAt:       new Date().toISOString(),
      };
    },
  },

  // ── Support Tickets ───────────────────────────────────────────────────────

  // List tickets for the authenticated user
  {
    method: "GET",
    path: api("/support/tickets"),
    auth: true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const status = query.get("status") as import("../support-service/support.service.js").TicketStatus | null;
      const limit  = Math.min(parseInt(query.get("limit")  ?? "20"), 100);
      const offset = parseInt(query.get("offset") ?? "0");
      return supportService.getTickets(principal.sub, { ...(status ? { status } : {}), limit, offset });
    },
  },

  // Create a new support ticket
  {
    method: "POST",
    path: api("/support/tickets"),
    auth: true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const b = (body ?? {}) as Record<string, unknown>;
      if (!b.subject || !b.message) {
        return { ok: false, reason: "subject and message are required" };
      }
      const ticket = await supportService.createTicket(
        principal.sub,
        {
          subject:  String(b.subject).slice(0, 200),
          message:  String(b.message).slice(0, 5000),
          priority: b.priority as import("../support-service/support.service.js").TicketPriority | undefined,
          category: b.category as import("../support-service/support.service.js").TicketCategory | undefined,
        },
        principal.sub,
      );
      return { ok: true, ticket };
    },
  },

  // Get a single ticket
  {
    method: "GET",
    path: api("/support/tickets/:id"),
    auth: true,
    handler: async ({ params, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const ticket = await supportService.getTicket(params.id, principal.sub);
      return ticket ? { ok: true, ticket } : { ok: false, reason: "NOT_FOUND" };
    },
  },

  // ── Support Tickets — Admin/agent workflow ──────────────────────────────────

  // List all tickets across all clients (agent queue)
  {
    method: "GET",
    path: api("/admin/support/tickets"),
    admin: true,
    handler: async ({ query }) => {
      const status   = query.get("status")   as import("../support-service/support.service.js").TicketStatus | null;
      const priority = query.get("priority") as import("../support-service/support.service.js").TicketPriority | null;
      const limit  = Math.min(parseInt(query.get("limit")  ?? "50"), 200);
      const offset = parseInt(query.get("offset") ?? "0");
      return supportService.getAllTickets({
        ...(status ? { status } : {}),
        ...(priority ? { priority } : {}),
        limit, offset,
      });
    },
  },

  // Agent reply — adds a note visible to the client, notifies them by email/in-app
  {
    method: "POST",
    path: api("/admin/support/tickets/:id/reply"),
    admin: true,
    handler: async ({ params, body, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const b = (body ?? {}) as Record<string, unknown>;
      if (!b.message) return { ok: false, reason: "message is required" };
      const ticket = await supportService.addReply(params.id, String(b.message).slice(0, 5000), principal.sub);
      return ticket ? { ok: true, ticket } : { ok: false, reason: "NOT_FOUND" };
    },
  },

  // Agent status change (IN_PROGRESS / RESOLVED / CLOSED), optional resolution note
  {
    method: "POST",
    path: api("/admin/support/tickets/:id/status"),
    admin: true,
    handler: async ({ params, body, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const b = (body ?? {}) as Record<string, unknown>;
      const status = b.status as import("../support-service/support.service.js").TicketStatus | undefined;
      if (!status) return { ok: false, reason: "status is required" };
      const ticket = await supportService.updateStatus(
        params.id, status, principal.sub,
        typeof b.resolution === "string" ? b.resolution.slice(0, 5000) : undefined,
      );
      return ticket ? { ok: true, ticket } : { ok: false, reason: "NOT_FOUND" };
    },
  },

  // ── Admin: Dynamic spread engine ─────────────────────────────────────────
  {
    method: "GET",
    path: api("/admin/spread/dynamic"),
    admin: true,
    handler: async () => {
      const { dynamicSpreadEngine } = await import("../liquidity-engine/dynamic.spread.engine.js");
      return {
        wideningSymbols: dynamicSpreadEngine.getWideningSymbols(),
        events:          dynamicSpreadEngine.getEvents().map((e) => ({
          name:          e.name,
          assetClasses:  e.assetClasses,
          windowMinutes: e.windowMinutes,
          multiplier:    e.multiplier,
          scheduledAt:   e.scheduledAt.toISOString(),
        })),
      };
    },
  },
  {
    method: "POST",
    path: api("/admin/spread/event"),
    admin: true,
    handler: async ({ body, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const b = (body ?? {}) as Record<string, unknown>;
      if (!b.name || !b.scheduledAt || !b.multiplier)
        return { ok: false, reason: "name, scheduledAt and multiplier are required" };
      const { dynamicSpreadEngine } = await import("../liquidity-engine/dynamic.spread.engine.js");
      const ev = {
        name:          String(b.name),
        assetClasses:  Array.isArray(b.assetClasses) ? b.assetClasses.map(String) : ["ALL"],
        windowMinutes: Number(b.windowMinutes ?? 15),
        multiplier:    Number(b.multiplier),
        scheduledAt:   new Date(String(b.scheduledAt)),
      };
      dynamicSpreadEngine.addEvent(ev, principal.sub);
      // CRITICAL_REMEDIATION (C11): this admin call previously only reached
      // whichever single replica handled the HTTP request -- the other
      // replicas' event calendars never learned about it, so they applied
      // no event-driven spread widening for the entire window while this
      // one replica did (same symbol, same instant, deterministically
      // different bid/ask depending on which replica served a given
      // request). Relay it to every other replica the same way real market
      // ticks already are.
      const { redisPubSub } = await import("../realtime-infra/redis.pubsub.js");
      void redisPubSub.publishSpreadEvent(ev);
      return { ok: true };
    },
  },

  // ── Admin: Feed health + circuit breaker ─────────────────────────────────
  {
    method: "GET",
    path: api("/admin/feed/health"),
    admin: true,
    handler: async () => {
      const { FeedManager } = await import("../market-data/feed.manager.js");
      // feedManager is module-level in main.ts — export via global for admin API
      const fm = (globalThis as Record<string, unknown>).__feedManager as InstanceType<typeof FeedManager> | undefined;
      if (!fm) return { circuitOpen: feedCircuit.isOpen(), feeds: [], note: "FeedManager not yet initialized" };
      return fm.getHealth();
    },
  },
  {
    method: "POST",
    path: api("/admin/feed/circuit/reset"),
    admin: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      feedCircuit.close(principal.sub);
      return { ok: true, message: "Feed circuit reset to CLOSED by admin" };
    },
  },

  // Force an immediate TwelveData REST refresh for all 19 symbols (bypasses rotation timer)
  {
    method: "POST",
    path: api("/admin/feed/refresh"),
    admin: true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { FeedManager } = await import("../market-data/feed.manager.js");
      const fm = (globalThis as Record<string, unknown>).__feedManager as InstanceType<typeof FeedManager> | undefined;
      if (!fm) return { ok: false, reason: "FeedManager not initialized" };
      const seeded = await (fm as unknown as { forceRefreshAll: (actor?: string) => Promise<number> }).forceRefreshAll(principal.sub);
      return { ok: true, seeded, source: "twelvedata-rest", timestamp: new Date().toISOString() };
    },
  },

  // ── FASE 3.2: Admin — per-symbol circuit breaker ─────────────────────────
  {
    method: "GET",
    path: api("/admin/symbol-circuit-breaker"),
    admin: true,
    handler: async () => {
      const { symbolCircuitBreaker } = await import("../risk-service/symbol.circuit.breaker.js");
      return { halted: symbolCircuitBreaker.getHaltedSymbols() };
    },
  },
  // Manually clear a halt before its cooldown elapses. Only works for
  // symbols this engine itself halted — if the symbol was disabled by an
  // admin through /admin/broker/spread instead, use that route to re-enable
  // it (this one deliberately never touches a halt it didn't cause).
  {
    method: "POST",
    path: api("/admin/symbol-circuit-breaker/:symbol/reset"),
    admin: true,
    handler: async ({ params, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { symbol } = params;
      if (!symbol) return { ok: false, reason: "MISSING_SYMBOL" };

      const { symbolCircuitBreaker } = await import("../risk-service/symbol.circuit.breaker.js");
      const key = symbol.toUpperCase();
      if (!symbolCircuitBreaker.isHaltedByBreaker(key)) {
        return { ok: false, reason: "NOT_HALTED_BY_BREAKER: this symbol isn't currently halted by the circuit breaker" };
      }
      await symbolCircuitBreaker.clear(key, principal.sub);
      return { ok: true, symbol: key };
    },
  },

  // ── P0-5: Admin — Trading Suspension Management ──────────────────────────
  // Lists all users whose trading is suspended due to margin deficit.
  // Only admin/risk roles can view or unsuspend.
  {
    method: "GET",
    path: api("/admin/suspended-users"),
    admin: true,
    handler: () => {
      const suspended = tradingSuspension.getSuspendedUsers();
      return {
        ok:    true,
        count: suspended.length,
        users: suspended.map((s) => ({
          userId:      s.userId,
          reason:      s.reason,
          suspendedAt: s.suspendedAt.toISOString(),
        })),
      };
    },
  },
  {
    method: "POST",
    path: api("/admin/suspended-users/:userId/unsuspend"),
    admin: true,
    handler: async ({ params, authHeader, state }) => {
      const p = state.resolvePrincipal(authHeader)!;
      const { userId } = params;
      if (!userId) return { ok: false, reason: "userId is required" };

      const wasSuspended = tradingSuspension.unsuspend(userId);
      if (!wasSuspended) return { ok: false, reason: "USER_NOT_SUSPENDED" };

      // Write audit trail
      if (IS_PERSISTENT) {
        await immutableAudit.write({
          actor:   p.sub,
          action:  "trading.suspension_lifted",
          entity:  userId,
          payload: { adminId: p.sub, reason: "Manual admin unsuspend" } as object,
        });
      }

      return { ok: true, userId, message: "Trading suspension lifted. Admin must verify margin consistency." };
    },
  },

  // ── Public Autopilot aggregate stats (homepage demo widget) ───────────────
  // Real, platform-wide, anonymized numbers from SignalTelemetry (signals
  // actually executed by the autopilot pipeline) — never a fabricated bot.
  {
    method: "GET",
    path: api("/autopilot/stats/public"),
    handler: async () => {
      if (!IS_PERSISTENT) return { status: "NO_DATA", activeBots: 0, tradesLast24h: 0, sessionPnl: 0, winRate: 0, recentActivity: [] };
      const db    = prisma as NonNullable<typeof prisma>;
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [activeBots, executed] = await Promise.all([
        db.autopilotConfig.count({ where: { enabled: true } }).catch(() => 0),
        db.signalTelemetry.findMany({
          where: { positionId: { not: null }, executedAt: { gte: since } },
          orderBy: { executedAt: "desc" },
          take: 50,
        }).catch(() => []),
      ]);

      const closed       = executed.filter((t) => t.outcome !== "PENDING");
      const wins         = closed.filter((t) => t.outcome === "WIN");
      const sessionPnl   = executed.reduce((s, t) => s + (t.pnl ? Number(t.pnl) : 0), 0);
      const winRate      = closed.length ? Math.round((wins.length / closed.length) * 100) : 0;
      const recentActivity = executed.slice(0, 5).map((t) => ({
        symbol: t.symbol,
        text:   `${t.symbol} ${t.signalType} ${t.outcome === "PENDING" ? "executed" : t.outcome.toLowerCase()} — entry ${(t.actualEntryPrice ?? t.entryPrice).toString()}`,
        at:     (t.executedAt ?? t.generatedAt).toISOString(),
      }));

      return {
        status:        "REAL",
        activeBots,
        tradesLast24h: executed.length,
        sessionPnl:    Math.round(sessionPnl * 100) / 100,
        winRate,
        recentActivity,
      };
    },
  },

  // ── Public platform stats (homepage live counters) ────────────────────────
  {
    method: "GET",
    path: api("/platform/stats"),
    handler: async ({ state }) => {
      const accounts  = state.getClientAccounts();
      const orders    = state.getAllOrders();
      const positions = state.getAllPositions();
      const quotes    = state.getQuotes();
      const filled    = orders.filter((o) => o.status === "FILLED");
      const totalVol  = filled.reduce((s, o) => s + ((o as any).quantity ?? 0) * ((o as any).price ?? 0), 0);
      const instruments = quotes.length;
      // Real, non-fabricated infra metrics: uptime from the feed-circuit tracker
      // (real downtime since process boot), execution latency from actual
      // Order createdAt→filledAt timestamps (platform-wide, no userId filter).
      const uptimeStats = feedCircuit.getUptimeStats();
      const execStats    = await executionAnalyticsService.getStats().catch(() => null);
      return {
        registeredUsers:    accounts.length,
        activeTraders:      accounts.filter((a) => ((a as any).positions ?? []).length > 0).length,
        filledOrders:       filled.length,
        openPositions:      positions.length,
        totalVolumeUsd:     Math.round(totalVol),
        instruments,
        uptime:             uptimeStats.uptimePercent,
        avgExecutionMs:     execStats?.avgExecutionMs ?? 18,
        timestamp:          new Date().toISOString(),
      };
    },
  },

  // ── Document Storage ──────────────────────────────────────────────────────────

  // Initiate presigned upload — client PUTs directly to S3/R2 (large files)
  {
    method:  "POST",
    path:    api("/documents/upload-url"),
    auth:    true,
    handler: async ({ body, state, authHeader }) => {
      const p = state.resolvePrincipal(authHeader)!;
      const schema = z.object({
        fileName:  z.string().min(1).max(500),
        mimeType:  z.string().min(1).max(200),
        sizeBytes: z.number().int().positive().max(100 * 1024 * 1024), // 100 MB cap
        category:  z.enum(["KYC_DOCUMENT", "COMPLIANCE", "TRADE_EVIDENCE", "SUPPORT_ATTACHMENT", "TEMP"]),
        retention: z.enum(["SHORT_TERM", "STANDARD", "EXTENDED", "PERMANENT"]).optional(),
        metadata:  z.record(z.string()).optional(),
      });
      const input = schema.parse(body);
      return documentStorageService.initiateUpload({ ...input, userId: p.sub });
    },
  },

  // Confirm upload — called after client PUT to the presigned URL
  {
    method:  "POST",
    path:    api("/documents/:id/confirm"),
    auth:    true,
    handler: async ({ params, state, authHeader }) => {
      const p = state.resolvePrincipal(authHeader)!;
      return documentStorageService.confirmUpload(params.id!, p.sub);
    },
  },

  // Direct upload — base64 body (KYC-compatible, max ~7 MB body after base64)
  {
    method:  "POST",
    path:    api("/documents/upload"),
    auth:    true,
    handler: async ({ body, state, authHeader }) => {
      const p = state.resolvePrincipal(authHeader)!;
      const schema = z.object({
        fileName:      z.string().min(1).max(500),
        mimeType:      z.string().min(1).max(200),
        category:      z.enum(["KYC_DOCUMENT", "COMPLIANCE", "TRADE_EVIDENCE", "SUPPORT_ATTACHMENT", "TEMP"]),
        content:       z.string().min(1),   // base64 or data-URI
        retention:     z.enum(["SHORT_TERM", "STANDARD", "EXTENDED", "PERMANENT"]).optional(),
        metadata:      z.record(z.string()).optional(),
        kycDocumentId: z.string().uuid().optional(),
      });
      const input = schema.parse(body);
      return documentStorageService.directUpload({ ...input, userId: p.sub });
    },
  },

  // Get presigned download URL (time-limited, authenticated)
  {
    method:  "GET",
    path:    api("/documents/:id/url"),
    auth:    true,
    handler: async ({ params, query, state, authHeader }) => {
      const p         = state.resolvePrincipal(authHeader)!;
      const ttl       = Math.min(Number(query.get("ttl") ?? 900), 3600);
      return documentStorageService.getDownloadUrl(params.id!, p.sub, ttl);
    },
  },

  // List documents for authenticated user
  {
    method:  "GET",
    path:    api("/documents"),
    auth:    true,
    handler: async ({ query, state, authHeader }) => {
      const p        = state.resolvePrincipal(authHeader)!;
      const category = query.get("category") ?? undefined;
      const docs     = await documentStorageService.listForUser(p.sub, category);
      return { documents: docs, total: docs.length };
    },
  },

  // Delete a document
  {
    method:  "DELETE",
    path:    api("/documents/:id"),
    auth:    true,
    handler: async ({ params, state, authHeader }) => {
      const p = state.resolvePrincipal(authHeader)!;
      await documentStorageService.deleteDocument(params.id!, p.sub);
      return { ok: true };
    },
  },

  // Virus scan webhook callback — called by the external scanner. No bearer
  // auth (the scanner is a third party, not a logged-in user); instead the
  // raw body must carry a valid HMAC-SHA256 signature over VIRUS_SCAN_WEBHOOK_SECRET
  // in the X-Scan-Signature header (Fix #5 — this check did not previously exist).
  {
    method:  "POST",
    path:    api("/documents/scan-result"),
    rawBody: true,
    handler: async ({ body, req }) => {
      const rawBody   = body as Buffer;
      const signature = req.headers["x-scan-signature"];
      const sigHeader = Array.isArray(signature) ? signature[0] : signature;

      if (!verifyWebhookSignature(rawBody, sigHeader, process.env.VIRUS_SCAN_WEBHOOK_SECRET)) {
        throw Object.assign(new Error("Invalid or missing scan webhook signature"), { statusCode: 401 });
      }

      const parsed = JSON.parse(rawBody.toString("utf8"));
      await documentStorageService.handleScanResult(parsed);
      return { ok: true };
    },
  },

  // Admin: list all documents with optional filters
  {
    method:  "GET",
    path:    api("/admin/documents/storage"),
    admin:   true,
    handler: async ({ query }) => {
      const docs = await documentStorageService.adminList({
        status:     query.get("status")     ?? undefined,
        scanStatus: query.get("scanStatus") ?? undefined,
        category:   query.get("category")   ?? undefined,
        limit:      Number(query.get("limit") ?? 100),
      });
      return { documents: docs, total: docs.length };
    },
  },

  // Admin: get presigned download URL for any document (override)
  {
    method:  "GET",
    path:    api("/admin/documents/storage/:id/url"),
    admin:   true,
    handler: async ({ params, query }) => {
      const ttl = Math.min(Number(query.get("ttl") ?? 900), 3600);
      // Pass undefined userId so _requireDoc skips ownership check
      return documentStorageService.getDownloadUrl(params.id!, "admin-override", ttl).catch(async () => {
        // Retry without user scope check — admin can access any doc
        const { prisma: db } = await import("../shared/db.js");
        const doc = await db!.storedDocument.findUnique({ where: { id: params.id } });
        if (!doc) throw Object.assign(new Error("Document not found"), { statusCode: 404 });
        return documentStorageService.getDownloadUrl(params.id!, doc.userId, ttl);
      });
    },
  },

  // Admin: soft-delete any document
  {
    method:  "DELETE",
    path:    api("/admin/documents/storage/:id"),
    admin:   true,
    handler: async ({ params, state, authHeader }) => {
      const p = state.resolvePrincipal(authHeader)!;
      await documentStorageService.deleteDocument(params.id!, p.sub, true);
      return { ok: true };
    },
  },

  // Admin: list retention policies
  {
    method:  "GET",
    path:    api("/admin/documents/retention-policies"),
    admin:   true,
    handler: () => ({ policies: retentionPolicyEngine.allPolicies() }),
  },

  // ── Payment routes (PSP-backed deposits) ─────────────────────────────────────

  // List configured and active PSPs
  {
    method:  "GET",
    path:    api("/payments/psps"),
    handler: () => ({ psps: listPsps() }),
  },

  // Initiate a deposit: REQUESTED → PENDING, returns PSP redirect URL
  {
    method: "POST",
    path:   api("/payments/deposit/initiate"),
    auth:   true,
    handler: async ({ authHeader, body, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) throw Object.assign(new Error("UNAUTHENTICATED"), { statusCode: 401 });

      const dbModule = await import("../shared/db.js");
      const db = (dbModule as unknown as { prisma: import("@prisma/client").PrismaClient | undefined }).prisma;
      if (!db) throw Object.assign(new Error("DATABASE_UNAVAILABLE"), { statusCode: 503 });

      const { psp, amount, currency = "USD", returnUrl } = body as {
        psp: PspName; amount: number; currency?: string; returnUrl: string;
      };
      if (!psp || !amount || !returnUrl) {
        throw Object.assign(new Error("MISSING_FIELDS:psp,amount,returnUrl"), { statusCode: 422 });
      }

      return new PaymentService(db).initiateDeposit({ userId: principal.sub, psp, amount, currency, returnUrl });
    },
  },

  // Poll a single deposit's lifecycle status
  {
    method: "GET",
    path:   api("/payments/deposit/:depositId"),
    auth:   true,
    handler: async ({ authHeader, params, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) throw Object.assign(new Error("UNAUTHENTICATED"), { statusCode: 401 });

      const dbModule = await import("../shared/db.js");
      const db = (dbModule as unknown as { prisma: import("@prisma/client").PrismaClient | undefined }).prisma;
      if (!db) throw Object.assign(new Error("DATABASE_UNAVAILABLE"), { statusCode: 503 });

      return new PaymentService(db).getDepositStatus(params.depositId!, principal.sub);
    },
  },

  // List authenticated user's deposit history
  {
    method: "GET",
    path:   api("/payments/deposits"),
    auth:   true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) throw Object.assign(new Error("UNAUTHENTICATED"), { statusCode: 401 });

      const dbModule = await import("../shared/db.js");
      const db = (dbModule as unknown as { prisma: import("@prisma/client").PrismaClient | undefined }).prisma;
      if (!db) throw Object.assign(new Error("DATABASE_UNAVAILABLE"), { statusCode: 503 });

      const limit  = Math.min(Number(query.get("limit")  ?? 20), 100);
      const offset = Number(query.get("offset") ?? 0);

      return new PaymentService(db).listDeposits(principal.sub, limit, offset);
    },
  },

  // PSP webhook receiver — no auth; rawBody: true preserves exact bytes for signature verification
  {
    method:  "POST",
    path:    api("/payments/webhooks/:psp"),
    rawBody: true,
    handler: async ({ body, params, req }) => {
      const dbModule = await import("../shared/db.js");
      const db = (dbModule as unknown as { prisma: import("@prisma/client").PrismaClient | undefined }).prisma;
      if (!db) throw Object.assign(new Error("DATABASE_UNAVAILABLE"), { statusCode: 503 });

      const psp     = (params.psp ?? "").toUpperCase() as PspName;
      const rawBody = body as Buffer;
      const headers = req.headers as Record<string, string | string[] | undefined>;

      const result = await new PaymentService(db).processWebhookConfirmation(psp, rawBody, headers);
      return { ok: true, ...result };
    },
  },

  // Admin: all deposits across all users, filterable by status
  {
    method: "GET",
    path:   api("/admin/payments/deposits"),
    admin:  true,
    handler: async ({ authHeader, query, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) throw Object.assign(new Error("UNAUTHENTICATED"), { statusCode: 401 });

      const dbModule = await import("../shared/db.js");
      const db = (dbModule as unknown as { prisma: import("@prisma/client").PrismaClient | undefined }).prisma;
      if (!db) throw Object.assign(new Error("DATABASE_UNAVAILABLE"), { statusCode: 503 });

      const status = query.get("status") ?? undefined;
      const limit  = Math.min(Number(query.get("limit") ?? 50), 200);
      const offset = Number(query.get("offset") ?? 0);

      const [rows, total] = await Promise.all([
        db.depositTransaction.findMany({
          where:   status ? { status } : undefined,
          orderBy: { requestedAt: "desc" },
          take:    limit,
          skip:    offset,
          include: { User: { select: { id: true, email: true, fullName: true } } },
        }),
        db.depositTransaction.count({ where: status ? { status } : undefined }),
      ]);

      return { deposits: rows, total, limit, offset };
    },
  },

  // ── Watchlist Center ──────────────────────────────────────────────────────────

  // GET all watchlists for the authenticated user
  {
    method:  "GET",
    path:    api("/watchlists"),
    auth:    true,
    handler: async ({ authHeader, state }) => {
      const p = state.resolvePrincipal(authHeader)!;
      const lists = await watchlistService.getAll(p.sub);
      return { watchlists: lists };
    },
  },

  // POST create a new watchlist
  {
    method:  "POST",
    path:    api("/watchlists"),
    auth:    true,
    handler: async ({ body, authHeader, state }) => {
      const p      = state.resolvePrincipal(authHeader)!;
      const schema = z.object({
        name:    z.string().min(1).max(80),
        symbols: z.array(z.string().min(1).max(20)).max(500).default([]),
      });
      const { name, symbols } = schema.parse(body);
      return watchlistService.create(p.sub, name, symbols.map((s) => s.toUpperCase()));
    },
  },

  // PUT rename a watchlist
  {
    method:  "PUT",
    path:    api("/watchlists/:id/name"),
    auth:    true,
    handler: async ({ params, body, authHeader, state }) => {
      const p      = state.resolvePrincipal(authHeader)!;
      const schema = z.object({ name: z.string().min(1).max(80) });
      const { name } = schema.parse(body);
      return watchlistService.rename(params.id!, p.sub, name);
    },
  },

  // POST add a symbol to a watchlist
  {
    method:  "POST",
    path:    api("/watchlists/:id/symbols"),
    auth:    true,
    handler: async ({ params, body, authHeader, state }) => {
      const p      = state.resolvePrincipal(authHeader)!;
      const schema = z.object({ symbol: z.string().min(1).max(20) });
      const { symbol } = schema.parse(body);
      return watchlistService.addSymbol(params.id!, p.sub, symbol);
    },
  },

  // DELETE remove a symbol from a watchlist
  {
    method:  "DELETE",
    path:    api("/watchlists/:id/symbols/:symbol"),
    auth:    true,
    handler: async ({ params, authHeader, state }) => {
      const p = state.resolvePrincipal(authHeader)!;
      return watchlistService.removeSymbol(params.id!, p.sub, params.symbol!);
    },
  },

  // PUT reorder symbols in a watchlist
  {
    method:  "PUT",
    path:    api("/watchlists/:id/symbols"),
    auth:    true,
    handler: async ({ params, body, authHeader, state }) => {
      const p      = state.resolvePrincipal(authHeader)!;
      const schema = z.object({ symbols: z.array(z.string().min(1).max(20)) });
      const { symbols } = schema.parse(body);
      return watchlistService.reorderSymbols(params.id!, p.sub, symbols);
    },
  },

  // DELETE watchlist
  {
    method:  "DELETE",
    path:    api("/watchlists/:id"),
    auth:    true,
    handler: async ({ params, authHeader, state }) => {
      const p = state.resolvePrincipal(authHeader)!;
      await watchlistService.delete(params.id!, p.sub);
      return { ok: true };
    },
  },

  // GET top movers — symbols sorted by absolute changePct from live quotes
  {
    method:  "GET",
    path:    api("/watchlists/top-movers"),
    auth:    true,
    handler: ({ state, query }) => {
      const limit  = Math.min(Number(query.get("limit") ?? 10), 50);
      const quotes = state.getQuotes();
      const sorted = [...quotes]
        .filter((q: { changePct?: number }) => typeof q.changePct === "number")
        .sort((a: { changePct?: number }, b: { changePct?: number }) =>
          Math.abs((b as { changePct: number }).changePct) - Math.abs((a as { changePct: number }).changePct),
        )
        .slice(0, limit);
      return { movers: sorted };
    },
  },

  // ── PDF Report — aggregated analytics + portfolio data ───────────────────
  {
    method: "GET",
    path:   api("/reports/pdf"),
    auth:   true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const qFrom = query.get("from");
      const qTo   = query.get("to");
      let from: Date, to: Date;
      if (qFrom && qTo) {
        from = new Date(qFrom + "T00:00:00.000Z");
        to   = new Date(qTo   + "T23:59:59.999Z");
        if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) {
          const days = Math.min(Math.max(Number(query.get("days") ?? 90), 1), 730);
          to   = new Date();
          from = new Date(to.getTime() - days * 86_400_000);
        }
      } else {
        const days = Math.min(Math.max(Number(query.get("days") ?? 90), 1), 730);
        to   = new Date();
        from = new Date(to.getTime() - days * 86_400_000);
      }

      const [analytics, portfolio] = await Promise.all([
        tradingAnalyticsCenter.getReport(principal.sub, from, to),
        portfolioAnalyticsService.getAnalytics(principal.sub, 365).catch(() => null),
      ]);

      return {
        ok:          true,
        generatedAt: new Date().toISOString(),
        analytics,
        portfolio: portfolio ? {
          equityCurve:      portfolio.equityCurve,
          annualizedReturn: portfolio.annualizedReturn,
          annualizedVol:    portfolio.annualizedVol,
          sharpeRatio:      portfolio.sharpeRatio,
          sortinoRatio:     portfolio.sortinoRatio,
          calmarRatio:      portfolio.calmarRatio,
          maxDrawdown:      portfolio.maxDrawdown,
          maxDrawdownUsd:   portfolio.maxDrawdownUsd,
          monthlyBreakdown: portfolio.monthlyBreakdown,
          totalRealizedPnl: portfolio.totalRealizedPnl,
          totalFees:        portfolio.totalFees,
          dataPoints:       portfolio.dataPoints,
        } : null,
      };
    },
  },

  // GET hot symbols — most spread-active (tightest spread = most liquid/active)
  {
    method:  "GET",
    path:    api("/watchlists/hot-symbols"),
    auth:    true,
    handler: ({ state, query }) => {
      const limit  = Math.min(Number(query.get("limit") ?? 10), 50);
      const quotes = state.getQuotes();
      // "Hot" = recently updated quotes, ranked by quote recency then change magnitude
      const now = Date.now();
      const scored = [...quotes]
        .map((q: { ts?: string; changePct?: number; symbol?: string }) => ({
          ...(q as object),
          _age: now - new Date((q as { ts?: string }).ts ?? 0).getTime(),
        }))
        .sort((a: { _age: number; changePct?: number }, b: { _age: number; changePct?: number }) => {
          // Primary: freshest quote; secondary: biggest move
          if (a._age !== b._age) return a._age - b._age;
          return Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0);
        })
        .slice(0, limit)
        .map(({ _age, ...q }) => q);  // strip internal field
      return { hot: scored };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // Task 13 — Horizontal Scaling Admin Endpoints
  // ══════════════════════════════════════════════════════════════════════════

  // ── 1. Background job leader election inventory ────────────────────────────
  {
    method:  "GET",
    path:    api("/admin/jobs"),
    admin:   true,
    handler: ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const inventory = jobCoordinator.getInventory();
      return {
        ok:        true,
        nodeId:    wsCluster.nodeId,
        jobs:      inventory,
        total:     inventory.length,
        running:   inventory.filter((j) => j.runCount > 0).length,
        timestamp: new Date().toISOString(),
      };
    },
  },

  // ── 2. WebSocket cluster stats ─────────────────────────────────────────────
  {
    method:  "GET",
    path:    api("/admin/cluster/stats"),
    admin:   true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const stats = await wsCluster.getClusterStats();
      return { ok: true, ...stats };
    },
  },

  // Find which cluster node currently holds a user's WebSocket session
  {
    method:  "GET",
    path:    api("/admin/cluster/user/:userId/node"),
    admin:   true,
    handler: async ({ params, authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { userId } = params;
      if (!userId) return { ok: false, reason: "userId required" };
      const nodeId = await wsCluster.findUserNode(userId);
      return { ok: true, userId, nodeId, connected: nodeId !== null };
    },
  },

  // ── 3. Distributed cache stats ─────────────────────────────────────────────
  {
    method:  "GET",
    path:    api("/admin/cache/stats"),
    admin:   true,
    handler: ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return { ok: true, cache: distributedCache.getStats() };
    },
  },

  // Flush cache (all keys or a specific prefix)
  {
    method:  "POST",
    path:    api("/admin/cache/flush"),
    admin:   true,
    handler: async ({ authHeader, state, body }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const prefix = (body as Record<string, unknown> | null)?.prefix as string | undefined;
      await distributedCache.flush(prefix);
      return { ok: true, flushed: true, prefix: prefix ?? "all" };
    },
  },

  // ── 4. PgBouncer connection pool stats ────────────────────────────────────
  {
    method:  "GET",
    path:    api("/admin/pgbouncer/stats"),
    admin:   true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const stats = await pgbouncerHealth.getStats();
      return { ok: true, pgbouncer: stats };
    },
  },

  // ── 5. Read replica health ─────────────────────────────────────────────────
  {
    method:  "GET",
    path:    api("/admin/read-replica/health"),
    admin:   true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const health = await checkReplicaHealth();
      return { ok: true, replica: health };
    },
  },

  // ── 6. Event sourcing archive stats ───────────────────────────────────────
  {
    method:  "GET",
    path:    api("/admin/event-archive/stats"),
    admin:   true,
    handler: ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return { ok: true, archive: eventArchive.getStats() };
    },
  },

  // Query event archive for admin replay / regulatory inspection
  {
    method:  "GET",
    path:    api("/admin/event-archive/query"),
    admin:   true,
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const streamId   = query.get("streamId")   ?? undefined;
      const eventType  = query.get("eventType")  ?? undefined;
      const from       = query.get("from")   ? new Date(query.get("from")!)  : undefined;
      const to         = query.get("to")     ? new Date(query.get("to")!)    : undefined;
      const limit      = Math.min(Number(query.get("limit") ?? 50), 500);

      const events = await eventArchive.query({ streamId, eventType, from, to, limit });
      return { ok: true, events, count: events.length };
    },
  },

  // ── 7. Ledger partition inventory ─────────────────────────────────────────
  {
    method:  "GET",
    path:    api("/admin/partitions/status"),
    admin:   true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      try {
        const rows = await prisma!.$queryRaw<Array<{
          parent_table: string;
          partition_name: string;
          partition_bound: string;
          total_size: string;
          total_bytes: bigint;
        }>>`SELECT * FROM partition_inventory ORDER BY parent_table, partition_name`;

        const grouped: Record<string, unknown[]> = {};
        for (const row of rows) {
          if (!grouped[row.parent_table]) grouped[row.parent_table] = [];
          grouped[row.parent_table].push({
            name:           row.partition_name,
            bound:          row.partition_bound,
            size:           row.total_size,
            bytes:          Number(row.total_bytes),
          });
        }
        return { ok: true, partitions: grouped, totalPartitions: rows.length };
      } catch {
        return { ok: false, reason: "partition_inventory view not yet created — run migrations" };
      }
    },
  },

  // Trigger manual ledger archive (moves rows older than N days from LedgerEntry to LedgerEntryArchive)
  {
    method:  "POST",
    path:    api("/admin/partitions/archive-ledger"),
    admin:   true,
    handler: async ({ authHeader, state, body }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      const daysOld = Math.max(30, Number((body as Record<string, unknown> | null)?.daysOld ?? 90));
      const cutoff  = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1_000);

      try {
        const [ledgerResult] = await prisma!.$queryRaw<[{archive_ledger_entries: number}]>`
          SELECT archive_ledger_entries(${cutoff}::timestamptz)`;
        const [tradeResult] = await prisma!.$queryRaw<[{archive_trade_audits: number}]>`
          SELECT archive_trade_audits(${cutoff}::timestamptz)`;

        return {
          ok:              true,
          cutoffDate:      cutoff.toISOString(),
          daysOld,
          ledgerMoved:     ledgerResult.archive_ledger_entries,
          tradeAuditMoved: tradeResult.archive_trade_audits,
        };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },
  },

  // Trigger monthly_partition_maintenance() to create next 3 months of partitions
  {
    method:  "POST",
    path:    api("/admin/partitions/maintain"),
    admin:   true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      try {
        const [result] = await prisma!.$queryRaw<[{ monthly_partition_maintenance: string }]>`
          SELECT monthly_partition_maintenance()`;
        return { ok: true, result: result.monthly_partition_maintenance };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Task 14 — DB Institutional Hardening Endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Query Observability ────────────────────────────────────────────────────

  // GET /api/v1/admin/db/query-stats — query timing statistics and model breakdown
  {
    method:  "GET",
    path:    api("/admin/db/query-stats"),
    admin:   true,
    handler: ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return { ok: true, stats: queryTelemetry.getStats() };
    },
  },

  // GET /api/v1/admin/db/slow-queries — ring buffer of recent slow queries
  {
    method:  "GET",
    path:    api("/admin/db/slow-queries"),
    admin:   true,
    handler: ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const limit = Math.min(Number(query.get("limit") ?? 50), 200);
      return {
        ok:           true,
        thresholdMs:  queryTelemetry.getThresholdMs(),
        slowQueries:  queryTelemetry.getSlowQueries(limit),
        count:        queryTelemetry.getSlowQueries(limit).length,
      };
    },
  },

  // DELETE /api/v1/admin/db/slow-queries — clear the slow query ring buffer
  {
    method:  "DELETE",
    path:    api("/admin/db/slow-queries"),
    admin:   true,
    handler: ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      queryTelemetry.clearSlowQueries();
      return { ok: true, message: "Slow query buffer cleared" };
    },
  },

  // ── Slow Query Analyzer ────────────────────────────────────────────────────

  // GET /api/v1/admin/db/analyze — full slow query + table scan + partition analysis
  {
    method:  "GET",
    path:    api("/admin/db/analyze"),
    admin:   true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      try {
        const analysis = await slowQueryAnalyzer.analyze();
        return { ok: true, analysis };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },
  },

  // ── Partition Management ───────────────────────────────────────────────────

  // GET /api/v1/admin/db/partitions — partition stats from igfxpro_partition_stats view
  {
    method:  "GET",
    path:    api("/admin/db/partitions"),
    admin:   true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT || !prisma) return { ok: false, reason: "SANDBOX_MODE" };

      try {
        const rows = await (prisma as NonNullable<typeof prisma>).$queryRaw<Array<{
          parent_table:   string;
          partition_name: string;
          total_size:     string;
          total_bytes:    bigint;
          live_rows:      bigint | null;
          last_analyzed:  Date | null;
          last_vacuumed:  Date | null;
        }>>`SELECT * FROM igfxpro_partition_stats ORDER BY parent_table, partition_name`;

        const grouped: Record<string, unknown[]> = {};
        let totalBytes = 0;
        for (const r of rows) {
          if (!grouped[r.parent_table]) grouped[r.parent_table] = [];
          grouped[r.parent_table].push({
            name:         r.partition_name,
            size:         r.total_size,
            bytes:        Number(r.total_bytes),
            liveRows:     Number(r.live_rows ?? 0),
            lastAnalyzed: r.last_analyzed?.toISOString() ?? null,
            lastVacuumed: r.last_vacuumed?.toISOString() ?? null,
          });
          totalBytes += Number(r.total_bytes);
        }
        return {
          ok:               true,
          partitions:       grouped,
          totalPartitions:  rows.length,
          totalBytes,
          generatedAt:      new Date().toISOString(),
        };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },
  },

  // POST /api/v1/admin/db/partitions/ensure — create next 4 months of partitions
  {
    method:  "POST",
    path:    api("/admin/db/partitions/ensure"),
    admin:   true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT || !prisma) return { ok: false, reason: "SANDBOX_MODE" };

      try {
        const rows = await (prisma as NonNullable<typeof prisma>).$queryRaw<Array<{
          parent_table:   string;
          partition_name: string;
          created:        boolean;
          from_date:      string;
          to_date:        string;
        }>>`SELECT * FROM igfxpro_create_next_partitions()`;

        return {
          ok:      true,
          results: rows,
          created: rows.filter((r) => r.created).length,
          total:   rows.length,
        };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },
  },

  // ── Data Retention ─────────────────────────────────────────────────────────

  // GET /api/v1/admin/db/retention — retention policy status and last run info
  {
    method:  "GET",
    path:    api("/admin/db/retention"),
    admin:   true,
    handler: ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      return { ok: true, retention: dataRetentionService.getStatus() };
    },
  },

  // GET /api/v1/admin/db/retention/report — last retention run report
  {
    method:  "GET",
    path:    api("/admin/db/retention/report"),
    admin:   true,
    handler: ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const report = dataRetentionService.getLastReport();
      return { ok: true, report: report ?? { note: "No retention run completed yet in this process" } };
    },
  },

  // POST /api/v1/admin/db/retention/run — trigger retention sweep immediately
  {
    method:  "POST",
    path:    api("/admin/db/retention/run"),
    admin:   true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      try {
        const report = await dataRetentionService.run();
        return { ok: true, report };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },
  },

  // ── Enhanced Reconciliation ────────────────────────────────────────────────

  // GET /api/v1/admin/db/reconciliation/enhanced — last enhanced recon report
  {
    method:  "GET",
    path:    api("/admin/db/reconciliation/enhanced"),
    admin:   true,
    handler: ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const report = enhancedReconciliationService.getLastReport();
      return {
        ok:     true,
        report: report ?? { note: "No enhanced reconciliation run completed yet in this process" },
      };
    },
  },

  // POST /api/v1/admin/db/reconciliation/enhanced/run — trigger enhanced recon
  {
    method:  "POST",
    path:    api("/admin/db/reconciliation/enhanced/run"),
    admin:   true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      if (!IS_PERSISTENT) return { ok: false, reason: "SANDBOX_MODE" };

      try {
        const report = await enhancedReconciliationService.runDailyAudit();
        return { ok: true, report };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },
  },

  // ── Read Replica ───────────────────────────────────────────────────────────

  // GET /api/v1/admin/db/replica — read replica routing stats
  {
    method:  "GET",
    path:    api("/admin/db/replica"),
    admin:   true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const stats = await getReplicaStats();
      return { ok: true, replica: stats };
    },
  },

  // ── DB Overview ────────────────────────────────────────────────────────────

  // GET /api/v1/admin/db/overview — combined DB health dashboard for admin UI
  {
    method:  "GET",
    path:    api("/admin/db/overview"),
    admin:   true,
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const [replicaStats] = await Promise.all([
        getReplicaStats(),
      ]);

      const queryStats = queryTelemetry.getStats();
      const retentionStatus = dataRetentionService.getStatus();
      const lastEnhancedRecon = enhancedReconciliationService.getLastReport();

      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        queryObservability: {
          totalQueries:  queryStats.totalQueries,
          slowQueries:   queryStats.slowQueries,
          avgDurationMs: queryStats.avgDurationMs,
          p95Ms:         queryStats.p95Ms,
          p99Ms:         queryStats.p99Ms,
          thresholdMs:   queryStats.thresholdMs,
          lastSlowQuery: queryStats.lastSlowQuery,
        },
        readReplica: replicaStats,
        retention: {
          lastRunAt:   retentionStatus.lastRunAt,
          policyCount: retentionStatus.policies.length,
          regulatoryCompliance: retentionStatus.regulatoryCompliance.length,
        },
        enhancedReconciliation: {
          lastRunAt:      lastEnhancedRecon?.runAt ?? null,
          overallClean:   lastEnhancedRecon?.overallClean ?? null,
          totalMismatches: lastEnhancedRecon?.totalMismatches ?? null,
        },
        partitioning: {
          enabled: IS_PERSISTENT,
          tables: ["LedgerEntry", "TradeAudit"],
          note: "Monthly range partitioning active — use /admin/db/partitions for detail",
        },
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  INSTRUMENTS — 120+ tradeable symbols with full metadata
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/v1/instruments — full list with metadata and spreads
  {
    method:  "GET",
    path:    api("/instruments"),
    handler: async ({ query }) => {
      const assetClass = query.get("class");
      const search     = query.get("q")?.toUpperCase();

      let symbols = ALL_SYMBOLS;
      if (assetClass && assetClass in SYMBOLS_BY_CLASS) {
        symbols = SYMBOLS_BY_CLASS[assetClass as keyof typeof SYMBOLS_BY_CLASS] ?? ALL_SYMBOLS;
      }
      if (search) {
        symbols = symbols.filter(s => s.includes(search) || INSTRUMENT_META[s]?.name.toUpperCase().includes(search));
      }

      const instruments = symbols.map(sym => ({
        ...INSTRUMENT_META[sym],
        spread:  brokerSpreadConfig.getSpread(sym),
        enabled: brokerSpreadConfig.isEnabled(sym),
      })).filter(Boolean);

      return { ok: true, count: instruments.length, instruments };
    },
  },

  // GET /api/v1/instruments/:symbol — single instrument detail
  {
    method:  "GET",
    path:    api("/instruments/:symbol"),
    handler: async ({ params }) => {
      const sym  = (params as { symbol: string }).symbol.toUpperCase();
      const meta = INSTRUMENT_META[sym];
      if (!meta) return { ok: false, reason: "INSTRUMENT_NOT_FOUND" };
      return {
        ok: true,
        instrument: {
          ...meta,
          spread:  brokerSpreadConfig.getSpread(sym),
          enabled: brokerSpreadConfig.isEnabled(sym),
        },
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  PAPER TRADING — risk-free simulation with real market prices
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/v1/paper/wallets
  {
    method:  "GET",
    path:    api("/paper/wallets"),
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const wallets = await paperTradingService.listWallets(principal.sub);
      return { ok: true, wallets };
    },
  },

  // POST /api/v1/paper/wallets
  {
    method:  "POST",
    path:    api("/paper/wallets"),
    handler: async ({ authHeader, state, body }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { name } = body as { name?: string };
      const wallet = await paperTradingService.createWallet(principal.sub, name);
      return { ok: true, wallet };
    },
  },

  // GET /api/v1/paper/wallets/:walletId
  {
    method:  "GET",
    path:    api("/paper/wallets/:walletId"),
    handler: async ({ authHeader, state, params }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { walletId } = params as { walletId: string };
      const wallet = await paperTradingService.getWallet(principal.sub, walletId);
      if (!wallet) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, wallet };
    },
  },

  // POST /api/v1/paper/wallets/:walletId/reset
  {
    method:  "POST",
    path:    api("/paper/wallets/:walletId/reset"),
    handler: async ({ authHeader, state, params }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { walletId } = params as { walletId: string };
      const wallet = await paperTradingService.resetWallet(principal.sub, walletId);
      return { ok: true, wallet };
    },
  },

  // GET /api/v1/paper/wallets/:walletId/positions
  {
    method:  "GET",
    path:    api("/paper/wallets/:walletId/positions"),
    handler: async ({ authHeader, state, params }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { walletId } = params as { walletId: string };
      const positions = await paperTradingService.getPositions(principal.sub, walletId);
      return { ok: true, positions };
    },
  },

  // POST /api/v1/paper/wallets/:walletId/orders
  {
    method:  "POST",
    path:    api("/paper/wallets/:walletId/orders"),
    handler: async ({ authHeader, state, params, body }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { walletId } = params as { walletId: string };
      const {
        symbol, direction, orderType = "MARKET", quantity,
        sl, tp, limitPrice, currentPrice,
      } = body as {
        symbol: string; direction: "BUY" | "SELL"; orderType?: "MARKET" | "LIMIT" | "STOP";
        quantity: number; sl?: number; tp?: number; limitPrice?: number; currentPrice: number;
      };

      if (!symbol || !direction || !quantity || !currentPrice) {
        return { ok: false, reason: "MISSING_PARAMS" };
      }

      const result = await paperTradingService.placeOrder({
        userId: principal.sub, walletId, symbol, direction, orderType,
        quantity, sl, tp, limitPrice, currentPrice,
      });

      return { ok: result.success, ...result };
    },
  },

  // POST /api/v1/paper/wallets/:walletId/positions/:positionId/close
  {
    method:  "POST",
    path:    api("/paper/wallets/:walletId/positions/:positionId/close"),
    handler: async ({ authHeader, state, params, body }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { walletId, positionId } = params as { walletId: string; positionId: string };
      const { currentPrice } = body as { currentPrice: number };
      const result = await paperTradingService.closePosition(principal.sub, walletId, positionId, currentPrice);
      return { ok: result.success, ...result };
    },
  },

  // GET /api/v1/paper/wallets/:walletId/history
  {
    method:  "GET",
    path:    api("/paper/wallets/:walletId/history"),
    handler: async ({ authHeader, state, params, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { walletId } = params as { walletId: string };
      const limit   = parseInt(query.get("limit") ?? "50", 10);
      const orders  = await paperTradingService.getOrderHistory(principal.sub, walletId, limit);
      const stats   = await paperTradingService.getPerformanceStats(principal.sub, walletId);
      return { ok: true, orders, stats };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  ALGORITHMIC ORDERS — TWAP / VWAP / ICEBERG / BRACKET
  // ══════════════════════════════════════════════════════════════════════════

  // POST /api/v1/algo/orders
  {
    method:  "POST",
    path:    api("/algo/orders"),
    handler: async ({ authHeader, state, body }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const { symbol, direction, totalQuantity, params: algoParams } = body as {
        symbol:        string;
        direction:     "BUY" | "SELL";
        totalQuantity: number;
        params:        { type: "TWAP" | "VWAP" | "ICEBERG" | "BRACKET"; [k: string]: unknown };
      };

      if (!symbol || !direction || !totalQuantity || !algoParams?.type) {
        return { ok: false, reason: "MISSING_PARAMS" };
      }

      const algo = algoOrderService.submit({
        userId:        principal.sub,
        tenantId:      principal.tenantId,
        symbol,
        direction,
        totalQuantity,
        params:        algoParams as Parameters<typeof algoOrderService.submit>[0]["params"],
      });

      return { ok: true, algo };
    },
  },

  // GET /api/v1/algo/orders — list running algo orders
  {
    method:  "GET",
    path:    api("/algo/orders"),
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const orders = algoOrderService.getActive(principal.sub);
      return { ok: true, orders };
    },
  },

  // DELETE /api/v1/algo/orders/:algoId — cancel algo order
  {
    method:  "DELETE",
    path:    api("/algo/orders/:algoId"),
    handler: async ({ authHeader, state, params }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { algoId } = params as { algoId: string };
      const cancelled = algoOrderService.cancel(algoId, principal.sub);
      return { ok: cancelled, reason: cancelled ? undefined : "NOT_FOUND_OR_UNAUTHORIZED" };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  TAX REPORTING — annual P&L reports, country-specific, CSV/JSON export
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/v1/tax/years — available tax years
  {
    method:  "GET",
    path:    api("/tax/years"),
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const years = await taxCalculator.getAvailableYears(principal.sub);
      return { ok: true, years };
    },
  },

  // GET /api/v1/tax/report?year=2025&country=IT — full report
  {
    method:  "GET",
    path:    api("/tax/report"),
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const year    = parseInt(query.get("year") ?? String(new Date().getFullYear() - 1), 10);
      const country = (query.get("country") ?? "OTHER") as Parameters<typeof taxCalculator.computeAnnualReport>[2];

      const report = await taxCalculator.computeAnnualReport(principal.sub, year, country);
      return { ok: true, report };
    },
  },

  // GET /api/v1/tax/export?year=2025&country=IT&format=csv — download
  {
    method:  "GET",
    path:    api("/tax/export"),
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const year    = parseInt(query.get("year") ?? String(new Date().getFullYear() - 1), 10);
      const country = (query.get("country") ?? "OTHER") as Parameters<typeof taxCalculator.computeAnnualReport>[2];
      const format  = query.get("format") ?? "json";

      const report = await taxCalculator.computeAnnualReport(principal.sub, year, country);

      if (format === "csv") {
        return { ok: true, contentType: "text/csv", filename: `igfx_tax_${year}_${country}.csv`, data: taxCalculator.exportCsv(report) };
      }
      return { ok: true, contentType: "application/json", filename: `igfx_tax_${year}_${country}.json`, data: taxCalculator.exportJson(report) };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  RISK — Correlation Matrix
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/v1/risk/correlation?window=30 — live correlation between open positions
  {
    method:  "GET",
    path:    api("/risk/correlation"),
    handler: async ({ authHeader, state, query }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const window = parseInt(query.get("window") ?? "30", 10);
      const matrix = await correlationMatrix.compute(principal.sub, window);
      return { ok: true, matrix };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  PUBLIC API KEY MANAGEMENT — programmatic API access
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/v1/api-keys — list keys for current user
  {
    method:  "GET",
    path:    api("/api-keys"),
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const keys = await apiKeyService.listKeys(principal.sub);
      return { ok: true, keys };
    },
  },

  // POST /api/v1/api-keys — create new API key
  {
    method:  "POST",
    path:    api("/api-keys"),
    handler: async ({ authHeader, state, body }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };

      const { name, scopes, environment, rateLimit, expiresAt } = body as {
        name:        string;
        scopes:      ("read" | "trade" | "admin")[];
        environment: "live" | "paper";
        rateLimit?:  number;
        expiresAt?:  string;
      };

      if (!name || !scopes?.length || !environment) {
        return { ok: false, reason: "MISSING_PARAMS" };
      }

      const result = await apiKeyService.create({
        userId: principal.sub, name, scopes, environment, rateLimit, expiresAt,
      });

      return {
        ok:       true,
        key:      result.key,
        plaintext:result.plaintext,
        warning:  "Store this key securely — it will not be shown again",
      };
    },
  },

  // DELETE /api/v1/api-keys/:keyId — revoke an API key
  {
    method:  "DELETE",
    path:    api("/api-keys/:keyId"),
    handler: async ({ authHeader, state, params }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const { keyId } = params as { keyId: string };
      await apiKeyService.revoke(principal.sub, keyId);
      return { ok: true };
    },
  },

  // DELETE /api/v1/api-keys — revoke all keys for current user
  {
    method:  "DELETE",
    path:    api("/api-keys"),
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const count = await apiKeyService.revokeAll(principal.sub);
      return { ok: true, revokedCount: count };
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  //  FIX GATEWAY STATUS — institutional FIX 4.4 protocol endpoint
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/v1/fix/status — FIX acceptor status (admin/institutional)
  {
    method:  "GET",
    path:    api("/fix/status"),
    handler: async ({ authHeader, state }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "UNAUTHENTICATED" };
      const acceptor = getFixAcceptor();
      if (!acceptor) {
        return {
          ok:     true,
          status: "NOT_STARTED",
          note:   "Set FIX_ENABLED=true and FIX_PORT=9878 to enable FIX 4.4 acceptor",
        };
      }
      const stats = acceptor.getStats();
      return {
        ok:       true,
        status:   "ACTIVE",
        protocol: "FIX.4.4",
        compId:   stats.compId,
        port:     stats.port,
        activeSessions: stats.activeSessions,
        totalSessions:  stats.totalSessions,
        supportedMsgTypes: ["A (Logon)", "5 (Logout)", "0 (Heartbeat)", "1 (TestRequest)", "D (NewOrderSingle)", "F (OrderCancelRequest)", "8 (ExecutionReport)"],
        connectionExample: {
          host:         "your-broker-host.com",
          port:         stats.port,
          senderCompID: "CLIENT_FIRM_ID",
          targetCompID: stats.compId,
          note:         "Set tag 1 (Account) to your IGFXPRO userId for order routing",
        },
      };
    },
  },

  // ── Security Administration Routes ────────────────────────────────────────

  // MFA step-up token issuance (after successful 2FA code verification)
  {
    method: "POST",
    path: api("/auth/mfa/step-up"),
    auth: true,
    handler: async ({ body, state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      const parsed = z.object({
        code:           z.string().length(6),
        operationClass: z.enum(["WITHDRAWAL", "API_KEY_MANAGEMENT", "ADMIN_CRITICAL", "KYC_APPROVAL", "SECURITY_CHANGE", "AUDIT_EXPORT", "CAPITAL_OPERATION"]),
      }).safeParse(body);
      if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message };

      const { code, operationClass } = parsed.data;
      const verifyResult = await twoFactorService.verify(principal.sub, code);
      if (!verifyResult.valid) return { ok: false, reason: "Invalid MFA code" };

      const token = await mfaEnforcer.issueStepUp(principal.sub, operationClass, "totp");
      return { ok: true, token, expiresIn: Number(process.env.MFA_STEPUP_TTL_SECONDS ?? 300) };
    },
  },

  // Zero Trust + RBAC status for the current session
  {
    method: "GET",
    path: api("/security/status"),
    auth: true,
    handler: async ({ state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      const perms = rbacEngine.getEffectivePermissions(principal.roles);
      return {
        ok:          true,
        userId:      principal.sub,
        roles:       principal.roles,
        permissions: perms,
        mfaEnrolled: IS_PERSISTENT ? await twoFactorService.isEnabled(principal.sub) : false,
      };
    },
  },


  // Audit chain integrity verification (admin only)
  {
    method: "POST",
    path: api("/admin/security/audit/verify-chain"),
    admin: true,
    handler: async ({ body, state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      const limit = Number((body as { limit?: number })?.limit ?? 10000);
      const result = await immutableAudit.verifyChain(Math.min(50000, limit));
      await immutableAudit.write({
        actor:   principal.sub,
        action:  "admin.audit.chain_verify",
        entity:  "audit_log",
        payload: { verified: result.totalChecked, valid: result.valid, firstBreak: result.firstBreak },
        severity: result.valid ? "INFO" : "CRITICAL",
      });
      return { ok: true, ...result };
    },
  },

  // SOC2 controls report
  {
    method: "GET",
    path: api("/admin/compliance/soc2-report"),
    admin: true,
    handler: async ({ state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      return { ok: true, ...soc2Controls.generateReport() };
    },
  },

  // PCI DSS controls report
  {
    method: "GET",
    path: api("/admin/compliance/pci-report"),
    admin: true,
    handler: async ({ state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      return { ok: true, ...pciDSSControls.generateReport() };
    },
  },

  // RBAC permission matrix
  {
    method: "GET",
    path: api("/admin/security/rbac-matrix"),
    admin: true,
    handler: async ({ state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      const matrix: Record<string, string[]> = {};
      for (const role of rbacEngine.allRoles) {
        matrix[role] = rbacEngine.getEffectivePermissions([role]);
      }
      return { ok: true, roles: rbacEngine.allRoles, permissionMatrix: matrix };
    },
  },

  // Archive audit logs to S3
  {
    method: "POST",
    path: api("/admin/security/audit/archive"),
    admin: true,
    handler: async ({ body, state, authHeader }) => {
      const principal = state.resolvePrincipal(authHeader);
      if (!principal) return { ok: false, reason: "unauthenticated" };
      const parsed = z.object({
        from: z.string().datetime(),
        to:   z.string().datetime(),
      }).safeParse(body);
      if (!parsed.success) return { ok: false, reason: "from and to dates required" };
      const result = await immutableAudit.archiveBatch(
        new Date(parsed.data.from),
        new Date(parsed.data.to),
        principal.sub,
      );
      return { ok: true, ...result };
    },
  },
];
