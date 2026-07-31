/**
 * shared/client-ip.ts — canonical client-IP extraction.
 *
 * PHASE2_REMEDIATION (H18): every IP-derived security control in this
 * codebase (rate limiting, IP reputation/blocking, credential-stuffing/
 * API-scanner detection, device fingerprinting, suspicious-login tracking)
 * previously trusted `X-Forwarded-For`'s first entry directly, with no
 * validation of how many proxy hops actually sit in front of this process.
 *
 * Root cause: nginx.conf's `proxy_set_header X-Forwarded-For
 * $proxy_add_x_forwarded_for` APPENDS nginx's view of the client to
 * whatever XFF value the client already sent, rather than replacing it (now
 * fixed to `$remote_addr`, see nginx.conf). But relying on nginx alone is
 * fragile -- any future deployment path (a different proxy, a CDN, a
 * misconfigured load balancer, or a direct connection with no proxy at
 * all) that doesn't get this exactly right silently reopens the spoofing
 * hole. So this module also enforces trust at the application layer: XFF/
 * X-Real-IP are only honored when the immediate TCP peer
 * (`req.socket.remoteAddress`) is itself a configured trusted proxy --
 * otherwise every header is attacker-controlled and the raw socket address
 * (which a client cannot forge) is used instead.
 *
 * `TRUSTED_PROXY_IPS` (comma-separated) lets each deployment declare which
 * peer(s) are legitimate reverse proxies. Defaults to loopback, matching
 * nginx.conf's documented topology (nginx and the PM2 cluster on the same
 * host, proxying to 127.0.0.1:3001).
 */
import type { IncomingMessage } from "node:http";

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function isValidIp(ip: string): boolean {
  if (IPV4_RE.test(ip)) return ip.split(".").every((octet) => Number(octet) <= 255);
  return ip.includes(":") && IPV6_RE.test(ip);
}

function trustedProxyIps(): Set<string> {
  const raw = process.env.TRUSTED_PROXY_IPS ?? "127.0.0.1,::1,::ffff:127.0.0.1";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * Returns the best-known client IP for this request. Never returns a
 * value an unauthenticated remote attacker can freely choose: forwarded
 * headers are only trusted when the direct TCP peer is a known proxy.
 */
export function getClientIp(req: IncomingMessage): string {
  const socketIp = req.socket?.remoteAddress ?? "unknown";

  if (!trustedProxyIps().has(socketIp)) {
    return socketIp;
  }

  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) {
    const first = xff.split(",")[0]?.trim();
    if (first && isValidIp(first)) return first;
  }

  const xrip = req.headers["x-real-ip"];
  if (typeof xrip === "string" && xrip.trim() && isValidIp(xrip.trim())) {
    return xrip.trim();
  }

  return socketIp;
}
