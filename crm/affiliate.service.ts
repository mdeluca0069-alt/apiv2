/**
 * AffiliateService — IB / referral program backing the admin Affiliate Center.
 *
 * Lifecycle: an admin creates an affiliate (PENDING), activates it once vetted
 * (ACTIVE), and can deactivate at any time. A referral is recorded once, at
 * signup, by matching the referral code the new user supplied. Commissions
 * accrue automatically off real deposit credits (see payment.service.ts) —
 * never off self-reported numbers — and are paid out manually by an admin.
 */
import { randomUUID }            from "node:crypto";
import { Prisma }                from "@prisma/client";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { immutableAudit }        from "../security/immutable.audit.js";
import { eventBus }              from "../events-bus/event.bus.js";

export type AffiliateStatus = "PENDING" | "ACTIVE" | "INACTIVE";

export type AffiliateSummary = {
  id:            string;
  name:          string;
  email:         string;
  code:          string;
  commissionPct: number;
  status:        AffiliateStatus;
  referrals:     number;
  commissions:   number; // sum of PAID + PENDING, in the affiliate's commission currency mix
  createdAt:     string;
};

function generateCode(name: string): string {
  const slug = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "PARTNER";
  return `${slug}${Math.floor(1000 + Math.random() * 9000)}`;
}

class AffiliateService {

  /** Admin: create a new affiliate (starts PENDING until activated). */
  async create(input: { name: string; email: string; commissionPct?: number }): Promise<AffiliateSummary> {
    if (!IS_PERSISTENT) {
      throw Object.assign(new Error("Affiliate creation requires a database connection."), { status: 503 });
    }
    const db = prisma as NonNullable<typeof prisma>;

    const existing = await db.affiliate.findUnique({ where: { email: input.email.toLowerCase().trim() } });
    if (existing) throw Object.assign(new Error("An affiliate with this email already exists."), { status: 409 });

    let code = generateCode(input.name);
    for (let attempt = 0; attempt < 5 && (await db.affiliate.findUnique({ where: { code } })); attempt++) {
      code = generateCode(input.name);
    }

    const row = await db.affiliate.create({
      data: {
        id:            randomUUID(),
        name:          input.name,
        email:         input.email.toLowerCase().trim(),
        code,
        commissionPct: new Prisma.Decimal(input.commissionPct ?? 20),
        status:        "PENDING",
      },
    });

    return this._toSummary(row, 0, new Prisma.Decimal(0));
  }

  /** Admin: list all affiliates with referral/commission totals. */
  async list(): Promise<AffiliateSummary[]> {
    if (!IS_PERSISTENT) return [];
    const db = prisma as NonNullable<typeof prisma>;

    const rows = await db.affiliate.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count:      { select: { Referrals: true } },
        Commissions: { select: { amount: true } },
      },
    });

    return rows.map((row) => {
      const totalCommissions = row.Commissions.reduce(
        (sum, c) => sum.plus(c.amount), new Prisma.Decimal(0),
      );
      return this._toSummary(row, row._count.Referrals, totalCommissions);
    });
  }

  /** Admin: activate or deactivate an affiliate. */
  async setStatus(affiliateId: string, status: AffiliateStatus, adminId: string): Promise<AffiliateSummary> {
    if (!IS_PERSISTENT) {
      throw Object.assign(new Error("Affiliate status change requires a database connection."), { status: 503 });
    }
    const db = prisma as NonNullable<typeof prisma>;

    const row = await db.affiliate.update({
      where: { id: affiliateId },
      data:  { status },
      include: {
        _count:      { select: { Referrals: true } },
        Commissions: { select: { amount: true } },
      },
    });

    await immutableAudit.write({
      actor: adminId, action: `affiliate.${status.toLowerCase()}`, entity: affiliateId, payload: {},
    }).catch(() => {});

    eventBus.emit("affiliate.status_changed", { affiliateId, status, adminId, timestamp: new Date().toISOString() });

    const totalCommissions = row.Commissions.reduce((sum, c) => sum.plus(c.amount), new Prisma.Decimal(0));
    return this._toSummary(row, row._count.Referrals, totalCommissions);
  }

  /**
   * Called once at signup if the new user supplied a referral code. Silently
   * no-ops on an unknown/inactive code or an already-referred user — referral
   * tracking must never block or fail account registration.
   */
  async recordReferral(userId: string, referralCode: string): Promise<void> {
    if (!IS_PERSISTENT || !referralCode) return;
    const db = prisma as NonNullable<typeof prisma>;

    try {
      const affiliate = await db.affiliate.findUnique({ where: { code: referralCode.toUpperCase().trim() } });
      if (!affiliate || affiliate.status !== "ACTIVE") return;

      await db.affiliateReferral.create({
        data: { id: randomUUID(), affiliateId: affiliate.id, userId },
      });

      eventBus.emit("affiliate.referral_recorded", {
        affiliateId: affiliate.id, userId, timestamp: new Date().toISOString(),
      });
    } catch {
      // Unique constraint (already referred) or any other non-critical failure — ignore.
    }
  }

  /**
   * Called after a deposit is credited (payment.service.ts). Awards the
   * affiliate's commission on the referred user's first AND subsequent
   * deposits. Idempotent via the (sourceType, sourceRef) unique constraint —
   * safe to call more than once for the same deposit.
   */
  async recordCommissionFromDeposit(userId: string, depositId: string, amount: number, currency: string): Promise<void> {
    if (!IS_PERSISTENT || amount <= 0) return;
    const db = prisma as NonNullable<typeof prisma>;

    try {
      const referral = await db.affiliateReferral.findUnique({
        where:   { userId },
        include: { Affiliate: true },
      });
      if (!referral || referral.Affiliate.status !== "ACTIVE") return;

      const commissionAmount = new Prisma.Decimal(amount)
        .mul(referral.Affiliate.commissionPct)
        .div(100);

      await db.affiliateCommission.create({
        data: {
          id:          randomUUID(),
          affiliateId: referral.affiliateId,
          userId,
          sourceType:  "DEPOSIT",
          sourceRef:   depositId,
          amount:      commissionAmount,
          currency,
          status:      "PENDING",
        },
      });

      eventBus.emit("affiliate.commission_accrued", {
        affiliateId: referral.affiliateId, userId, depositId,
        amount: commissionAmount.toNumber(), currency, timestamp: new Date().toISOString(),
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
        console.error("[affiliate] commission recording failed:", (err as Error).message);
      }
    }
  }

  /** Admin: mark an affiliate's pending commissions as paid (manual payout). */
  async markCommissionsPaid(affiliateId: string, adminId: string): Promise<{ count: number }> {
    if (!IS_PERSISTENT) {
      throw Object.assign(new Error("Marking commissions paid requires a database connection."), { status: 503 });
    }
    const db = prisma as NonNullable<typeof prisma>;

    const result = await db.affiliateCommission.updateMany({
      where: { affiliateId, status: "PENDING" },
      data:  { status: "PAID", paidAt: new Date() },
    });

    await immutableAudit.write({
      actor: adminId, action: "affiliate.commissions_paid", entity: affiliateId, payload: { count: result.count },
    }).catch(() => {});

    return { count: result.count };
  }

  private _toSummary(
    row: { id: string; name: string; email: string; code: string; commissionPct: Prisma.Decimal; status: string; createdAt: Date },
    referralCount: number,
    totalCommissions: Prisma.Decimal,
  ): AffiliateSummary {
    return {
      id:            row.id,
      name:          row.name,
      email:         row.email,
      code:          row.code,
      commissionPct: row.commissionPct.toNumber(),
      status:        row.status as AffiliateStatus,
      referrals:     referralCount,
      commissions:   totalCommissions.toNumber(),
      createdAt:     row.createdAt.toISOString(),
    };
  }
}

export const affiliateService = new AffiliateService();
