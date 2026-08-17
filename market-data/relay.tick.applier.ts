/**
 * market-data/relay.tick.applier.ts
 *
 * Applies a market-data tick relayed from another worker's own local feed
 * connection (realtime-infra/redis.pubsub.ts's CH_TICK channel /
 * publishTick()) to THIS worker's LiquidityCore + FeedHealthMonitor,
 * mirroring exactly what the primary local-ingest path (main.ts's
 * FeedManager `ingestPrice` callback) already does when a tick is locally
 * sourced. Extracted into its own function — rather than left inline in
 * main.ts's onTickEvent() — specifically so this mirroring is directly
 * regression-testable, the same extraction pattern
 * security/live-trading.guard.ts already used for main.ts's own previously-
 * inline live-trading flag resolution.
 *
 * MULTI-REPLICA TWELVEDATA REMEDIATION: before this, onTickEvent() called
 * only `liquidityCore.ingestExternalPrice()` — never
 * `feedHealthMonitor.recordQuote()`. That gap was latent and harmless while
 * every replica also ran its own local TwelveData-WS (so every replica had
 * SOME chance of a local, recordQuote()-triggering tick regardless). It
 * becomes load-bearing the moment feed leadership (feed.leader.election.ts)
 * means most replicas run NO local TwelveData feed at all: without this
 * fix, a non-leader replica's own `/api/health` would report every
 * TwelveData-sourced symbol as permanently stale, even though quoteCache
 * itself is genuinely fresh via the relay — a health-reporting regression,
 * not a pricing one.
 */

export type LiquidityCoreLike = {
  ingestExternalPrice(
    symbol: string,
    mid: number,
    bid: number | undefined,
    ask: number | undefined,
    source: string,
  ): boolean;
};

export type FeedHealthMonitorLike = {
  recordQuote(symbol: string, bid: number, ask: number, source: string): void;
};

/**
 * Returns whether the relayed tick was accepted (mirrors
 * ingestExternalPrice()'s own return value) — mainly useful for tests;
 * production call sites are fire-and-forget, same as the primary path.
 */
export function applyRelayedTick(
  liquidityCore:     LiquidityCoreLike,
  feedHealthMonitor: FeedHealthMonitorLike,
  symbol: string,
  mid:    number,
  bid?:   number,
  ask?:   number,
): boolean {
  // Always tagged "redis-relay" — the lowest SOURCE_PRIORITY rank, so this
  // worker's own local feeds, when active, always win. A relayed tick only
  // fills in data this worker's own feeds haven't produced recently. Never
  // re-published (one-hop relay only, see publishTick's own doc comment).
  const accepted = liquidityCore.ingestExternalPrice(symbol, mid, bid, ask, "redis-relay");
  if (accepted) {
    feedHealthMonitor.recordQuote(symbol, bid ?? 0, ask ?? 0, "redis-relay");
  }
  return accepted;
}
