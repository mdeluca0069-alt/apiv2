import { randomUUID }      from "node:crypto";
import { prisma }           from "../shared/db.js";
import {
  type PreTradeRiskResult,
  type RejectionReason,
} from "../shared/contracts.js";
import { leverageGuard }     from "./leverage.guard.js";
import { marginController }  from "./margin.controller.js";
import { killSwitch }        from "./kill.switch.js";
import { exposureRegistry }  from "./exposure.limits.js";
import { clientExposureLimits } from "./client.exposure.limits.js";
import { correlationGuard }     from "./correlation.guard.js";

export type PreTradeInput = {
  userId:          string;
  symbol:          string;
  side:            "BUY" | "SELL";
  quantity:        number;
  requestedPrice?: number;
  leverage:        number;
  clientOrderId?:  string;
  midPrice:        number;
};

// ── In-process caches for data that is static during a trading session ──────
// user KYC/tier and instrument config change rarely; caching them eliminates
// 2 DB round trips per preTradeCheck, preventing connection-pool saturation
// under 250+ concurrent users without sacrificing correctness (the hard
// margin check inside checkAndLockMargin still uses a live FOR UPDATE read).
type CachedUser       = { kycStatus: string; tier: string };
type CachedInstrument = { assetClass: string; minTradeSize: import("@prisma/client/runtime/library").Decimal; maxLeverageRetail: number };

const userCache:       Map<string, { data: CachedUser | null;       expiresAt: number }> = new Map();
const instrumentCache: Map<string, { data: CachedInstrument | null; expiresAt: number }> = new Map();
const USER_CACHE_TTL_MS       = 60_000;   // 1 minute — KYC status is admin-only
const INSTRUMENT_CACHE_TTL_MS = 300_000;  // 5 minutes — instrument config is static

async function getCachedUser(userId: string): Promise<CachedUser | null> {
  const now = Date.now();
  const hit  = userCache.get(userId);
  if (hit && hit.expiresAt > now) return hit.data;
  const row = await (prisma as NonNullable<typeof prisma>).user.findUnique({
    where: { id: userId }, select: { kycStatus: true, tier: true },
  });
  userCache.set(userId, { data: row as CachedUser | null, expiresAt: now + USER_CACHE_TTL_MS });
  return row as CachedUser | null;
}

async function getCachedInstrument(symbol: string): Promise<CachedInstrument | null> {
  const now = Date.now();
  const hit  = instrumentCache.get(symbol);
  if (hit && hit.expiresAt > now) return hit.data;
  const row = await (prisma as NonNullable<typeof prisma>).instrument.findUnique({
    where: { symbol }, select: { assetClass: true, minTradeSize: true, maxLeverageRetail: true },
  });
  instrumentCache.set(symbol, { data: row as CachedInstrument | null, expiresAt: now + INSTRUMENT_CACHE_TTL_MS });
  return row as CachedInstrument | null;
}

export class RiskEngine {
  /**
   * Full pre-trade risk check pipeline.
   * Target latency: < 5ms (all queries run in parallel where possible).
   */
  async preTradeCheck(input: PreTradeInput): Promise<PreTradeRiskResult> {
    const startMs = Date.now();

    // ── 1. Kill switch — fastest check, no DB call ────────────────────────
    if (killSwitch.isActive()) {
      const ks = killSwitch.getState();
      return this._reject("KILL_SWITCH_ACTIVE", ks.reason || "Admin kill switch active");
    }

    // ── 2. Parallel: KYC + instrument (cached) + duplicate check ─────────
    // user and instrument are served from in-process TTL caches to avoid
    // 2 DB round trips per order under load. The duplicate check only runs
    // when the client provides a clientOrderId (idempotency key).
    const [user, instrument, duplicate] = await Promise.all([
      getCachedUser(input.userId),
      getCachedInstrument(input.symbol.toUpperCase()),
      input.clientOrderId
        ? (prisma as NonNullable<typeof prisma>).order.findUnique({
            where: {
              userId_clientOrderId: {
                userId:        input.userId,
                clientOrderId: input.clientOrderId,
              },
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    if (!user) return this._reject("KYC_NOT_APPROVED", "User not found");

    if (user.kycStatus !== "approved") {
      return this._reject(
        "KYC_NOT_APPROVED",
        `KYC status is '${user.kycStatus}'. Trading requires approved KYC.`,
      );
    }

    if (duplicate) {
      return this._reject(
        "DUPLICATE_CLIENT_ORDER_ID",
        `clientOrderId '${input.clientOrderId}' already exists`,
      );
    }

    if (!instrument) {
      return this._reject("INSTRUMENT_NOT_FOUND", `${input.symbol} is not a tradeable instrument`);
    }

    // ── 3. Leverage cap (ESMA) ────────────────────────────────────────────
    const lvResult        = leverageGuard.check(instrument.assetClass, input.leverage);
    const effectiveLeverage = lvResult.effectiveLeverage;

    // ── 4. Minimum trade size ─────────────────────────────────────────────
    const minSize = instrument.minTradeSize.toNumber();
    if (input.quantity < minSize) {
      return this._reject(
        "POSITION_SIZE_EXCEEDS_LIMIT",
        `Minimum trade size for ${input.symbol} is ${minSize}`,
      );
    }

    // ── 5. Compute notional + required margin ─────────────────────────────
    const execPrice      = input.requestedPrice ?? input.midPrice;
    const notional       = leverageGuard.computeNotional(input.quantity, execPrice);
    const marginRequired = leverageGuard.computeMarginRequired(notional, effectiveLeverage);

    // ── 6. Margin availability ────────────────────────────────────────────
    let marginState;
    try {
      marginState = await marginController.getMarginState(input.userId);
    } catch (err) {
      return this._reject(
        "WALLET_NOT_FOUND",
        `No wallet for user ${input.userId}`,
      );
    }

    if (!marginController.canAcceptOrder(marginState, marginRequired)) {
      return this._reject(
        "INSUFFICIENT_MARGIN",
        `Need ${marginRequired.toFixed(2)} USD margin; only ${marginState.freeMargin.toFixed(2)} USD free`,
      );
    }

    // ── 7. Max position size (50% of equity per single trade) ────────────
    const positionPct = (marginRequired / marginState.equity) * 100;
    if (positionPct > 50) {
      return this._reject(
        "POSITION_SIZE_EXCEEDS_LIMIT",
        `Order requires ${positionPct.toFixed(1)}% of account equity`,
      );
    }

    // ── 7b. Per-client aggregate exposure cap ─────────────────────────────
    // RISK_ENGINE_FREEZE.md §3.1: no cap previously existed on a single
    // client's total open notional or concurrent position count. A client
    // with enough equity/margin could concentrate into an unbounded number
    // of large positions even though each individual order passed every
    // other check. Tier-keyed limits (client.exposure.limits.ts).
    const clientExposureCheck = await clientExposureLimits.check(input.userId, user.tier, notional);
    if (!clientExposureCheck.ok) {
      return this._reject(clientExposureCheck.reason, clientExposureCheck.detail);
    }

    // ── 7c. Correlation-aware risk check (manual/API orders) ──────────────
    // RISK_ENGINE_FREEZE.md §3.3: the real Pearson correlation engine was
    // only ever consulted by the autopilot pipeline (soft size halving) --
    // manual/API orders, the majority of trading volume, had zero
    // correlation awareness. A manual order's quantity is a client contract,
    // so this blocks outright rather than silently resizing.
    const correlationCheck = await correlationGuard.check(input.userId, input.symbol.toUpperCase(), input.side);
    if (!correlationCheck.ok) {
      return this._reject(correlationCheck.reason, correlationCheck.detail);
    }

    // ── 8. Global instrument exposure check ──────────────────────────────
    // Prevents unhedged B-book exposure from exceeding configurable limits
    // per instrument. Checked here (pre-trade) so no position is ever opened
    // that would push the book beyond its risk appetite.
    const exposureCheck = exposureRegistry.checkCanOpen(input.symbol.toUpperCase(), input.side, notional);
    if (!exposureCheck.ok) {
      return this._reject("INSTRUMENT_HALTED", exposureCheck.detail);
    }

    // ── Audit pass ────────────────────────────────────────────────────────
    const latencyMs = Date.now() - startMs;
    void prisma.auditLog.create({
      data: {
        id:      randomUUID(),
        actor:   input.userId,
        action:  "PRE_TRADE_RISK_PASS",
        entity:  input.symbol,
        payload: {
          latencyMs,
          effectiveLeverage,
          marginRequired,
          notional,
          marginLevelPct: marginState.marginLevelPct,
        } as object,
      },
    });

    return { pass: true, marginRequired, notional, effectiveLeverage };
  }

  private _reject(reason: RejectionReason, detail: string): PreTradeRiskResult {
    return { pass: false, reason, detail };
  }
}

export const riskEngine = new RiskEngine();
