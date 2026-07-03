/**
 * SupportService — manages client support tickets with SLA tracking and audit logging.
 *
 * SLA targets by priority:
 *   URGENT  — 2 hours
 *   HIGH    — 8 hours
 *   NORMAL  — 24 hours
 *   LOW     — 72 hours
 *
 * Every status change creates an AuditLog entry.
 */
import { randomUUID }           from "node:crypto";
import { prisma, IS_PERSISTENT } from "../shared/db.js";
import { eventBus }             from "../events-bus/event.bus.js";

export type TicketPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type TicketStatus   = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
export type TicketCategory =
  | "GENERAL"
  | "TRADING"
  | "ACCOUNT"
  | "COMPLIANCE"
  | "TECHNICAL";

export type CreateTicketInput = {
  subject:   string;
  message:   string;
  priority?: TicketPriority;
  category?: TicketCategory;
};

export type TicketSummary = {
  id:          string;
  userId?:     string;
  subject:     string;
  message:     string;
  status:      TicketStatus;
  priority:    TicketPriority;
  category:    TicketCategory;
  resolution?: string | null;
  agentNote?:  string | null;
  resolvedAt?: string | null;
  slaDeadline?: string | null;
  slaBreached: boolean;
  createdAt:   string;
  updatedAt:   string;
};

// SLA hours by priority
const SLA_HOURS: Record<TicketPriority, number> = {
  URGENT: 2,
  HIGH:   8,
  NORMAL: 24,
  LOW:    72,
};

function toSummary(t: {
  id: string; userId?: string; subject: string; message: string; status: string;
  priority: string; category: string; resolution: string | null; agentNote?: string | null;
  resolvedAt: Date | null; slaDeadline: Date | null;
  createdAt: Date; updatedAt: Date;
}): TicketSummary {
  const now = Date.now();
  const slaBreached = t.slaDeadline !== null
    && t.status !== "RESOLVED"
    && t.status !== "CLOSED"
    && t.slaDeadline.getTime() < now;

  return {
    id:          t.id,
    userId:      t.userId,
    subject:     t.subject,
    message:     t.message,
    status:      t.status as TicketStatus,
    priority:    t.priority as TicketPriority,
    category:    t.category as TicketCategory,
    resolution:  t.resolution,
    agentNote:   t.agentNote ?? null,
    resolvedAt:  t.resolvedAt?.toISOString() ?? null,
    slaDeadline: t.slaDeadline?.toISOString() ?? null,
    slaBreached,
    createdAt:   t.createdAt.toISOString(),
    updatedAt:   t.updatedAt.toISOString(),
  };
}

// In-memory sandbox store
const _sandboxTickets = new Map<string, TicketSummary>();

export class SupportService {

  async createTicket(
    userId:  string,
    input:   CreateTicketInput,
    actorId: string,
  ): Promise<TicketSummary> {
    const priority = input.priority ?? "NORMAL";
    const category = input.category ?? "GENERAL";
    const slaHours = SLA_HOURS[priority];
    const slaDeadline = new Date(Date.now() + slaHours * 3_600_000);

    if (!IS_PERSISTENT) {
      const ticket: TicketSummary = {
        id:          randomUUID(),
        subject:     input.subject.slice(0, 200),
        message:     input.message.slice(0, 5000),
        status:      "OPEN",
        priority,
        category,
        resolution:  null,
        resolvedAt:  null,
        slaDeadline: slaDeadline.toISOString(),
        slaBreached: false,
        createdAt:   new Date().toISOString(),
        updatedAt:   new Date().toISOString(),
      };
      _sandboxTickets.set(ticket.id, ticket);
      return ticket;
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        id:          randomUUID(),
        userId,
        subject:     input.subject.slice(0, 200),
        message:     input.message.slice(0, 5000),
        status:      "OPEN",
        priority,
        category,
        slaDeadline,
      },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        id:       randomUUID(),
        actor:    actorId,
        action:   "support.ticket.created",
        entity:   `ticket:${ticket.id}`,
        payload:  { subject: ticket.subject, priority, category },
      },
    });

    eventBus.emit("support.ticket_created", {
      userId:   ticket.userId,
      ticketId: ticket.id,
      subject:  ticket.subject,
      priority,
      timestamp: new Date().toISOString(),
    });

    return toSummary(ticket);
  }

  /** Admin/agent view — all tickets across all clients, optionally filtered by status. */
  async getAllTickets(
    options: { status?: TicketStatus; priority?: TicketPriority; limit?: number; offset?: number } = {},
  ): Promise<{ tickets: TicketSummary[]; total: number }> {
    const limit  = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;

    if (!IS_PERSISTENT) {
      const all = Array.from(_sandboxTickets.values())
        .filter((t) => (!options.status || t.status === options.status))
        .filter((t) => (!options.priority || t.priority === options.priority))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { tickets: all.slice(offset, offset + limit), total: all.length };
    }

    const where = {
      ...(options.status   ? { status: options.status }     : {}),
      ...(options.priority ? { priority: options.priority }  : {}),
    };

    const [tickets, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        take:    limit,
        skip:    offset,
        include: { User: { select: { email: true, fullName: true } } },
      }),
      prisma.supportTicket.count({ where }),
    ]);

    return {
      tickets: tickets.map((t) => ({ ...toSummary(t), userEmail: t.User?.email, userName: t.User?.fullName } as TicketSummary & { userEmail?: string; userName?: string })),
      total,
    };
  }

  /** Agent reply — recorded as the ticket's agent note and pushed to the client, without resolving it. */
  async addReply(ticketId: string, agentNote: string, actorId: string): Promise<TicketSummary | null> {
    if (!IS_PERSISTENT) {
      const t = _sandboxTickets.get(ticketId);
      if (!t) return null;
      const updated = { ...t, agentNote, updatedAt: new Date().toISOString() };
      _sandboxTickets.set(ticketId, updated);
      return updated;
    }

    const existing = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!existing) return null;

    const ticket = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        agentNote,
        status: existing.status === "OPEN" ? "IN_PROGRESS" : existing.status,
      },
    });

    await prisma.auditLog.create({
      data: {
        id:      randomUUID(),
        actor:   actorId,
        action:  "support.ticket.replied",
        entity:  `ticket:${ticketId}`,
        payload: { agentNote },
      },
    });

    eventBus.emit("support.ticket_updated", {
      userId:    ticket.userId,
      ticketId:  ticket.id,
      status:    ticket.status,
      agentNote: agentNote,
      timestamp: new Date().toISOString(),
    });

    return toSummary(ticket);
  }

  async getTickets(
    userId:  string,
    options: { status?: TicketStatus; limit?: number; offset?: number } = {},
  ): Promise<{ tickets: TicketSummary[]; total: number }> {
    const limit  = Math.min(options.limit  ?? 20, 100);
    const offset = options.offset ?? 0;

    if (!IS_PERSISTENT) {
      const all = Array.from(_sandboxTickets.values())
        .filter((t) => (!options.status || t.status === options.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return {
        tickets: all.slice(offset, offset + limit),
        total:   all.length,
      };
    }

    const where = {
      userId,
      ...(options.status ? { status: options.status } : {}),
    };

    const [tickets, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take:    limit,
        skip:    offset,
      }),
      prisma.supportTicket.count({ where }),
    ]);

    return { tickets: tickets.map(toSummary), total };
  }

  async getTicket(ticketId: string, userId: string): Promise<TicketSummary | null> {
    if (!IS_PERSISTENT) {
      return _sandboxTickets.get(ticketId) ?? null;
    }

    const ticket = await prisma.supportTicket.findFirst({
      where: { id: ticketId, userId },
    });
    return ticket ? toSummary(ticket) : null;
  }

  async updateStatus(
    ticketId: string,
    status:   TicketStatus,
    actorId:  string,
    resolution?: string,
  ): Promise<TicketSummary | null> {
    if (!IS_PERSISTENT) {
      const t = _sandboxTickets.get(ticketId);
      if (!t) return null;
      const updated = {
        ...t,
        status,
        resolution: resolution ?? t.resolution,
        resolvedAt: status === "RESOLVED" ? new Date().toISOString() : t.resolvedAt,
        updatedAt:  new Date().toISOString(),
      };
      _sandboxTickets.set(ticketId, updated);
      return updated;
    }

    const isResolved = status === "RESOLVED" || status === "CLOSED";
    const ticket = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status,
        ...(resolution ? { resolution } : {}),
        ...(isResolved ? { resolvedAt: new Date() } : {}),
      },
    });

    await prisma.auditLog.create({
      data: {
        id:      randomUUID(),
        actor:   actorId,
        action:  `support.ticket.${status.toLowerCase()}`,
        entity:  `ticket:${ticketId}`,
        payload: { status, resolution: resolution ?? null },
      },
    });

    eventBus.emit("support.ticket_updated", {
      userId:     ticket.userId,
      ticketId:   ticket.id,
      status:     ticket.status,
      resolution: resolution,
      timestamp:  new Date().toISOString(),
    });

    return toSummary(ticket);
  }
}

export const supportService = new SupportService();
