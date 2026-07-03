/**
 * ComplianceLogs — immutable compliance log query service.
 * Reads from AuditLog filtering on compliance-related actions.
 * All compliance events are written by their respective engines to AuditLog.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";

export type ComplianceLogEntry = {
  id:        string;
  actor:     string;
  action:    string;
  entity:    string;
  payload:   unknown;
  createdAt: string;
};

const COMPLIANCE_ACTION_PREFIXES = [
  "aml.", "sanctions.", "pep.", "mifid.", "kyc.", "regulatory.",
  "sar.", "compliance.", "leverage.", "client.", "tx.monitor.",
];

export class ComplianceLogsService {

  async query(opts: {
    userId?: string;
    from?:   Date;
    to?:     Date;
    action?: string;
    limit?:  number;
  }): Promise<ComplianceLogEntry[]> {
    if (!IS_PERSISTENT) return [];

    const { userId, from, to, action, limit = 100 } = opts;
    const db = prisma as NonNullable<typeof prisma>;

    const rows = await db.auditLog.findMany({
      where: {
        ...(userId ? { entity: userId } : {}),
        ...(action  ? { action: { contains: action } } : {
          action: { in: await this._complianceActions() },
        }),
        ...(from || to
          ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 500),
    });

    return rows.map((r) => ({
      id:        r.id,
      actor:     r.actor,
      action:    r.action,
      entity:    r.entity,
      payload:   r.payload,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private async _complianceActions(): Promise<string[]> {
    if (!IS_PERSISTENT) return [];
    const db = prisma as NonNullable<typeof prisma>;
    const rows = await db.auditLog.findMany({
      where: { action: { in: COMPLIANCE_ACTION_PREFIXES.map((p) => `${p}%`) } },
      select: { action: true },
      distinct: ["action"],
    });
    return rows.map((r) => r.action);
  }
}

export const complianceLogs = new ComplianceLogsService();
export default complianceLogs;
