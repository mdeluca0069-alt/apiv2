/**
 * order.dedup.guard.ts — short-window duplicate-submission guard.
 *
 * Milestone 1 / Fix #2. The existing (userId, clientOrderId) DB unique
 * constraint in order.lifecycle.ts only dedupes when the client reuses the
 * same clientOrderId — it does nothing when a UI bug fires two distinct
 * requests with two distinct generated IDs for what is, from the trader's
 * perspective, a single click (e.g. a confirmation dialog that reacts to
 * both a native button-focus Enter activation and a separate window
 * keydown handler in the same keypress). This guard closes that gap
 * server-side: an identical (userId, symbol, side, type, quantity, price)
 * order request arriving again within DEDUP_WINDOW_MS of the previous one
 * is rejected outright, rather than silently placing two real orders.
 *
 * Deliberately in-memory and per-process — this is a UX safety net against
 * accidental double-clicks/double-fires within a few seconds, not a
 * financial-integrity control (that's clientOrderId + DB constraints +
 * atomic margin locking, all unaffected by this file). A false negative
 * here (missed on a node the duplicate happens to land on in a multi-worker
 * deployment) is not a correctness regression — it just means this specific
 * safety net didn't happen to catch that one; the user could always have
 * legitimately placed the same order twice.
 */

export type DedupOrderShape = {
  symbol:   string;
  side:     string;
  type?:    string;
  quantity: number;
  price?:   number;
};

const DEDUP_WINDOW_MS = 3_000;
const MAX_TRACKED      = 5_000; // opportunistic cleanup trigger

const recentSubmissions = new Map<string, number>();

export function buildSubmissionKey(userId: string, req: DedupOrderShape): string {
  return [
    userId,
    req.symbol.toUpperCase(),
    req.side.toUpperCase(),
    (req.type ?? "MARKET").toUpperCase(),
    req.quantity,
    req.price ?? "MKT",
  ].join(":");
}

/**
 * Returns true if an identical order request was seen within the dedup
 * window and this request should be rejected. Always records the current
 * request's timestamp as a side effect (so a legitimate resubmission after
 * the window has elapsed is allowed through and itself starts a fresh window).
 */
export function isDuplicateSubmission(key: string, now: number = Date.now()): boolean {
  const last = recentSubmissions.get(key);
  recentSubmissions.set(key, now);

  if (recentSubmissions.size > MAX_TRACKED) {
    for (const [k, t] of recentSubmissions) {
      if (now - t > DEDUP_WINDOW_MS) recentSubmissions.delete(k);
    }
  }

  return last !== undefined && (now - last) < DEDUP_WINDOW_MS;
}

/** Test-only reset so specs don't leak state into each other. */
export function _resetDedupGuardForTests(): void {
  recentSubmissions.clear();
}
