import type { PrismaClient } from "@prisma/client";
import { getPsp, listPsps, type PspName } from "./psp/psp.adapter.js";
import { DepositStateMachine }             from "./deposit.state.machine.js";
import { WalletRepository }               from "../wallet-service/wallet.repository.js";
import { affiliateService }               from "../crm/affiliate.service.js";

export type InitiateDepositInput = {
  userId:    string;
  psp:       PspName;
  amount:    number;
  currency:  string;
  returnUrl: string;
};

export type InitiateDepositResult = {
  depositId:   string;
  redirectUrl: string;
  status:      "PENDING";
};

export type DepositStatusResult = {
  depositId:    string;
  status:       string;
  psp:          string;
  amount:       number;
  currency:     string;
  redirectUrl?: string | null;
  failReason?:  string | null;
  requestedAt:  string;
  creditedAt?:  string | null;
};

const MIN_DEPOSIT_USD = 10;
const MAX_DEPOSIT_USD = 100_000;

export class PaymentService {
  private readonly stateMachine: DepositStateMachine;
  private readonly walletRepo:   WalletRepository;

  constructor(private readonly db: PrismaClient) {
    this.stateMachine = new DepositStateMachine(db);
    this.walletRepo   = new WalletRepository(db);
  }

  availablePsps(): PspName[] {
    return listPsps();
  }

  async initiateDeposit(input: InitiateDepositInput): Promise<InitiateDepositResult> {
    if (input.amount < MIN_DEPOSIT_USD) {
      throw Object.assign(new Error(`DEPOSIT_TOO_SMALL:minimum is ${MIN_DEPOSIT_USD}`), { statusCode: 422 });
    }
    if (input.amount > MAX_DEPOSIT_USD) {
      throw Object.assign(new Error(`DEPOSIT_TOO_LARGE:maximum is ${MAX_DEPOSIT_USD}`), { statusCode: 422 });
    }

    const adapter = getPsp(input.psp);

    // Ensure wallet exists before creating deposit row
    await this.walletRepo.getOrCreate(input.userId);

    // 1. Deposit Requested
    const depositId = await this.stateMachine.createRequested({
      userId:    input.userId,
      psp:       input.psp,
      amount:    input.amount,
      currency:  input.currency,
      returnUrl: input.returnUrl,
    });

    // Build the webhook URL that the PSP will call back on
    const apiBase    = process.env.API_BASE_URL ?? "http://localhost:3000";
    const webhookUrl = `${apiBase}/api/v1/payments/webhooks/${input.psp.toLowerCase()}`;

    // 2. Deposit Pending — PSP session created
    let sessionResult;
    try {
      sessionResult = await adapter.createSession({
        depositId,
        userId:     input.userId,
        amount:     input.amount,
        currency:   input.currency,
        returnUrl:  input.returnUrl,
        webhookUrl,
      });
    } catch (err) {
      await this.stateMachine.transitionToFailed(depositId, String(err instanceof Error ? err.message : err));
      throw err;
    }

    await this.stateMachine.transitionToPending(depositId, {
      sessionId:   sessionResult.sessionId,
      redirectUrl: sessionResult.redirectUrl,
      pspRef:      sessionResult.pspRef,
    });

    return {
      depositId,
      redirectUrl: sessionResult.redirectUrl,
      status:      "PENDING",
    };
  }

  async getDepositStatus(depositId: string, userId: string): Promise<DepositStatusResult> {
    const dep = await this.db.depositTransaction.findFirst({
      where:  { id: depositId, userId },
      select: {
        id:          true,
        status:      true,
        psp:         true,
        amount:      true,
        currency:    true,
        redirectUrl: true,
        failReason:  true,
        requestedAt: true,
        creditedAt:  true,
      },
    });
    if (!dep) throw Object.assign(new Error("DEPOSIT_NOT_FOUND"), { statusCode: 404 });

    return {
      depositId:   dep.id,
      status:      dep.status,
      psp:         dep.psp,
      amount:      Number(dep.amount),
      currency:    dep.currency,
      redirectUrl: dep.redirectUrl,
      failReason:  dep.failReason,
      requestedAt: dep.requestedAt.toISOString(),
      creditedAt:  dep.creditedAt?.toISOString() ?? null,
    };
  }

  async listDeposits(userId: string, limit = 20, offset = 0): Promise<DepositStatusResult[]> {
    const rows = await this.db.depositTransaction.findMany({
      where:   { userId },
      orderBy: { requestedAt: "desc" },
      take:    Math.min(limit, 100),
      skip:    offset,
      select: {
        id:          true,
        status:      true,
        psp:         true,
        amount:      true,
        currency:    true,
        redirectUrl: true,
        failReason:  true,
        requestedAt: true,
        creditedAt:  true,
      },
    });
    return rows.map((d) => ({
      depositId:   d.id,
      status:      d.status,
      psp:         d.psp,
      amount:      Number(d.amount),
      currency:    d.currency,
      redirectUrl: d.redirectUrl,
      failReason:  d.failReason,
      requestedAt: d.requestedAt.toISOString(),
      creditedAt:  d.creditedAt?.toISOString() ?? null,
    }));
  }

  // Called by webhook handler after signature verification
  async processWebhookConfirmation(psp: PspName, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ depositId: string; outcome: string }> {
    const adapter    = getPsp(psp);
    const parsed     = await adapter.parseWebhook(rawBody, headers);

    // Find the deposit by pspRef
    const dep = await this.db.depositTransaction.findFirst({
      where: { pspRef: parsed.pspRef },
    });

    if (!dep) {
      // Praxis/Nuvei may call the webhook before the session response is received.
      // Fall back to correlating by sessionId if present, or treat as unknown.
      throw Object.assign(
        new Error(`WEBHOOK_NO_DEPOSIT_FOR_PSPREF:${parsed.pspRef}`),
        { statusCode: 404 }
      );
    }

    if (parsed.status === "CONFIRMED") {
      // Move to CONFIRMED first so state machine can validate the transition
      if (dep.status !== "CONFIRMED" && dep.status !== "CREDITED") {
        await this.stateMachine.transitionToConfirmed(dep.id, {
          pspRef:      parsed.pspRef,
          webhookData: parsed,
        });
      }

      // 3. PSP Confirmed → 4. Ledger Credit → 5. Audit Event (all in one serializable TX)
      const { alreadyCredited } = await this.stateMachine.transitionToCredit(dep.id, {
        pspRef:      parsed.pspRef,
        amount:      parsed.amount ?? 0,
        currency:    parsed.currency ?? dep.currency,
        webhookData: parsed,
      });

      // Affiliate commission accrual is intentionally outside the credit
      // transaction above: it must never be able to block or roll back a
      // real money credit. Idempotent on (sourceType, sourceRef), so safe
      // even if this fires more than once for the same deposit.
      if (!alreadyCredited) {
        await affiliateService
          .recordCommissionFromDeposit(dep.userId, dep.id, parsed.amount ?? 0, parsed.currency ?? dep.currency)
          .catch((err) => console.error("[affiliate] commission accrual failed:", (err as Error).message));
      }

      return { depositId: dep.id, outcome: alreadyCredited ? "ALREADY_CREDITED" : "CREDITED" };
    }

    if (parsed.status === "FAILED") {
      if (dep.status !== "FAILED" && dep.status !== "CREDITED") {
        await this.stateMachine.transitionToFailed(dep.id, parsed.failReason ?? "PSP_DECLINED", parsed);
      }
      return { depositId: dep.id, outcome: "FAILED" };
    }

    throw new Error(`WEBHOOK_UNHANDLED_OUTCOME:${parsed.status}`);
  }
}
