/**
 * SuspiciousActivityReporting — SAR (Suspicious Activity Report) generation.
 * Triggered by AML engine when CRITICAL risk or structuring patterns detected.
 * In production: submit to national FIU (FinCEN, UKFIU, UIF, etc.)
 */
import { randomUUID } from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

export type SarReport = {
  id:          string;
  userId:      string;
  reportType:  "SAR" | "CTR";
  grounds:     string[];
  amount:      number;
  currency:    string;
  reportedAt:  string;
  fiuReference?: string;   // set when FIU assigns a reference
  status:      "DRAFT" | "SUBMITTED" | "ACKNOWLEDGED";
};

export class SuspiciousActivityService {

  async file(
    userId:   string,
    grounds:  string[],
    amount:   number,
    currency = "USD",
  ): Promise<SarReport> {
    const sar: SarReport = {
      id:         randomUUID(),
      userId,
      reportType: amount >= 10_000 ? "CTR" : "SAR",
      grounds,
      amount,
      currency,
      reportedAt: new Date().toISOString(),
      status:     "DRAFT",
    };

    if (IS_PERSISTENT) {
      await (prisma as NonNullable<typeof prisma>).auditLog.create({
        data: {
          id: sar.id, actor: "SAR_ENGINE",
          action: `sar.${sar.reportType.toLowerCase()}.filed`,
          entity: userId,
          payload: sar as unknown as object,
        },
      });
    }

    console.warn(`[SAR] Filed ${sar.reportType} for userId=${userId} amount=${amount} grounds=${grounds.join(", ")}`);
    return sar;
  }
}

export const suspiciousActivity = new SuspiciousActivityService();
export default suspiciousActivity;
