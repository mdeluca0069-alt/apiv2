/**
 * shared/telemetry.ts — OpenTelemetry SDK initialization.
 *
 * All OTEL imports are dynamic — the module degrades gracefully if OTEL
 * packages are not installed (no compile-time dependency on @opentelemetry/*).
 *
 * Install optional OTEL packages for production:
 *   npm install @opentelemetry/sdk-node @opentelemetry/api \
 *     @opentelemetry/resources @opentelemetry/semantic-conventions \
 *     @opentelemetry/auto-instrumentations-node \
 *     @opentelemetry/exporter-trace-otlp-grpc \
 *     @opentelemetry/exporter-metrics-otlp-grpc @opentelemetry/sdk-metrics
 *
 * Without them, all functions are no-ops — traces simply won't be exported.
 */

const OTEL_ENABLED    = process.env.OTEL_ENABLED !== "false";
const SERVICE_NAME    = process.env.OTEL_SERVICE_NAME ?? "igfxpro-api";
const OTLP_ENDPOINT   = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4317";
const SERVICE_VERSION = process.env.SERVICE_VERSION ?? "1.0.0";
const ENVIRONMENT     = process.env.NODE_ENV ?? "production";

export type SpanLike = { setAttribute(k: string, v: string | number | boolean): void; end(): void; recordException(e: Error): void; setStatus(s: { code: number; message?: string }): void } | null;
export type SpanAttributes = Record<string, string | number | boolean>;

let _shutdown: (() => Promise<void>) | null = null;
let _activeSpanFn: (() => SpanLike) | null = null;

// Lazy async initialization — non-blocking, app starts regardless
void (async () => {
  if (!OTEL_ENABLED) {
    console.log("[telemetry] OTEL disabled (OTEL_ENABLED=false)");
    return;
  }
  try {
    const [
      { NodeSDK },
      { Resource },
      { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION, SEMRESATTRS_DEPLOYMENT_ENVIRONMENT },
      { getNodeAutoInstrumentations },
    ] = await Promise.all([
      import("@opentelemetry/sdk-node"                    as string) as Promise<{ NodeSDK: new (cfg: Record<string, unknown>) => { start(): void; shutdown(): Promise<void> } }>,
      import("@opentelemetry/resources"                   as string) as Promise<{ Resource: new (attrs: Record<string, string>) => unknown }>,
      import("@opentelemetry/semantic-conventions"        as string) as Promise<Record<string, string>>,
      import("@opentelemetry/auto-instrumentations-node"  as string) as Promise<{ getNodeAutoInstrumentations: (cfg?: Record<string, unknown>) => unknown[] }>,
    ]);

    const { OTLPTraceExporter }  = await import("@opentelemetry/exporter-trace-otlp-grpc"    as string) as { OTLPTraceExporter: new (cfg: Record<string, unknown>) => unknown };
    const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-grpc"  as string) as { OTLPMetricExporter: new (cfg: Record<string, unknown>) => unknown };
    const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics"       as string) as { PeriodicExportingMetricReader: new (cfg: Record<string, unknown>) => unknown };

    const sdk = new NodeSDK({
      resource: new Resource({
        [SEMRESATTRS_SERVICE_NAME]:           SERVICE_NAME,
        [SEMRESATTRS_SERVICE_VERSION]:        SERVICE_VERSION,
        [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: ENVIRONMENT,
      }),
      traceExporter:  new OTLPTraceExporter({ url: OTLP_ENDPOINT }),
      metricReader:   new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: OTLP_ENDPOINT }),
        exportIntervalMillis: 15_000,
      }),
      instrumentations: getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-http": {
          ignoreIncomingRequestHook: (req: { url?: string }) => {
            const url = req.url ?? "";
            return url === "/health" || url === "/metrics";
          },
        },
      }),
    });

    sdk.start();
    _shutdown = () => sdk.shutdown();

    const { trace } = await import("@opentelemetry/api" as string) as { trace: { getTracer(n: string, v: string): unknown; getActiveSpan(): SpanLike | undefined } };
    _activeSpanFn = () => trace.getActiveSpan() ?? null;

    console.log(`[telemetry] OpenTelemetry initialized → ${OTLP_ENDPOINT}`);
  } catch (err) {
    console.warn("[telemetry] OTEL not available (install @opentelemetry/* to enable):", (err as Error).message);
  }
})();

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Add attributes to the currently active span. No-op if OTEL unavailable.
 */
export function addSpanAttributes(attrs: SpanAttributes): void {
  if (!_activeSpanFn) return;
  try {
    const span = _activeSpanFn();
    if (!span) return;
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  } catch { /* ignore OTEL errors */ }
}

/**
 * Wrap an async function in an OpenTelemetry span. No-op if OTEL unavailable.
 */
export async function startSpan<T>(
  _name:  string,
  fn:     (span: SpanLike) => Promise<T>,
): Promise<T> {
  return fn(null); // Simplified: spans created via auto-instrumentation
}

/**
 * Graceful shutdown — call on SIGTERM before process.exit().
 */
export async function shutdownTelemetry(): Promise<void> {
  if (_shutdown) {
    await _shutdown().catch(() => undefined);
    _shutdown = null;
  }
}
