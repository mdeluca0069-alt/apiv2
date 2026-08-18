# Finnhub Staging Market-Data Provider — Implementation Report

**Status: implementation complete and verified in isolation (unit tests + TypeScript). Real 3-replica live staging verification has NOT been performed. No deployment has occurred.**

---

## A. Purpose

Demonstrate, end-to-end, that igfxpro-apiv2's Market Data Engine is genuinely **provider-agnostic** — able to source live prices from a provider other than TwelveData without any change to the execution/risk path — by adding **Finnhub Free** as a second, opt-in, STAGING-ONLY market-data source.

This is explicitly **not** a production provider migration. In production, the eventual acquirer/operator configures their own commercial market-data provider and credentials. Finnhub Free is used here only because it requires no paid plan and lets the engine's freshness/staleness/health/leader-election/relay machinery be exercised against a real external feed at zero cost.

## B. Files implemented

**New:**
- `market-data/feeds/finnhub.feed.ts` — WebSocket adapter
- `market-data/feeds/finnhub.rest.ts` — REST (tertiary poll) adapter
- `tests/finnhub.feed.spec.ts`
- `tests/finnhub.rest.spec.ts`
- `tests/feed.manager.finnhub.gating.spec.ts`
- `tests/feed.leader.election.finnhub.spec.ts`

**Modified (all additive, all gated):**
- `market-data/feed.manager.ts` — new `finnhub-ws`/`finnhub-rest` `FeedName`s, optional `FeedManagerOptions.finnhub`, `startFinnhub()`/`stopFinnhub()`/`isFinnhubRunning()`
- `main.ts` — `MARKET_DATA_STAGING_PROVIDER`/`FINNHUB_API_KEY` reading, `FeedManager` wiring, second `FeedLeaderElection` instance, shutdown hook
- `.env.example` — documents the new opt-in flag
- `security/owasp.mitigations.ts` — adds `ws.finnhub.io` to `EXTERNAL_DOMAIN_ALLOWLIST`

**Explicitly NOT modified:** `quote.cache.ts`, `internal.liquidity.core.ts`, `feed.health.monitor.ts`, `realtime-infra/redis.pubsub.ts`, `market-data/relay.tick.applier.ts`, `market-data/feed.leader.election.ts`, `twelvedata.feed.ts`, `twelvedata.rest.ts`, `binance.feed.ts` — all reused exactly as-is, proving they were already provider-agnostic.

## C. Architecture

```
                 MARKET_DATA_STAGING_PROVIDER=finnhub  +  FINNHUB_API_KEY
                                    │
                                    ▼
FeedManager.startFinnhub()  ◄── onBecomeLeader ── FeedLeaderElection("market-data-finnhub")
      │
      ├── FinnhubFeed (WS)  ──► onQuote ──► ingestExternalPrice(..., "finnhub-ws")
      │                                          │
      └── finnhub.rest.ts (60s poll) ──► ingestExternalPrice(..., "finnhub-rest")
                                                  │
                                                  ▼
                                    InternalLiquidityCore / quoteCache
                                    (UNCHANGED — same STALE_THRESHOLD_MS,
                                     SOURCE_PRIORITY, NO_LIVE_MARKET_DATA
                                     guard as every other source)
                                                  │
                                                  ▼
                                redisPubSub.publishTick() (UNCHANGED — CH_TICK)
                                                  │
                              other 2 replicas: applyRelayedTick() (UNCHANGED)
```

No new quote format, no new ingestion path, no new lock mechanism — Finnhub plugs into every existing seam (`ingestExternalPrice`, the tick relay, `FeedLeaderElection`) unmodified.

## D. Finnhub adapter behavior (`finnhub.feed.ts`)

- Connects to `wss://ws.finnhub.io?token=<FINNHUB_API_KEY>`.
- Sends **one `{"type":"subscribe","symbol":"<SYM>"}` message per symbol** on `open` (Finnhub has no comma-joined batch subscribe, unlike TwelveData).
- Symbol scope: exactly `AAPL`, `MSFT`, `NVDA`, `TSLA`, `AMZN` (Finnhub's own US-equity ticker format — identical to IGFX's, no translation table needed).
- Normalizes `{"type":"trade","data":[{"s":...,"p":...}]}` frames into the exact same `NormalizedQuote` type `twelvedata.feed.ts`/`binance.feed.ts` already produce (90/10 price smoothing, half-spread bid/ask synthesis since Finnhub's free trade stream carries no bid/ask field, `isRealSpread: false`).
- `{"type":"error",...}` frames surfaced via `onError`; any other frame type (Finnhub keepalives, etc.) silently ignored, same conservative handling as `twelvedata.feed.ts`.
- Reconnect: identical exponential backoff (1s → 30s cap) and `onReconnect` contract as the other two feeds.

## E. REST fallback (`finnhub.rest.ts`)

- `GET https://finnhub.io/api/v1/quote?symbol=<SYM>&token=<KEY>` — **one HTTP call per symbol**, issued **sequentially** (never `Promise.all`), since Finnhub's free plan has no batch `/quote` endpoint.
- Polling interval: **60s** (`FINNHUB_REST_ROTATION_MS`, a constant local to the Finnhub wiring — `twelvedata.rest.ts`'s own `REST_ROTATION_MS`/batching untouched).
- Runs continuously alongside the WS feed (same "tertiary poll always-on" design TwelveData already uses — not merely a failover trigger), started/stopped together by `startFinnhub()`/`stopFinnhub()`.
- One symbol's request failure does not abort the batch — each symbol is wrapped independently, logged, and skipped.
- Self-contained `httpsGet` (not shared with `twelvedata.rest.ts`) — this whole adapter can be removed with a single `rm market-data/feeds/finnhub.*.ts`, no cleanup required elsewhere.

## F. WebSocket behavior — summary of guarantees

| Property | Behavior |
|---|---|
| Auth | Token in query string (`?token=`), matches Finnhub's documented auth mechanism |
| Token in logs | Redacted (`token=REDACTED`) in every WS error message; never present in REST error logs (verified by a dedicated test) |
| Malformed frames | Caught, ignored, never throws |
| Unknown message types | Ignored (no assumption about undocumented Finnhub message shapes) |
| Reconnect after intentional `stop()` | Never happens (verified by test) |

## G. Provider gating

```ts
const finnhubStagingEnabled = marketDataStagingProvider === "finnhub" && !!finnhubKey;
```
Both `MARKET_DATA_STAGING_PROVIDER=finnhub` **and** a non-empty `FINNHUB_API_KEY` are required. When either is absent:
- `FeedManagerOptions.finnhub` is `undefined`
- `finnhubLeaderElection` is `null`
- `FinnhubFeed` is never constructed, `finnhub.rest.ts` is never called, no timer, no Redis key, no WebSocket connection, on **any** replica.

This is the default state — TwelveData/Binance behavior is byte-for-byte unchanged, proven by the full pre-existing test suite passing unmodified (see §L) and by a dedicated regression test (`feed.manager.finnhub.gating.spec.ts`) that exercises `startFinnhub()` with the option omitted and asserts zero side effects.

## H. Leader-election design

Reuses `market-data/feed.leader.election.ts` **completely unmodified** (0 diff — confirmed). A second, independent `FeedLeaderElection` instance is constructed with its own job id:

```ts
new FeedLeaderElection("market-data-finnhub")
```

separate from TwelveData's `FEED_LEADER_JOB_ID` (`"market-data-twelvedata-leader"`). Both leases live in the same Redis instance under distinct keys (`job:leader:market-data-finnhub` vs `job:leader:market-data-twelvedata-leader"`), acquired via the same atomic `SET NX EX` `DistributedJobLock` primitive — no second lock mechanism was created. `onBecomeLeader`/`onLoseLeadership` call `feedManager.startFinnhub()`/`stopFinnhub()`, structurally identical to how TwelveData's leadership already drives `startPrimary()`/`stopPrimary()`.

## I. Multi-replica safety

- Exactly one replica can hold the `market-data-finnhub` lease at a time (atomic Redis `SET NX EX`) — proven for the general mechanism in commit `6319805` (TwelveData), and proven for this specific job id in `tests/feed.leader.election.finnhub.spec.ts` (single-leader race, no-double-leader-after-reconnect, and a dedicated test racing the TwelveData and Finnhub elections concurrently against the *same* shared Redis store, confirming the two job families never contend for each other's lock).
- If the Finnhub-leader replica dies without a clean release, the lease TTL (30s, same defaults as TwelveData) expires and a follower takes over automatically — tested (lease-expiry failover scenario).
- The two non-leader replicas receive Finnhub-sourced ticks exclusively via the existing Redis tick relay (`CH_TICK` / `applyRelayedTick`) — unmodified files, so this is inherited "for free," not re-implemented.
- Adding `finnhub-ws`/`finnhub-rest` to `FeedManager._checkHealth()`'s all-feeds-dead check does **not** change when the circuit breaker opens for the pre-existing TwelveData/Binance/TwelveData-REST trio: `.every()` requires *all* listed feeds dead, and the two Finnhub entries are permanently "dead" (never ticked) whenever the feature is disabled — proven by a dedicated timing-based regression test (`feed.manager.finnhub.gating.spec.ts`, "CRITICAL: circuit-breaker timing is unaffected by the Finnhub option").

## J. Security controls

- **SSRF**: no new dynamic-URL construction — `BASE_URL`/`WS_URL` are fixed constants, never built from request/user input. `ws.finnhub.io` was **added** to `EXTERNAL_DOMAIN_ALLOWLIST` (documentation/future-enforcement parity with the existing `finnhub.io` entry) — nothing removed or weakened.
- **Token handling**: never logged in WS error paths (redacted) or REST error paths (verified by test); passed only as a query parameter to the two documented Finnhub hosts.
- **Auth/authorization, rate limiting, CORS**: untouched — no route, no middleware, no auth path was modified by this work.
- **Stale-data / `NO_LIVE_MARKET_DATA`**: enforced entirely by unmodified `quote.cache.ts`/`internal.liquidity.core.ts` — Finnhub ticks flow through the exact same `ingestExternalPrice()` gate (sanity bounds, source-priority, staleness) as every other source. A symbol Finnhub doesn't cover (e.g. EURUSD, if TwelveData were also absent) is correctly left stale and orders against it correctly rejected — no synthetic/fabricated price path was added anywhere.
- **Live trading**: `LIVE_TRADING_ENABLED` reading (`security/live-trading.guard.ts`) untouched — zero diff.
- **FIX gateway**: untouched — zero diff.

## K. Tests

| File | Tests | Covers |
|---|---|---|
| `tests/finnhub.feed.spec.ts` | 13 | Connection, per-symbol subscribe, tick normalization (single + multi-symbol frames), non-trade/ping frames ignored, error frames, malformed frames, reconnect backoff, no-reconnect-after-stop, token redaction |
| `tests/finnhub.rest.spec.ts` | 6 | One request per symbol, strictly sequential (max 1 in-flight), successful Map result, one-symbol-failure doesn't abort batch, empty-list short-circuit, no token in logs |
| `tests/feed.manager.finnhub.gating.spec.ts` | 13 | Disabled-by-default no-op (WS/REST/timer never start), enabled start/stop/idempotency, REST polling cadence, independence from TwelveData primary leadership, full shutdown cleanup, **circuit-breaker timing invariance** (3 dedicated tests) |
| `tests/feed.leader.election.finnhub.spec.ts` | 8 | Single leader, no-double-leader under repeated polling, clean-release failover, crash/lease-expiry failover, no-simultaneous-leaders across a transition, independence from the TwelveData election on a shared Redis store |

**Total new: 40 tests, all passing.**

## L. Full verification results

```
tsc --noEmit           → 0 errors
Test Files              189 passed (189)
Tests                   1559 passed (1559)
Duration                59.83s
```

Includes every pre-existing test file, unmodified — direct proof of no TwelveData/Binance regression.

## M. What has NOT yet been verified

- **Real Finnhub WebSocket connectivity** — no live connection to `wss://ws.finnhub.io` has been made; all WS/REST behavior above is verified against mocks, not the real Finnhub service.
- **Real 3-API-replica staging behavior**: exactly-one-WS-connection-across-3-replicas, cross-replica Redis relay of real ticks, real leader failover (kill the leader container, confirm takeover), real health/staleness reporting under live conditions.
- **Actual free-tier behavior for these 5 symbols** in practice (rate-limit headroom, WS symbol-limit behavior, whether Finnhub's per-key concurrent-connection behavior matches TwelveData's — this was the reason TwelveData needed leader-gating in the first place; Finnhub's own concurrent-connection limit is not publicly documented and has not been empirically tested).
- Whether `NO_LIVE_MARKET_DATA` correctly triggers **live** for a symbol Finnhub doesn't cover, under real conditions (only proven at the unit/mock level here).

## N. Exact staging verification procedure required next

1. Build a new Docker image tagged distinctly (not `latest`, not overwriting any current staging tag).
2. Push to GHCR under the new tag only.
3. On the Hostinger staging VPS: pull the new image, set `MARKET_DATA_STAGING_PROVIDER=finnhub` and the existing `FINNHUB_API_KEY` in staging's env only (never on `api.igfxpro.com`/prod).
4. Deploy with `--scale api=3` (unchanged replica count) to staging only.
5. Verify: exactly one Finnhub WS connection across the 3 replicas; the other two show ticks arriving only via Redis relay; all 5 staging symbols become fresh; `/api/health` and market-data health report `finnhub-ws`/`finnhub-rest` correctly; no reconnect storm; no anomalous rate-limit errors.
6. Kill the leader replica's process/container; confirm a follower acquires `market-data-finnhub` leadership, opens exactly one new WS connection, ticks resume, no two simultaneous leaders at any point.
7. Confirm throughout: `LIVE_TRADING_ENABLED=false`, FIX disabled, `api.igfxpro.com` untouched, no DNS change.
8. Explicitly **do not** start a 24h soak as part of this step.

This procedure requires separate, explicit authorization before execution (build/push/deploy were out of scope for this task).

## O. Rollback procedure

Because every change is additive and gated:
- **Immediate rollback (no redeploy)**: unset `MARKET_DATA_STAGING_PROVIDER` (or leave it unset) on any environment — Finnhub is fully inert, TwelveData/Binance behavior reverts to today's exactly, with zero code change needed.
- **Full removal**: `rm market-data/feeds/finnhub.feed.ts market-data/feeds/finnhub.rest.ts`, revert the four modified files to their pre-Finnhub state (`git revert` the commit from Phase 4), no other file requires cleanup — by design, nothing outside these files ever references Finnhub.
- No database migration, no schema change, no infrastructure change was introduced, so rollback carries no data-loss risk.

## P. Production-readiness status

**Correctly scoped claim only:**

> Market Data Engine verified end-to-end with Finnhub Free staging provider for supported US equities (AAPL, MSFT, NVDA, TSLA, AMZN) — at the unit/mock verification level. Real 3-replica live staging verification is still pending.

**Explicitly NOT claimed, and must not be inferred from this report:**
- The Market Data Engine is **not** being declared "fully production-ready" on the basis of this work.
- Forex/commodity/index coverage via Finnhub Free (EURUSD, XAUUSD, US500, DE40, etc.) is **not** verified and is **not** assumed available — prior direct testing on this account's Finnhub free plan found real-time forex access denied despite WS subscribe appearing to succeed (documented in `feed.manager.ts`'s pre-existing header comment); this report does not revisit or resolve that finding.
- No live deployment has occurred.
- No DNS has changed.
- No v1 changes occurred.
- `LIVE_TRADING_ENABLED` remains `false` everywhere.
- FIX gateway remains disabled.
- `api.igfxpro.com` (production) is untouched — confirmed by zero diff on any production-domain-facing file or infrastructure config.
- The real 3-replica Finnhub staging verification (§N) has **not** been performed and remains the explicit next step, pending separate authorization.
