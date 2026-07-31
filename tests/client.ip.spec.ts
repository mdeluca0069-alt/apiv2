/**
 * client.ip.spec.ts
 *
 * PHASE2_REMEDIATION (H18) — every IP-derived security control (rate
 * limiter, IP reputation/blocking, credential-stuffing detection, device
 * fingerprinting, suspicious-login tracking) previously trusted
 * X-Forwarded-For's leftmost entry unconditionally, with no validation of
 * whether the request actually passed through a trusted reverse proxy.
 * Compounded by nginx.conf's `$proxy_add_x_forwarded_for`, which APPENDED
 * to (rather than replaced) a client-supplied XFF value -- an attacker
 * could set their own "X-Forwarded-For: 1.2.3.4" on a direct request and
 * have it trusted as their client IP on every single request, defeating
 * all IP-keyed rate limiting and lockouts (a different forged IP per
 * request).
 *
 * getClientIp() only trusts forwarded headers when the immediate TCP peer
 * (req.socket.remoteAddress) is itself a configured trusted proxy --
 * otherwise the raw (unforgeable) socket address is used regardless of
 * what headers the client sent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { IncomingMessage } from "node:http";
import { getClientIp } from "../shared/client-ip.js";

function fakeReq(opts: { remoteAddress: string; headers?: Record<string, string> }): IncomingMessage {
  return {
    socket: { remoteAddress: opts.remoteAddress },
    headers: opts.headers ?? {},
  } as unknown as IncomingMessage;
}

const ORIGINAL_ENV = process.env.TRUSTED_PROXY_IPS;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.TRUSTED_PROXY_IPS;
  else process.env.TRUSTED_PROXY_IPS = ORIGINAL_ENV;
});

describe("getClientIp() — PHASE2_REMEDIATION (H18): X-Forwarded-For spoofing", () => {
  beforeEach(() => {
    delete process.env.TRUSTED_PROXY_IPS; // defaults to loopback
  });

  it("ignores a forged X-Forwarded-For from a DIRECT (untrusted) connection -- the core spoofing bug", async () => {
    const req = fakeReq({
      remoteAddress: "203.0.113.99", // attacker's real, direct connection
      headers: { "x-forwarded-for": "1.2.3.4" }, // attacker-forged header
    });

    expect(getClientIp(req)).toBe("203.0.113.99");
  });

  it("a different forged X-Forwarded-For on every request from the same attacker still resolves to the SAME real socket IP", async () => {
    const attempts = ["9.9.9.9", "8.8.8.8", "1.1.1.1"].map((forged) =>
      getClientIp(fakeReq({ remoteAddress: "203.0.113.99", headers: { "x-forwarded-for": forged } })),
    );

    expect(new Set(attempts).size).toBe(1);
    expect(attempts[0]).toBe("203.0.113.99");
  });

  it("trusts X-Forwarded-For's first entry when the peer IS the configured trusted proxy (loopback default)", async () => {
    const req = fakeReq({
      remoteAddress: "127.0.0.1", // nginx, on the same host
      headers: { "x-forwarded-for": "198.51.100.7" }, // real client IP nginx observed
    });

    expect(getClientIp(req)).toBe("198.51.100.7");
  });

  it("from a trusted proxy, takes the LEFTMOST entry of a multi-hop XFF chain", async () => {
    const req = fakeReq({
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.5" },
    });

    expect(getClientIp(req)).toBe("198.51.100.7");
  });

  it("falls back to the socket address when a trusted proxy sends a malformed (non-IP) XFF value", async () => {
    const req = fakeReq({
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "'; DROP TABLE users;--" },
    });

    expect(getClientIp(req)).toBe("127.0.0.1");
  });

  it("falls back to X-Real-IP when a trusted proxy sends no X-Forwarded-For", async () => {
    const req = fakeReq({
      remoteAddress: "::1",
      headers: { "x-real-ip": "198.51.100.42" },
    });

    expect(getClientIp(req)).toBe("198.51.100.42");
  });

  it("respects TRUSTED_PROXY_IPS overrides for non-loopback proxy topologies (e.g. a Docker network)", async () => {
    process.env.TRUSTED_PROXY_IPS = "172.18.0.5";

    const fromProxy = getClientIp(fakeReq({ remoteAddress: "172.18.0.5", headers: { "x-forwarded-for": "198.51.100.7" } }));
    expect(fromProxy).toBe("198.51.100.7");

    const fromLoopbackNowUntrusted = getClientIp(fakeReq({ remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "1.2.3.4" } }));
    expect(fromLoopbackNowUntrusted).toBe("127.0.0.1"); // no longer in the trusted set
  });
});
