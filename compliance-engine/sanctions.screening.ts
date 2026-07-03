/**
 * SanctionsScreening — OFAC / EU / UN sanctions list screening.
 *
 * Production: wire to ComplyAdvantage, World-Check, or LexisNexis via
 * the SanctionsProvider interface.
 */
import { randomUUID }    from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }      from "../events-bus/event.bus.js";

export const SANCTIONED_COUNTRIES = new Set([
  "KP","IR","SY","CU","SD","LY","MM","BY","VE",
]);

export type ScreeningResult = {
  clear:        boolean;
  matchType:    "NONE" | "COUNTRY" | "NAME_MATCH" | "EXACT_MATCH";
  matchedList?: string;
  matchedEntry?: string;
  confidence:   number;
  screenedAt:   string;
  action:       "ALLOW" | "BLOCK" | "REVIEW";
};

export class SanctionsScreeningService {

  async screenUser(
    userId:      string,
    fullName:    string,
    countryCode: string,
  ): Promise<ScreeningResult> {
    const screenedAt = new Date().toISOString();

    if (SANCTIONED_COUNTRIES.has(countryCode.toUpperCase())) {
      const result: ScreeningResult = {
        clear: false, matchType: "COUNTRY",
        matchedList: "OFAC/EU Consolidated",
        matchedEntry: countryCode,
        confidence: 1.0, screenedAt, action: "BLOCK",
      };
      await this._persist(userId, fullName, countryCode, result);
      return result;
    }

    const clear: ScreeningResult = {
      clear: true, matchType: "NONE",
      confidence: 0.0, screenedAt, action: "ALLOW",
    };
    await this._persist(userId, fullName, countryCode, clear);
    return clear;
  }

  private async _persist(
    userId: string, fullName: string, countryCode: string, result: ScreeningResult,
  ): Promise<void> {
    if (!IS_PERSISTENT) return;
    const db = prisma as NonNullable<typeof prisma>;
    await db.auditLog.create({
      data: {
        id: randomUUID(), actor: "SANCTIONS_ENGINE",
        action: `sanctions.${result.action.toLowerCase()}`,
        entity: userId,
        payload: { fullName, countryCode, ...result } as object,
      },
    });
    if (result.action !== "ALLOW") {
      eventBus.emit("risk.warning", {
        userId, type: "SANCTIONS_HIT", severity: "CRITICAL",
        message: `Sanctions BLOCK: ${result.matchType} (${countryCode})`,
        payload: result,
      });
      if (result.action === "BLOCK") {
        await db.user.update({ where: { id: userId }, data: { kycStatus: "rejected" } })
          .catch(() => {});
      }
    }
  }
}

export const sanctionsScreening = new SanctionsScreeningService();
export default sanctionsScreening;
