/**
 * broker-state.aml.alerts.spec.ts
 *
 * CRITICAL_REMEDIATION Phase 1 (C14) — BrokerState.getAmlAlerts().
 *
 * Root cause, confirmed via code trace: GET /admin/aml-alerts (the real
 * compliance dashboard endpoint) called this method, which derived alerts
 * ENTIRELY from a crude re-scan of legacy in-memory clientAccounts ledgers
 * (amount >= 10000 on DEPOSIT_REQUEST/WITHDRAW_REQUEST only) -- completely
 * disconnected from AmlEngine (compliance-engine/aml.engine.ts), which runs
 * real structuring/frequency/rapid-cycle heuristics on every screened
 * transaction and persists its findings to AuditLog (actor="AML_ENGINE").
 * A STRUCTURING_PATTERN or RAPID_DEPOSIT_WITHDRAWAL flag -- the actual
 * findings AmlEngine exists to produce -- could never appear on this
 * dashboard; only a much weaker, independently-reinvented "amount >=
 * 10000" signal ever did.
 *
 * Fix: in persistent mode, source alerts from AmlEngine's own AuditLog
 * trail instead of re-deriving a separate, weaker signal from legacy
 * in-memory ledger state. The legacy ledger-derived seeding remains the
 * sandbox/non-persistent fallback, unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { eventBus } = await import("../events-bus/event.bus.js");
vi.spyOn(eventBus, "emit");

const { BrokerState } = await import("../shared/state.js");

function makeMockPrisma(auditRows: Array<{ id: string; entity: string; action: string; payload: unknown; createdAt: Date }>) {
  const auditLog = {
    findMany: vi.fn(async (_args: { where: { actor: string; action: { in: string[] } }; orderBy: unknown; take: number }) => auditRows),
  };
  const user = {
    findMany: vi.fn(async () => [
      { id: "user-1", fullName: "Alice Trader", email: "alice@example.com" },
      { id: "user-2", fullName: "Bob Trader", email: "bob@example.com" },
    ]),
  };
  const session = { upsert: vi.fn(async () => ({})) };
  const prismaLike: Record<string, unknown> = { auditLog, user, session };
  prismaLike.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaLike));
  return { prisma: prismaLike as unknown as PrismaClient, auditLog, user };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BrokerState.getAmlAlerts() — CRITICAL_REMEDIATION (C14)", () => {
  it("sources alerts from AmlEngine's real AuditLog trail (actor=AML_ENGINE), not a separate re-derived signal", async () => {
    const mock = makeMockPrisma([
      {
        id: "audit-structuring-1", entity: "user-1", action: "aml.assessment.high",
        payload: {
          amount: 9_950, risk: "HIGH",
          flags: [{ code: "STRUCTURING_PATTERN", message: "x", risk: "HIGH" }],
        },
        createdAt: new Date("2026-07-30T10:00:00.000Z"),
      },
    ]);
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma: mock.prisma });

    const alerts = await state.getAmlAlerts();

    expect(mock.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        actor: "AML_ENGINE",
        action: { in: ["aml.assessment.medium", "aml.assessment.high", "aml.assessment.critical"] },
      }),
    }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      userId: "user-1", userName: "Alice Trader", email: "alice@example.com",
      amount: 9_950, type: "SUSPICIOUS",
    });
  });

  it("surfaces a RAPID_DEPOSIT_WITHDRAWAL flag -- the exact finding class the pre-fix dashboard could never show", async () => {
    const mock = makeMockPrisma([
      {
        id: "audit-rapid-1", entity: "user-2", action: "aml.assessment.high",
        payload: {
          amount: 5_000, risk: "HIGH",
          flags: [{ code: "RAPID_DEPOSIT_WITHDRAWAL", message: "x", risk: "HIGH" }],
        },
        createdAt: new Date("2026-07-30T11:00:00.000Z"),
      },
    ]);
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma: mock.prisma });

    const alerts = await state.getAmlAlerts();

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.type).toBe("SUSPICIOUS");
    expect(alerts[0]!.userName).toBe("Bob Trader");
  });

  it("does not include LOW-risk assessments (AmlEngine writes an audit row for every assessment, not just flagged ones)", async () => {
    // AmlEngine._persist() writes unconditionally, but only emits/matters for
    // non-LOW risk -- the query itself must exclude aml.assessment.low.
    // simulates the DB correctly filtering out a LOW row
    const mock = makeMockPrisma([] as Array<{ id: string; entity: string; action: string; payload: unknown; createdAt: Date }>);
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma: mock.prisma });

    const alerts = await state.getAmlAlerts();

    const call = mock.auditLog.findMany.mock.calls[0]?.[0] as { where: { action: { in: string[] } } };
    expect(call.where.action.in).not.toContain("aml.assessment.low");
    expect(alerts).toHaveLength(0);
  });

  it("preserves review status across calls once reviewAmlAlert() has been called (existing behavior unchanged)", async () => {
    const mock = makeMockPrisma([
      {
        id: "audit-review-1", entity: "user-1", action: "aml.assessment.critical",
        payload: { amount: 60_000, risk: "CRITICAL", flags: [] },
        createdAt: new Date("2026-07-30T12:00:00.000Z"),
      },
    ]);
    const state = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma: mock.prisma });

    const [firstAlert] = await state.getAmlAlerts();
    expect(firstAlert!.status).toBe("PENDING");

    state.reviewAmlAlert(firstAlert!.id, "CLEARED", "admin-1", "verified legitimate");

    const [secondAlert] = await state.getAmlAlerts();
    expect(secondAlert!.status).toBe("CLEARED");
    expect(secondAlert!.id).toBe(firstAlert!.id);
  });
});
