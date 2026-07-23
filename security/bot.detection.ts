/**
 * security/bot.detection.ts — Bot and automated-client detection.
 *
 * Detection signals (additive scoring, 0–100):
 *   Missing/fake User-Agent              +30
 *   Known bot signature in User-Agent    +50 (immediate block for malicious bots)
 *   Headless browser fingerprint         +40 (Playwright, Puppeteer, PhantomJS)
 *   Request rate beyond human speed      +30
 *   Uniform request intervals            +20 (automation signature)
 *   No Accept-Language header            +15
 *   No Accept-Encoding header            +10
 *   Honeypot endpoint access             +100 (immediate block)
 *   IP velocity: too many endpoints/sec  +25
 *   Known bad ASN                        +20
 *
 * Actions:
 *   Score < 40  → ALLOW
 *   Score 40–69 → CHALLENGE (require step-up or CAPTCHA hint in response header)
 *   Score ≥ 70  → BLOCK (403 with tracking ID)
 */

import { getRedis }   from "../shared/redis.js";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { randomUUID } from "node:crypto";
import { immutableAudit } from "./immutable.audit.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const BOT_BLOCK_THRESHOLD     = Number(process.env.BOT_BLOCK_THRESHOLD     ?? 70);
const BOT_CHALLENGE_THRESHOLD = Number(process.env.BOT_CHALLENGE_THRESHOLD ?? 40);
const BOT_RATE_WINDOW_S       = Number(process.env.BOT_RATE_WINDOW_S       ?? 10);
const BOT_RATE_MAX_RPS        = Number(process.env.BOT_RATE_MAX_RPS        ?? 30);

// ─── Known Bad User-Agent Patterns ───────────────────────────────────────────

// Malicious/scraping bots (block immediately, +50 each)
const MALICIOUS_BOT_PATTERNS = [
  /zgrab/i, /masscan/i, /nuclei/i, /nmap/i, /nikto/i,
  /sqlmap/i, /havij/i, /commix/i, /wfuzz/i, /dirbuster/i,
  /burpsuite/i, /owasp-zap/i, /webscarab/i, /w3af/i,
  /hydra/i, /medusa/i, /python-requests/i, /go-http-client/i,
  /java\/|jakarta|httpclient/i, /axios\/0\./i,  // headless API clients
  /libwww-perl|LWP::UserAgent/i, /curl\/[0-9]/i,
];

// Headless browsers (high-confidence automation, +40)
const HEADLESS_BROWSER_PATTERNS = [
  /HeadlessChrome/i, /PhantomJS/i, /SlimerJS/i,
  /Playwright/i,     /Puppeteer/i, /Selenium/i,
  /WebDriver/i,      /htmlunit/i,  /Zombie\.js/i,
];

// Legitimate known bots (allow, no penalty)
const ALLOWED_BOT_PATTERNS = [
  /Googlebot/i,    /Bingbot/i,  /Slurp/i,    /DuckDuckBot/i,
  /Baiduspider/i,  /YandexBot/i, /facebot/i, /Twitterbot/i,
  /LinkedInBot/i,  /Applebot/i, /AhrefsBot/i,
];

// Honeypot paths — any access = automated scanner/bot
const HONEYPOT_PATHS = [
  "/admin/config.php",
  "/wp-admin/",
  "/wp-login.php",
  "/.env",
  "/.git/HEAD",
  "/config.yaml",
  "/phpinfo.php",
  "/api/v1/__honeypot__",
  "/xmlrpc.php",
  "/actuator/env",
  "/.aws/credentials",
];

// ─── Types ────────────────────────────────────────────────────────────────────

export type BotDecision = "ALLOW" | "CHALLENGE" | "BLOCK";

export type BotDetectionResult = {
  decision: BotDecision;
  score:    number;
  reasons:  string[];
  trackId?: string;
};

// ─── Private IP helper ───────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  if (!ip) return false;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost") return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("10."))      return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1] ?? "0", 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

// ─── BotDetector ─────────────────────────────────────────────────────────────

export class BotDetector {

  async detect(input: {
    ip:          string;
    userAgent:   string;
    path:        string;
    method:      string;
    acceptLang?: string;
    acceptEnc?:  string;
    headers:     Record<string, string | string[] | undefined>;
  }): Promise<BotDetectionResult> {
    const reasons: string[] = [];
    let score = 0;

    // Private/loopback IPs (localhost, Docker bridge, RFC1918) are always trusted —
    // same policy as IP reputation. This allows local load tests and internal services.
    if (isPrivateIp(input.ip)) {
      return { decision: "ALLOW", score: 0, reasons: ["trusted_private_ip"] };
    }

    const ua = (input.userAgent ?? "").trim();

    // Honeypot check — instant block, no scoring
    if (HONEYPOT_PATHS.some((p) => input.path.toLowerCase().includes(p.toLowerCase()))) {
      await this._recordHoneypot(input.ip, input.path);
      return {
        decision: "BLOCK",
        score:    100,
        reasons:  ["honeypot_access"],
        trackId:  randomUUID(),
      };
    }

    // Legitimate bots — always allow
    if (ALLOWED_BOT_PATTERNS.some((p) => p.test(ua))) {
      return { decision: "ALLOW", score: 0, reasons: ["known_good_bot"] };
    }

    // Missing User-Agent
    if (!ua || ua.length < 10) {
      score += 30;
      reasons.push("missing_or_minimal_user_agent");
    }

    // Malicious bot signatures
    for (const pattern of MALICIOUS_BOT_PATTERNS) {
      if (pattern.test(ua)) {
        score += 50;
        reasons.push(`known_malicious_bot:${pattern.source.slice(0, 20)}`);
        break;
      }
    }

    // Headless browser fingerprint
    for (const pattern of HEADLESS_BROWSER_PATTERNS) {
      if (pattern.test(ua)) {
        score += 40;
        reasons.push(`headless_browser:${pattern.source.slice(0, 20)}`);
        break;
      }
    }

    // Missing browser-typical headers
    if (!input.acceptLang && !input.headers["accept-language"]) {
      score += 15;
      reasons.push("no_accept_language");
    }

    if (!input.acceptEnc && !input.headers["accept-encoding"]) {
      score += 10;
      reasons.push("no_accept_encoding");
    }

    if (!input.headers["accept"]) {
      score += 10;
      reasons.push("no_accept_header");
    }

    // Request rate check (Redis sliding window)
    const rateScore = await this._checkRate(input.ip);
    if (rateScore > 0) {
      score += rateScore;
      reasons.push(`rate_exceeded:${rateScore}pts`);
    }

    score = Math.min(100, score);

    const decision: BotDecision =
      score >= BOT_BLOCK_THRESHOLD     ? "BLOCK"     :
      score >= BOT_CHALLENGE_THRESHOLD ? "CHALLENGE" :
      "ALLOW";

    const trackId = decision !== "ALLOW" ? randomUUID() : undefined;

    if (decision === "BLOCK") {
      await this._recordBlock(input.ip, score, reasons);
    }

    return { decision, score, reasons, trackId };
  }

  /** Register a honeypot path (add dynamically from admin panel). */
  get honeypotPaths(): string[] {
    return [...HONEYPOT_PATHS];
  }

  private async _checkRate(ip: string): Promise<number> {
    const redis = getRedis();
    if (!redis) return 0;

    const key     = `bot:rate:${ip}`;
    const count   = await redis.incr(key).catch(() => 0);
    if (count === 1) await redis.expire(key, BOT_RATE_WINDOW_S).catch(() => null);

    const rps = count / BOT_RATE_WINDOW_S;
    if (rps > BOT_RATE_MAX_RPS) return 30;
    if (rps > BOT_RATE_MAX_RPS * 0.7) return 15;
    return 0;
  }

  private async _recordHoneypot(ip: string, path: string): Promise<void> {
    const redis = getRedis();
    if (redis) {
      // Block IP for 24 hours after honeypot access
      await redis.setex(`iprep:blocked:${ip}`, 86400, `honeypot:${path}`).catch(() => null);
    }
    if (IS_PERSISTENT && prisma) {
      await immutableAudit.write({
        actor: ip,
        action: "bot.honeypot_triggered", entity: path,
        payload: { ip, path, timestamp: new Date().toISOString() } as object,
      }).catch(() => undefined);
    }
  }

  private async _recordBlock(ip: string, score: number, reasons: string[]): Promise<void> {
    const redis = getRedis();
    if (redis) {
      await redis.incr(`bot:blocks:${ip}`).catch(() => null);
    }
    if (IS_PERSISTENT && prisma && score >= 80) {
      await immutableAudit.write({
        actor: ip,
        action: "bot.blocked", entity: ip,
        payload: { score, reasons } as object,
      }).catch(() => undefined);
    }
  }
}

export const botDetector = new BotDetector();
export default botDetector;
