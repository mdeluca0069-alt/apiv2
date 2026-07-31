/**
 * PHASE2_REMEDIATION (H8): per-connection WS sequence-number assignment.
 *
 * Extracted as its own pure function (main.ts is a top-level bootstrap
 * script with side-effecting module-load code -- process.exit() on missing
 * secrets, real DB/Redis connections, etc. -- and is never imported by the
 * test suite) so this specific piece of logic can be independently
 * regression-tested without booting the whole server.
 *
 * Root cause this replaces: the original implementation was a
 * `Map<userId, number>`, a single counter SHARED by every socket open for
 * that user on this node. A user with two simultaneous connections (same
 * node, multi-tab/multi-device -- routine on a trading platform) had both
 * sockets incrementing the same counter, so each socket only observed a
 * subset of the increments and saw artificial gaps in what
 * api/websocket.ts's client (which resets `lastSeq = null` on every fresh
 * `onopen` and flags `seq <= lastSeq` as a regression) expects to be a
 * clean, connection-anchored series starting at 1.
 *
 * Fix: the counter lives on the connection object itself (the same
 * established pattern main.ts already uses for other per-connection
 * mutable state, e.g. AuthenticatedSocket.isAlive/backpressureStrikes),
 * so every socket gets its own independent series regardless of how many
 * other connections the same user has open.
 */
export interface SequencedConnection {
  seq?: number;
}

export function nextConnectionSeq(conn: SequencedConnection): number {
  const next = (conn.seq ?? 0) + 1;
  conn.seq = next;
  return next;
}
