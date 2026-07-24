/**
 * ComplianceAlerts — generates and persists compliance alert records.
 * Called by AML, sanctions, PEP, and transaction monitoring engines.
 */
import { randomUUID } from "node:crypto";
import { IS_PERSISTENT } from "../shared/db.js";
import { eventBus }  from "../events-bus/event.bus.js";
import { immutableAudit } from "../security/immutable.audit.js";

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
      // Note: the underlying AuditLog row gets its OWN id from
      // immutableAudit.write() (not alert.id) -- nothing looks up an
      // AuditLog row by alert.id (resolve() below references it only as
      // a payload/entity value, never as a row lookup key), so this is
      // safe. alert.id remains the identifier callers actually use.
      await immutableAudit.write({
        actor:   "COMPLIANCE_ALERTS",
        action:  `compliance.alert.${alertType.toLowerCase()}`,
        entity:  userId,
        payload: alert as unknown as object,
      });
    }

    if (severity === "HIGH" || severity === "CRITICAL") {
      // FASE 7 CLOSURE, Phase A (M.6): was "risk.warning", see aml.engine.ts.
      eventBus.emit("compliance.alert", {
        userId, type: alertType, severity, message, payload,
      });
    }

    return alert;
  }

  async resolve(alertId: string, resolvedBy: string, note: string): Promise<void> {
    if (!IS_PERSISTENT) return;
    await immutableAudit.write({
      actor: resolvedBy,
      action: "compliance.alert.resolved",
      entity: alertId,
      payload: { alertId, note } as object,
    });
  }
}

export const complianceAlerts = new ComplianceAlertService();
export default complianceAlerts;
