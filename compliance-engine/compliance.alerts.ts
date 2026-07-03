/**
 * ComplianceAlerts — generates and persists compliance alert records.
 * Called by AML, sanctions, PEP, and transaction monitoring engines.
 */
import { randomUUID } from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }  from "../events-bus/event.bus.js";

export type AlertSeverity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";

export type ComplianceAlert = {
  id:         string;
  userId:     string;
  alertType:  string;
  severity:   AlertSeverity;
  message:    string;
  payload:    Record<string, unknown>;
  resolved:   boolean;
  createdAt:  string;
};

export class ComplianceAlertService {

  async raise(
    userId:    string,
    alertType: string,
    severity:  AlertSeverity,
    message:   string,
    payload:   Record<string, unknown> = {},
  ): Promise<ComplianceAlert> {
    const alert: ComplianceAlert = {
      id:        randomUUID(),
      userId,
      alertType,
      severity,
      message,
      payload,
      resolved:  false,
      createdAt: new Date().toISOString(),
    };

    if (IS_PERSISTENT) {
      await (prisma as NonNullable<typeof prisma>).auditLog.create({
        data: {
          id:      alert.id,
          actor:   "COMPLIANCE_ALERTS",
          action:  `compliance.alert.${alertType.toLowerCase()}`,
          entity:  userId,
          payload: alert as unknown as object,
        },
      });
    }

    if (severity === "HIGH" || severity === "CRITICAL") {
      eventBus.emit("risk.warning", {
        userId, type: alertType, severity, message, payload,
      });
    }

    return alert;
  }

  async resolve(alertId: string, resolvedBy: string, note: string): Promise<void> {
    if (!IS_PERSISTENT) return;
    await (prisma as NonNullable<typeof prisma>).auditLog.create({
      data: {
        id: randomUUID(), actor: resolvedBy,
        action: "compliance.alert.resolved",
        entity: alertId,
        payload: { alertId, note } as object,
      },
    });
  }
}

export const complianceAlerts = new ComplianceAlertService();
export default complianceAlerts;
