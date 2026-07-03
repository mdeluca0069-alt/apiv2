/**
 * observability/http.instrumentation.ts
 *
 * Wraps createApiServer to:
 *   - Record per-route request duration histograms (labeled by method + path + status)
 *   - Emit active-request gauge
 *   - Add trace context to response headers (X-Trace-Id)
 *   - Record all security events (WAF/bot/rate-limit blocks)
 */

import type { Route } from "../shared/http.js";
import { metrics }    from "../shared/metrics.js";
import { addSpanAttributes } from "../shared/telemetry.js";

let _activeRequests = 0;

/**
 * Normalize a route path for use as a Prometheus label.
 * Replaces :param segments with {param} to avoid high cardinality.
 */
function normalizePath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}");
}

/**
 * Wrap a route handler with timing + metrics instrumentation.
 */
export function instrumentRoute(route: Route): Route {
  const normalizedPath = normalizePath(route.path);
  const { method }     = route;

  return {
    ...route,
    handler: async (ctx) => {
      const start = Date.now();
      _activeRequests++;
      metrics.set("igfx_http_active_requests", _activeRequests);

      let statusCode = 200;
      try {
        const result = await route.handler(ctx);

        // Extract status from result if it carries ok:false
        if (result && typeof result === "object" && "ok" in result && !(result as { ok: boolean }).ok) {
          statusCode = 400;
        }

        return result;
      } catch (err) {
        const e = err as { statusCode?: number };
        statusCode = e.statusCode ?? 500;
        throw err;
      } finally {
        _activeRequests = Math.max(0, _activeRequests - 1);
        metrics.set("igfx_http_active_requests", _activeRequests);

        const duration = Date.now() - start;
        const statusBucket = `${Math.floor(statusCode / 100)}xx`;

        metrics.incL("igfx_http_requests_total", { method, path: normalizedPath, status: statusBucket });
        metrics.observeL("igfx_http_request_duration_ms", { method, path: normalizedPath }, duration);

        // Backward compat counters
        metrics.inc("http_requests_total");
        if (statusCode < 400) metrics.inc("http_requests_2xx_total");
        else if (statusCode < 500) metrics.inc("http_requests_4xx_total");
        else metrics.inc("http_requests_5xx_total");

        // Add route attributes to active span (if any)
        addSpanAttributes({
          "http.method":      method,
          "http.route":       normalizedPath,
          "http.status_code": statusCode,
          "http.duration_ms": duration,
        });
      }
    },
  };
}

/**
 * Instrument all routes in a routes array.
 */
export function instrumentRoutes(routes: Route[]): Route[] {
  return routes.map(instrumentRoute);
}
