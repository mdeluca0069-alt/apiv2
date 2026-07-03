/**
 * AuditTrail — query interface for the immutable AuditLog.
 * Provides paginated, filtered access to audit records for compliance officers.
 */
import { prisma, IS_PERSISTENT } from "../shared/db.js";

export type AuditEntry = {
  id:        string;
  actor:     string;
  action:    string;
  entity:    string;
  payload:   unknown;
  createdAt: string;
};

export type AuditPage = {
  entries:    AuditEntry[];
  totalCount: number;
  from:       string;
  to:         string;
};

export class AuditTrailService {

  async query(opts: {
    actor?:  string;
    action?: string;
    entity?: string;
    from?:   Date;
    to?:     Date;
    limit?:  number;
    offset?: number;
  }): Promise<AuditPage> {
    const { actor, action, entity, from, to, limit = 50, offset = 0 } = opts;
    const periodFrom = from ?? new Date(Date.now() - 30 * 86_400_000);
    const periodTo   = to   ?? new Date();

    if (!IS_PERSISTENT) {
      return { entries: [], totalCount: 0, from: periodFrom.toISOString(), to: periodTo.toISOString() };
    }

    const where = {
      ...(actor  ? { actor }  : {}),
      ...(action ? { action: { contains: action } } : {}),
      ...(entity ? { entity } : {}),
      createdAt: { gte: periodFrom, lte: periodTo },
    };

    const db = prisma as NonNullable<typeof prisma>;
    const [rows, totalCount] = await Promise.all([
      db.auditLog.findMany({
        where, orderBy: { createdAt: "desc" },
        take: Math.min(limit, 500), skip: offset,
      }),
      db.auditLog.count({ where }),
    ]);

    return {
      entries: rows.map((r) => ({
        id: r.id, actor: r.actor, action: r.action,
        entity: r.entity, payload: r.payload,
        createdAt: r.createdAt.toISOString(),
      })),
      totalCount,
      from: periodFrom.toISOString(),
      to:   periodTo.toISOString(),
    };
  }
}

export const auditTrail = new AuditTrailService();
export default auditTrail;
