import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { ZodError } from "zod";
import type { BrokerState } from "./state.js";
import type { RateLimiter } from "../gateway/rate-limiter.js";
import type { ClientTier } from "../gateway/rate-limiter.js";
import { scoreIp, trackVelocity } from "../security/ip-reputation.js";
import { trackEndpoint, trackAdminForbidden } from "../security/event-correlator.js";
import { logger } from "./logger.js";
import { wafEngine }    from "../security/waf.engine.js";
import { botDetector }  from "../security/bot.detection.js";
import { permissionMiddleware } from "../security/permission.middleware.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RequestContext = {
  req: IncomingMessage;
  res: ServerResponse;
  state: BrokerState;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  authHeader?: string;
};

export type Route = {
  method: HttpMethod;
  path: string;
  handler: (ctx: RequestContext) => Promise<unknown> | unknown;
  auth?: boolean;
  admin?: boolean;
  // When true, ctx.body is a raw Buffer instead of parsed JSON.
  // Required for webhook routes whose HMAC signature covers the exact bytes.
  rawBody?: boolean;
};

export type ApiServerOptions = {
  state: BrokerState;
  routes: Route[];
  corsOrigin: string;
  rateLimiter?: RateLimiter;
};

const BODY_SIZE_LIMIT = 1 * 1024 * 1024; // 1 MB

// Health/readiness probe paths, exempted from rate limiting -- see the
// PRODUCTION CUTOVER Stage 3 comment at the rate-limiter call site below.
const HEALTH_CHECK_PATHS = new Set(["/health", "/api/health", "/api/v1/health"]);

const isProd = process.env.NODE_ENV === "production";

function resolveCorsOrigin(requestOrigin: string | undefined, configuredOrigin: string): string {
  if (configuredOrigin === "*") return "*";
  if (!requestOrigin) return configuredOrigin;

  if (requestOrigin === configuredOrigin) return requestOrigin;

  // Localhost is only trusted outside production (local frontend dev server on
  // an arbitrary Vite port). In production this would let any locally-running
  // process reflect a trusted Origin against the live API — never allow it.
  if (!isProd) {
    try {
      const originUrl = new URL(requestOrigin);
      const isLocalhost = originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1";
      if (originUrl.protocol === "http:" && isLocalhost) {
        return requestOrigin;
      }
    } catch {
      // Fall through to configured origin on invalid origin value
    }
  }

  return configuredOrigin;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function setSecurityHeaders(res: ServerResponse): void {
  if (isProd) {
    res.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  }
  res.setHeader(
    "content-security-policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("x-xss-protection", "0");
  res.setHeader("permissions-policy", "geolocation=(), microphone=(), camera=()");
}

function matchRoute(routePath: string, pathname: string): Record<string, string> | null {
  const routeParts = routePath.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (routeParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < routeParts.length; i += 1) {
    const routePart = routeParts[i];
    const pathPart = pathParts[i];
    if (routePart?.startsWith(":")) {
      params[routePart.slice(1)] = decodeURIComponent(pathPart ?? "");
    } else if (routePart !== pathPart) {
      return null;
    }
  }
  return params;
}

async function parseBody(req: IncomingMessage, rawBuffer?: boolean): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.byteLength;
    if (totalBytes > BODY_SIZE_LIMIT) {
      throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
    }
    chunks.push(buf);
  }
  const buf = Buffer.concat(chunks);
  if (rawBuffer) return buf;
  const raw = buf.toString("utf8");
  if (!raw) return undefined;
  const contentType = req.headers["content-type"] ?? "";
  if (String(contentType).includes("application/json")) {
    return JSON.parse(raw);
  }
  return raw;
}

function extractClientTier(principal: { tier?: string } | null): ClientTier | "UNAUTH" {
  if (!principal) return "UNAUTH";
  const t = (principal.tier ?? "STANDARD").toUpperCase();
  const valid: (ClientTier | "UNAUTH")[] = ["STANDARD", "GOLD", "PLATINUM", "VIP", "ENTERPRISE"];
  return valid.includes(t as ClientTier) ? (t as ClientTier) : "STANDARD";
}

export function createApiServer(options: ApiServerOptions) {
  return createServer(async (req, res) => {
    const requestId =
      req.headers["x-request-id"]?.toString() ??
      `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

    // ── CORS ──────────────────────────────────────────────────────────────
    res.setHeader("access-control-allow-origin", resolveCorsOrigin(req.headers.origin, options.corsOrigin));
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", "content-type,authorization,x-request-id,x-client,x-tenant-id");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("x-request-id", requestId);

    // ── Security headers ──────────────────────────────────────────────────
    setSecurityHeaders(res);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url      = new URL(req.url ?? "/", "http://localhost");
    const method   = (req.method ?? "GET") as HttpMethod;
    const clientIp = (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.socket.remoteAddress ?? "unknown").trim();

    // ── IP reputation check ───────────────────────────────────────────────
    const ipRep = await scoreIp(clientIp).catch(() => null);
    if (ipRep?.blocked) {
      sendJson(res, 403, { code: "IP_BLOCKED", message: "Access denied", requestId });
      return;
    }
    // High-velocity abuse detection (fire-and-forget, non-blocking)
    void trackVelocity(clientIp).catch(() => null);

    // ── Bot detection ────────────────────────────────────────────────────────
    const userAgent = (req.headers["user-agent"] ?? "").slice(0, 512);
    const botResult = await botDetector.detect({
      ip: clientIp, userAgent, path: url.pathname, method,
      headers: req.headers as Record<string, string | string[] | undefined>,
    }).catch(() => ({ decision: "ALLOW" as const, score: 0, reasons: [] }));

    if (botResult.decision === "BLOCK") {
      sendJson(res, 403, { code: "BOT_BLOCKED", message: "Automated request detected", requestId });
      return;
    }
    if (botResult.decision === "CHALLENGE") {
      res.setHeader("x-bot-challenge", "required");
    }

    const candidates = options.routes.filter((route) => route.method === method);

    for (const route of candidates) {
      const params = matchRoute(route.path, url.pathname);
      if (!params) continue;

      try {
        const authHeader = req.headers.authorization;
        const principal = options.state.resolvePrincipal(authHeader);

        // ── API scanner detection (fire-and-forget) ───────────────────────
        void trackEndpoint(clientIp, url.pathname).catch(() => null);

        // ── WAF inspection ────────────────────────────────────────────────
        if (!route.rawBody) {
          // Inspect path/query/headers synchronously — body inspected after parse
          const wafResult = wafEngine.inspect({
            method,
            path:    url.pathname,
            query:   url.search.slice(1),
            body:    "",   // pre-body: will be re-checked with body in WAF-aware handlers
            headers: req.headers as Record<string, string | string[] | undefined>,
            ip:      clientIp,
          });
          if (wafResult.blocked) {
            sendJson(res, 403, { code: "WAF_BLOCKED", message: "Request blocked by security policy", requestId });
            return;
          }
        }

        // ── RBAC permission check ─────────────────────────────────────────
        // Cast principal to the TokenPayload-compatible shape expected by permissionMiddleware
        const permPrincipal = principal as import("../shared/security.js").TokenPayload | null;
        const permCheck = permissionMiddleware.checkRoute(method, url.pathname, permPrincipal);
        if (!permCheck.allowed) {
          sendJson(res, 403, { code: "FORBIDDEN", message: permCheck.reason ?? "Insufficient permissions", requestId });
          return;
        }

        // ── Rate limiting ─────────────────────────────────────────────────
        // PRODUCTION CUTOVER Stage 3 — live-confirmed in a Redis-failure
        // simulation: the rate limiter fails CLOSED on Redis unavailability
        // by design (gateway/rate-limiter.ts, to prevent bypassing limits by
        // knocking Redis offline) -- but that check ran for every route
        // including /health and /api/health, so a Redis outage returned 503
        // for the orchestrator's own health/readiness probes too. That turns
        // a recoverable Redis blip into every replica being marked unhealthy
        // simultaneously (since they all share one Redis), which can cascade
        // into restarts or full removal from the load balancer -- exactly
        // when operators most need an accurate signal. A health endpoint
        // gated on a dependency it isn't even checking cannot function as a
        // health check (the same principle as the /api/health PUBLIC_PATHS
        // fix earlier this Stage). Rate limiting still fails closed for
        // every real application route.
        if (options.rateLimiter && !HEALTH_CHECK_PATHS.has(url.pathname)) {
          const tier = extractClientTier(principal as { tier?: string } | null);
          const rl   = await options.rateLimiter.check(clientIp, tier, url.pathname);

          res.setHeader("x-ratelimit-limit",     String(rl.limit));
          res.setHeader("x-ratelimit-remaining", String(rl.remaining));
          res.setHeader("x-ratelimit-reset",     String(Math.floor(Date.now() / 1000) + rl.retryAfter));

          if (!rl.allowed) {
            if (rl.retryAfter > 0) res.setHeader("retry-after", String(rl.retryAfter));
            sendJson(res, 429, {
              code:       "RATE_LIMITED",
              message:    "Too many requests — slow down",
              retryAfter: rl.retryAfter,
              requestId,
            });
            return;
          }
        }

        // ── Auth guard ────────────────────────────────────────────────────
        if ((route.auth || route.admin) && !principal) {
          sendJson(res, 401, {
            code: "UNAUTHENTICATED",
            message: "Valid bearer token required",
            requestId,
          });
          return;
        }
        if (route.admin && !principal?.roles.some((role) => ["admin", "super_admin", "risk", "compliance"].includes(role))) {
          if (principal?.sub) void trackAdminForbidden(principal.sub).catch(() => null);
          sendJson(res, 403, {
            code: "FORBIDDEN",
            message: "Admin, risk or compliance role required",
            requestId,
          });
          return;
        }

        const body = await parseBody(req, route.rawBody);
        const data = await route.handler({
          req,
          res,
          state: options.state,
          params,
          query: url.searchParams,
          body,
          authHeader,
        });
        if (!res.writableEnded) sendJson(res, 200, data);
      } catch (error) {
        const errObj     = error as { statusCode?: number; code?: string; data?: unknown };
        const statusCode = errObj.statusCode;

        if (statusCode === 413) {
          sendJson(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 1 MB limit", requestId });
          return;
        }
        if (statusCode === 409) {
          sendJson(res, 409, {
            code:    "DUPLICATE_ORDER",
            message: (error as Error).message,
            ...(errObj.data ? { data: errObj.data } : {}),
            requestId,
          });
          return;
        }
        if (statusCode === 423) {
          sendJson(res, 423, {
            code:    "TRADING_SUSPENDED",
            message: (error as Error).message,
            ...(errObj.data ? { data: errObj.data } : {}),
            requestId,
          });
          return;
        }
        if (statusCode === 503) {
          sendJson(res, 503, {
            code:    "SERVICE_UNAVAILABLE",
            message: (error as Error).message,
            ...(errObj.data ? { data: errObj.data } : {}),
            requestId,
          });
          return;
        }
        if (error instanceof ZodError) {
          sendJson(res, 400, {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            fields: error.flatten().fieldErrors,
            requestId,
          });
          return;
        }
        const message = error instanceof Error ? error.message : "Unexpected API failure";
        logger.error({ requestId, method, path: url.pathname, err: error }, "unhandled route error");
        sendJson(res, 500, {
          code: "INTERNAL_ERROR",
          message,
          requestId,
        });
      }
      return;
    }

    sendJson(res, 404, {
      code: "NOT_FOUND",
      message: `${method} ${url.pathname} is not implemented`,
      requestId,
    });
  });
}
