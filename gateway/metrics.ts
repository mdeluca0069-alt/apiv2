/**
 * gateway/metrics.ts — Re-exports from shared/metrics.ts.
 *
 * All metric definitions now live in shared/metrics.ts (Bloomberg-grade registry
 * with label support + OTEL integration). This file preserves backward compat
 * for existing imports of "gateway/metrics.js".
 */
export { metrics, type Labels } from "../shared/metrics.js";
