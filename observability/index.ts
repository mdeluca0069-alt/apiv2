/**
 * observability/index.ts — Initialise all metric collectors in one call.
 *
 * Called once in main.ts after all services are started.
 * Each initializer attaches event-bus listeners and starts background collectors.
 */

export { initTradingMetrics }     from "./trading.metrics.js";
export { initAutopilotMetrics }   from "./autopilot.metrics.js";
export { initMarketDataMetrics }  from "./market.data.metrics.js";
export { initRiskMetrics }        from "./risk.metrics.js";
export { initAIMetrics }          from "./ai.metrics.js";
export { initDbMetrics }          from "./db.metrics.js";
export { instrumentRoutes }       from "./http.instrumentation.js";

import { initTradingMetrics }     from "./trading.metrics.js";
import { initAutopilotMetrics }   from "./autopilot.metrics.js";
import { initMarketDataMetrics }  from "./market.data.metrics.js";
import { initRiskMetrics }        from "./risk.metrics.js";
import { initAIMetrics }          from "./ai.metrics.js";
import { initDbMetrics }          from "./db.metrics.js";

export function initAllMetrics(): void {
  initTradingMetrics();
  initAutopilotMetrics();
  initMarketDataMetrics();
  initRiskMetrics();
  initAIMetrics();
  initDbMetrics();
  console.log("[observability] All metric collectors initialized");
}
