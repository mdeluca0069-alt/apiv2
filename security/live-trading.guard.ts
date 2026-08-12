/**
 * security/live-trading.guard.ts
 *
 * PRODUCTION_DEPLOYMENT_SAFETY_DECISION.md finding §D fix: resolves the
 * effective LIVE_TRADING_ENABLED value from environment configuration.
 * Extracted out of main.ts's inline expression so it can be regression-
 * tested directly against the real production code path, not a duplicate.
 *
 * Safe-by-default: only the exact string "true" enables live trading.
 * Missing, empty, or any other value (including "TRUE", "1", "yes",
 * "false") resolves to false.
 */
export function resolveLiveTradingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LIVE_TRADING_ENABLED === "true";
}
