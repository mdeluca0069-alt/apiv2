/**
 * ESMA Rules — European Securities and Markets Authority retail CFD restrictions.
 *
 * Implements ESMA Product Intervention Decision (2018/796) and recurring renewals:
 *   • Leverage caps per asset class for retail clients
 *   • Margin close-out rule (50% of required margin)
 *   • Negative balance protection (absolute limit per account)
 *   • Risk warnings (standardised disclosure)
 *   • No monetary incentive to trade (no cash bonuses)
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";

// ─── ESMA Leverage Caps (Retail) ─────────────────────────────────────────────

export const ESMA_LEVERAGE_CAPS: Record<string, number> = {
  FX_MAJOR:  30,
  FX_MINOR:  20,
  INDEX:     20,
  COMMODITY: 10,
  EQUITY:    5,
  CRYPTO:    2,
};

export const ESMA_MARGIN_CLOSE_OUT_PCT = 50;  // 50% of required margin
export const ESMA_STOP_OUT_PCT         = 50;

// ─── ESMA Rules Engine ────────────────────────────────────────────────────────

export type LeverageCheckResult = {
  allowed:          boolean;
  requestedLeverage: number;
  maxLeverage:       number;
  cappedLeverage:    number;
  assetClass:        string;
};

export type NbpCheck = {
  protected:        boolean;
  maxLoss:          number;    // USD
  accountBalance:   number;
};

export class EsmaRulesEngine {

  checkLeverage(assetClass: string, requestedLeverage: number): LeverageCheckResult {
    const maxLeverage  = ESMA_LEVERAGE_CAPS[assetClass] ?? 2;
    const cappedLeverage = Math.min(requestedLeverage, maxLeverage);
    return {
      allowed:          requestedLeverage <= maxLeverage,
      requestedLeverage,
      maxLeverage,
      cappedLeverage,
      assetClass,
    };
  }

  applyNegativeBalanceProtection(rawPnl: number, accountBalance: number): number {
    // Client can never lose more than their account balance
    return Math.max(rawPnl, -accountBalance);
  }

  checkCloseOut(equity: number, marginRequired: number): boolean {
    if (marginRequired <= 0) return false;
    const marginLevel = (equity / marginRequired) * 100;
    return marginLevel <= ESMA_MARGIN_CLOSE_OUT_PCT;
  }

  getStandardRiskWarning(winRatePct: number): string {
    return (
      `${winRatePct.toFixed(0)}% of retail investor accounts lose money when trading CFDs with this provider. ` +
      `You should consider whether you understand how CFDs work and whether you can afford ` +
      `to take the high risk of losing your money.`
    );
  }

  async validateTrade(params: {
    userId:     string;
    assetClass: string;
    leverage:   number;
    notional:   number;
    margin:     number;
  }): Promise<{ ok: boolean; reason?: string; cappedLeverage: number }> {
    const lvCheck = this.checkLeverage(params.assetClass, params.leverage);
    if (!lvCheck.allowed) {
      return {
        ok:            false,
        reason:        `ESMA leverage cap: ${params.assetClass} max ${lvCheck.maxLeverage}×`,
        cappedLeverage: lvCheck.cappedLeverage,
      };
    }

    if (IS_PERSISTENT && prisma?.walletAccount) {
      const wallet = await (prisma as NonNullable<typeof prisma>).walletAccount.findUnique({
        where:  { userId: params.userId },
        select: { balance: true },
      });
      if (wallet && Number(wallet.balance) < params.margin) {
        return {
          ok: false,
          reason: "Insufficient balance after ESMA margin requirement",
          cappedLeverage: lvCheck.cappedLeverage,
        };
      }
    }

    return { ok: true, cappedLeverage: lvCheck.cappedLeverage };
  }
}

export const esmaRules = new EsmaRulesEngine();
export default esmaRules;
