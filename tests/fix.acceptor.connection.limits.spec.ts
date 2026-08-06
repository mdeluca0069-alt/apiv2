/**
 * fix.acceptor.connection.limits.spec.ts
 *
 * FIX GATEWAY HARDENING — before this pass, FixAcceptor.onConnection()
 * accepted every incoming TCP connection unconditionally, before any FIX
 * protocol parsing or credential check happened (see
 * FIX_GATEWAY_EXPOSURE_REVIEW.md §5) — a public FIX port with no cap at
 * all is a trivial resource-exhaustion target. This proves the two new
 * caps (per-IP, global) are actually enforced by a real TCP server on a
 * real ephemeral port, not just asserted against mocked internals — a
 * rejected connection must never reach FixAcceptor.sessions at all.
 *
 * These tests never complete a FIX Logon handshake (irrelevant to what's
 * being tested) — they only open raw TCP connections and observe whether
 * FixAcceptor accepted or destroyed each one, via its own real getStats().
 */
import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { FixAcceptor, type FixExecutor, type FixCancelExecutor } from "../fix-gateway/fix.acceptor.js";

const noopExecutor: FixExecutor = async () => ({
  orderId: "x", execId: "x", status: "REJECTED", avgPx: 0, cumQty: 0, leavesQty: 0,
});
const noopCanceller: FixCancelExecutor = async () => ({
  orderId: "x", execId: "x", status: "REJECTED", avgPx: 0, cumQty: 0, leavesQty: 0,
});

function startAcceptor(opts: { maxConnectionsPerIp?: number; maxTotalConnections?: number }): Promise<{ acceptor: FixAcceptor; port: number }> {
  return new Promise((resolve) => {
    const acceptor = new FixAcceptor({
      compId: "IGFXPRO-TEST",
      port: 0, // ephemeral -- OS picks a free port
      executor: noopExecutor,
      canceller: noopCanceller,
      ...opts,
    });
    acceptor.start();
    // FixAcceptor.getStats().port reports the CONFIGURED port (0 here),
    // not the OS-assigned one -- read the real bound port off the
    // underlying net.Server directly. It binds synchronously within the
    // same tick chain after listen(), so poll briefly rather than assume
    // one setImmediate is always enough under test-runner load.
    const poll = () => {
      const addr = (acceptor as unknown as { server: net.Server | null }).server?.address();
      if (addr && typeof addr === "object") {
        resolve({ acceptor, port: addr.port });
      } else {
        setTimeout(poll, 10);
      }
    };
    poll();
  });
}

function connectRaw(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForClose(socket: net.Socket, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    socket.once("close", () => { clearTimeout(timer); resolve(true); });
    socket.once("error", () => { /* swallow -- close listener still resolves */ });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let activeAcceptor: FixAcceptor | null = null;
let activeSockets: net.Socket[] = [];

afterEach(() => {
  for (const s of activeSockets) { try { s.destroy(); } catch { /* ignore */ } }
  activeSockets = [];
  activeAcceptor?.stop();
  activeAcceptor = null;
});

describe("FixAcceptor connection limits", () => {
  it("REGRESSION GUARD: accepts up to maxConnectionsPerIp from the same IP, destroys the next one immediately", async () => {
    const { acceptor, port } = await startAcceptor({ maxConnectionsPerIp: 3, maxTotalConnections: 100 });
    activeAcceptor = acceptor;

    const sockets = await Promise.all([1, 2, 3].map(() => connectRaw(port)));
    activeSockets.push(...sockets);
    await sleep(100); // let onConnection's synchronous accept/track logic settle

    expect(acceptor.getStats().totalSessions).toBe(3);

    // 4th connection from the same 127.0.0.1 source must be rejected.
    const fourth = await connectRaw(port);
    activeSockets.push(fourth);
    const closed = await waitForClose(fourth, 1000);

    expect(closed).toBe(true);
    expect(acceptor.getStats().totalSessions).toBe(3); // still 3 -- the 4th never became a session
  });

  it("REGRESSION GUARD: accepts up to maxTotalConnections globally, destroys the next one immediately even with per-IP headroom left", async () => {
    const { acceptor, port } = await startAcceptor({ maxConnectionsPerIp: 100, maxTotalConnections: 2 });
    activeAcceptor = acceptor;

    const sockets = await Promise.all([1, 2].map(() => connectRaw(port)));
    activeSockets.push(...sockets);
    await sleep(100);

    expect(acceptor.getStats().totalSessions).toBe(2);

    const third = await connectRaw(port);
    activeSockets.push(third);
    const closed = await waitForClose(third, 1000);

    expect(closed).toBe(true);
    expect(acceptor.getStats().totalSessions).toBe(2);
  });

  it("releases a per-IP slot when a connection closes, allowing a new one to be accepted afterward", async () => {
    const { acceptor, port } = await startAcceptor({ maxConnectionsPerIp: 1, maxTotalConnections: 100 });
    activeAcceptor = acceptor;

    const first = await connectRaw(port);
    activeSockets.push(first);
    await sleep(100);
    expect(acceptor.getStats().totalSessions).toBe(1);

    // A 2nd connection while the 1st is still open must be rejected (cap=1).
    const secondRejected = await connectRaw(port);
    activeSockets.push(secondRejected);
    expect(await waitForClose(secondRejected, 1000)).toBe(true);
    expect(acceptor.getStats().totalSessions).toBe(1);

    // Close the 1st connection, freeing its slot.
    first.destroy();
    await sleep(150);
    expect(acceptor.getStats().totalSessions).toBe(0);

    // A brand new connection should now be accepted.
    const third = await connectRaw(port);
    activeSockets.push(third);
    await sleep(100);
    expect(acceptor.getStats().totalSessions).toBe(1);
    expect(third.destroyed).toBe(false);
  });

  it("defaults (no options passed) allow at least one connection -- sanity check against a misconfigured limit of 0", async () => {
    const { acceptor, port } = await startAcceptor({});
    activeAcceptor = acceptor;

    const one = await connectRaw(port);
    activeSockets.push(one);
    await sleep(100);
    expect(acceptor.getStats().totalSessions).toBe(1);
    expect(one.destroyed).toBe(false);
  });
});
