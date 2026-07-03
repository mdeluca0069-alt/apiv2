/**
 * AutopilotConsent — recorded client acceptance of the autopilot risk
 * disclosure. AutopilotConsent rows are append-only (one per acceptance,
 * never updated/deleted) so a dispute can always be traced back to the
 * exact version and timestamp the client agreed to. AutopilotConfig keeps a
 * denormalized copy (consentVersion/consentAcceptedAt) for fast reads on
 * the hot path (saveConfig, pipeline eligibility check).
 */
import { randomUUID } from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";

export const CURRENT_CONSENT_VERSION = "2026-06-30-v1";

export const CONSENT_TEXT =
  "Automated trading amplifies both profits and losses. Autopilot does not " +
  "guarantee profitability. CFDs involve significant risk of loss. Capital " +
  "at risk: only use funds you can afford to lose. By activating Autopilot " +
  "you confirm you understand and accept these risks, and that trades will " +
  "be opened and managed automatically on your behalf within the limits " +
  "you configure.";

export type ConsentStatus = { version: string; text: string; accepted: boolean };

const _memoryConsent = new Map<string, { version: string; acceptedAt: string }>();

export class AutopilotConsentService {
  getConsentText(): { version: string; text: string } {
    return { version: CURRENT_CONSENT_VERSION, text: CONSENT_TEXT };
  }

  hasValidConsent(cfg: { consentVersion?: string | null; consentAcceptedAt?: string | Date | null }): boolean {
    return cfg.consentVersion === CURRENT_CONSENT_VERSION && !!cfg.consentAcceptedAt;
  }

  async getStatus(userId: string): Promise<ConsentStatus> {
    const { version, text } = this.getConsentText();
    if (!IS_PERSISTENT || !prisma) {
      const mem = _memoryConsent.get(userId);
      return { version, text, accepted: mem?.version === version };
    }
    const cfg = await prisma.autopilotConfig.findUnique({
      where:  { userId },
      select: { consentVersion: true, consentAcceptedAt: true },
    });
    return { version, text, accepted: this.hasValidConsent(cfg ?? {}) };
  }

  async acceptConsent(userId: string, actorId: string): Promise<void> {
    const acceptedAt = new Date();

    if (!IS_PERSISTENT || !prisma) {
      _memoryConsent.set(userId, { version: CURRENT_CONSENT_VERSION, acceptedAt: acceptedAt.toISOString() });
      return;
    }

    await prisma.autopilotConsent.create({
      data: {
        id:         randomUUID(),
        userId,
        version:    CURRENT_CONSENT_VERSION,
        acceptedAt,
      },
    });

    await prisma.autopilotConfig.upsert({
      where:  { userId },
      create: { userId, consentVersion: CURRENT_CONSENT_VERSION, consentAcceptedAt: acceptedAt },
      update: { consentVersion: CURRENT_CONSENT_VERSION, consentAcceptedAt: acceptedAt },
    });

    await prisma.auditLog.create({
      data: {
        id:      randomUUID(),
        actor:   actorId,
        action:  "autopilot.consent_accepted",
        entity:  userId,
        payload: { version: CURRENT_CONSENT_VERSION, acceptedAt: acceptedAt.toISOString() },
      },
    });
  }
}

export const autopilotConsentService = new AutopilotConsentService();
