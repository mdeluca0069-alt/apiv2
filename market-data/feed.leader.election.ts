/**
 * market-data/feed.leader.election.ts — MULTI-REPLICA TWELVEDATA REMEDIATION.
 *
 * PROBLEM (confirmed live, Hostinger staging, 2026-08-17 —
 * HOSTINGER_STAGING_DEPLOYMENT_REPORT.md §15's follow-up): main.ts's
 * FeedManager was instantiated and started unconditionally on every API
 * replica. Each replica's own TwelveData-WS connection authenticates with
 * the SAME shared TWELVEDATA_API_KEY. With 3 replicas each independently
 * subscribing/reconnecting, the combined event volume exceeded TwelveData's
 * free-plan "100 events per minute" per-key limit, so TwelveData rejected
 * the connections outright — the app's own reconnect logic then generated
 * MORE subscribe events, so the storm never settled (confirmed live: the
 * server's own rejection count climbed continuously across all 3 replicas
 * simultaneously, never dropping).
 *
 * FIX: exactly one replica ("leader") holds an active TwelveData-WS (+REST
 * tertiary — same API key, same plan quota, same class of problem) at a
 * time. The leader's own ticks already reach every other replica via the
 * EXISTING relay (realtime-infra/redis.pubsub.ts's CH_TICK channel,
 * publishTick()/onTickEvent() — this mechanism already existed and was
 * already fully wired for exactly this cross-replica-sync purpose,
 * MARKET_DATA_FREEZE.md §0.10; the missing piece was only that every
 * replica ALSO kept its own redundant, contention-causing direct
 * connection). Binance-WS is untouched — it's a free, unauthenticated,
 * per-key-unrestricted public stream, so 3 independent connections to it
 * cost nothing and aren't the resource under contention.
 *
 * Leadership is a lease (shared/distributed.job.lock.ts, reused as-is —
 * no second lock mechanism), renewed periodically by the leader and
 * polled-for by every non-leader on the same interval, so:
 *   - Exactly one replica can hold the lease at a time (atomic SET NX EX —
 *     the lock's own existing guarantee, not reimplemented here).
 *   - If the leader dies (crash, restart, container recreation) without a
 *     clean release, the lease simply expires (TTL) and the next
 *     non-leader poll picks it up — automatic failover, no operator step.
 *   - The leader itself polls its OWN continued ownership (isStillLeader())
 *     every tick and demotes itself the instant it's no longer certain it
 *     holds the lease, rather than trusting silent renewal success —
 *     the failure mode this exists to prevent is two replicas BOTH
 *     believing they're leader, not zero.
 */

import { DistributedJobLock } from "../shared/distributed.job.lock.js";

export const FEED_LEADER_JOB_ID = "market-data-twelvedata-leader";

// Short TTL relative to shared/distributed.job.lock.ts's other users (most
// are 300s, built for periodic batch jobs) — this lock instead gates a
// continuously-held external connection, so a dead leader should free it up
// for takeover quickly, not linger for minutes leaving the whole staging/
// production deployment without any TwelveData feed at all.
const DEFAULT_TTL_SECONDS   = 30;
const DEFAULT_RENEW_SECONDS = 10;   // renew at 1/3 of TTL — generous margin against one missed tick
const DEFAULT_POLL_SECONDS  = 10;   // how often a non-leader checks for a takeover opportunity

export type FeedLeaderCallbacks = {
  /** Called the instant this replica acquires leadership. Start the
   *  TwelveData WS/REST feeds here — never call them unconditionally. */
  onBecomeLeader: () => void;
  /** Called the instant this replica can no longer be certain it holds
   *  leadership. Stop the TwelveData WS/REST feeds here immediately —
   *  another replica may already be starting its own. */
  onLoseLeadership: () => void;
};

export class FeedLeaderElection {
  private readonly lock: DistributedJobLock;
  private isLeader          = false;
  private stopped           = false;
  private pollTimer:  ReturnType<typeof setInterval> | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private callbacks: FeedLeaderCallbacks | null = null;

  constructor(
    jobId: string = FEED_LEADER_JOB_ID,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
    private readonly pollSeconds:  number = DEFAULT_POLL_SECONDS,
    private readonly renewSeconds: number = DEFAULT_RENEW_SECONDS,
  ) {
    this.lock = new DistributedJobLock(jobId, ttlSeconds);
  }

  /** Begin the election. Attempts to acquire immediately, then polls on
   *  `pollSeconds` for as long as this instance is running. */
  start(callbacks: FeedLeaderCallbacks): void {
    this.callbacks = callbacks;
    this.stopped   = false;
    void this._tick();
    this.pollTimer = setInterval(() => void this._tick(), this.pollSeconds * 1_000);
  }

  isCurrentLeader(): boolean {
    return this.isLeader;
  }

  /** Stop the election loop and release the lease if held. Call on
   *  process shutdown so a clean exit frees the lease immediately instead
   *  of waiting out the TTL. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer)  clearInterval(this.pollTimer);
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.pollTimer  = null;
    this.renewTimer = null;
    if (this.isLeader) {
      this.isLeader = false;
      await this.lock.release();
    }
  }

  private async _tick(): Promise<void> {
    if (this.stopped) return;

    if (this.isLeader) {
      // Already leader — confirm we still genuinely hold the lease rather
      // than trusting the renewal interval's own silent success. See this
      // module's docstring: preventing two simultaneous leaders matters
      // more here than never having zero for a few seconds.
      const stillLeader = await this.lock.isStillLeader();
      if (!stillLeader) this._demote();
      return;
    }

    const acquired = await this.lock.tryAcquire();
    if (!acquired || this.stopped) return;

    this.isLeader = true;
    console.log(`[feed-leader] this replica acquired TwelveData feed leadership`);
    this.renewTimer = this.lock.startRenewal(this.renewSeconds);
    this.callbacks?.onBecomeLeader();
  }

  private _demote(): void {
    console.warn(`[feed-leader] lost TwelveData feed leadership — stopping this replica's primary feed`);
    this.isLeader = false;
    if (this.renewTimer) { clearInterval(this.renewTimer); this.renewTimer = null; }
    this.callbacks?.onLoseLeadership();
  }
}
