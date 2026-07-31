/**
 * PHASE2_REMEDIATION (H8): WS sequence numbers must be scoped per-CONNECTION,
 * not shared across every socket a user happens to have open on this node.
 *
 * Root cause: main.ts previously kept a single `Map<userId, number>` counter
 * incremented by every call to sendToSocket() for that user, regardless of
 * which of the user's (possibly several) open sockets was being sent to. A
 * user with two simultaneous connections (multi-tab/multi-device) had both
 * sockets draining the SAME counter, so each socket's own seq stream had
 * gaps wherever the sibling socket's sends had consumed a number -- exactly
 * the kind of gap api/websocket.ts's client is designed to flag as a
 * sequence regression/loss, but here it would be a false signal produced by
 * the server's own bookkeeping, not a real dropped message.
 */
import { describe, it, expect } from "vitest";
import { nextConnectionSeq, type SequencedConnection } from "../realtime-infra/ws.sequence.js";

describe("nextConnectionSeq() — PHASE2_REMEDIATION (H8)", () => {
  it("starts a fresh connection's series at 1", () => {
    const conn: SequencedConnection = {};
    expect(nextConnectionSeq(conn)).toBe(1);
  });

  it("increments monotonically for repeated sends on the same connection", () => {
    const conn: SequencedConnection = {};
    const seqs = [nextConnectionSeq(conn), nextConnectionSeq(conn), nextConnectionSeq(conn)];
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("persists the running count onto the connection object itself", () => {
    const conn: SequencedConnection = {};
    nextConnectionSeq(conn);
    nextConnectionSeq(conn);
    expect(conn.seq).toBe(2);
  });

  it("gives two simultaneous connections for the SAME user fully independent, gap-free series", () => {
    // Simulates a user with two open tabs/devices -- two distinct socket
    // objects, each with its own `seq` field, as main.ts's AuthenticatedSocket
    // now models it (this is the exact scenario H8 was broken under: the old
    // userId-keyed shared Map would have interleaved these into a single
    // series with gaps on each individual socket).
    const socketA: SequencedConnection = {};
    const socketB: SequencedConnection = {};

    const a1 = nextConnectionSeq(socketA);
    const b1 = nextConnectionSeq(socketB);
    const a2 = nextConnectionSeq(socketA);
    const a3 = nextConnectionSeq(socketA);
    const b2 = nextConnectionSeq(socketB);

    expect([a1, a2, a3]).toEqual([1, 2, 3]);
    expect([b1, b2]).toEqual([1, 2]);
  });

  it("a new connection for the same user starts back at 1, independent of any other connection's count", () => {
    const staleSocket: SequencedConnection = {};
    for (let i = 0; i < 50; i++) nextConnectionSeq(staleSocket);
    expect(staleSocket.seq).toBe(50);

    const freshSocket: SequencedConnection = {};
    expect(nextConnectionSeq(freshSocket)).toBe(1);
  });
});
