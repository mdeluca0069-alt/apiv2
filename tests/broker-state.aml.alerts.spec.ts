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

/**
 * PHASE2_REMEDIATION (H17): dispositionStore is passed in (not created
 * fresh each call) so a test can simulate a restart -- construct a SECOND
 * BrokerState against the SAME backing store and confirm a disposition
 * written by the first instance is visible to the second, exactly as a
 * real Postgres table would behave across a process restart.
 */
function makeMockPrisma(
  auditRows: Array<{ id: string; entity: string; action: string; payload: unknown; createdAt: Date }>,
  dispositionStore: Map<string, { id: string; userId: string; status: string; reviewedBy: string; note?: string }> = new Map(),
) {
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
  const amlAlertDisposition = {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      [...dispositionStore.values()].filter((d) => where.id.in.includes(d.id)),
    ),
    upsert: vi.fn(async (args: {
      where:  { id: string };
      create: { id: string; userId: string; status: string; reviewedBy: string; note?: string };
      update: { status: string; reviewedBy: string; note?: string; reviewedAt?: Date };
    }) => {
      const existing = dispositionStore.get(args.where.id);
      const row = existing ? { ...existing, ...args.update } : { ...args.create };
      dispositionStore.set(args.where.id, row);
      return row;
    }),
  };
  const prismaLike: Record<string, unknown> = { auditLog, user, session, amlAlertDisposition };
  prismaLike.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaLike));
  return { prisma: prismaLike as unknown as PrismaClient, auditLog, user, amlAlertDisposition, dispositionStore };
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

    await state.reviewAmlAlert(firstAlert!.id, "CLEARED", "admin-1", "verified legitimate");

    const [secondAlert] = await state.getAmlAlerts();
    expect(secondAlert!.status).toBe("CLEARED");
    expect(secondAlert!.id).toBe(firstAlert!.id);
  });

  it("PHASE2_REMEDIATION (H17): a reviewed alert's disposition survives a process restart, not just repeat calls on the same instance", async () => {
    const auditRows = [
      {
        id: "audit-restart-1", entity: "user-1", action: "aml.assessment.critical",
        payload: { amount: 75_000, risk: "CRITICAL", flags: [] },
        createdAt: new Date("2026-07-30T13:00:00.000Z"),
      },
    ];
    // Shared backing store across both BrokerState instances -- simulates
    // the real Postgres table, which (unlike the in-memory _amlAlerts Map)
    // is unaffected by which process/instance is reading or writing it.
    const dispositionStore = new Map<string, { id: string; userId: string; status: string; reviewedBy: string; note?: string }>();

    const beforeRestart = makeMockPrisma(auditRows, dispositionStore);
    const stateBeforeRestart = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma: beforeRestart.prisma });

    const [alert] = await stateBeforeRestart.getAmlAlerts();
    expect(alert!.status).toBe("PENDING");
    await stateBeforeRestart.reviewAmlAlert(alert!.id, "CLEARED", "compliance-officer-1", "confirmed legitimate large withdrawal");

    // The disposition really did reach the "durable" store, not just the
    // in-memory Map this instance is about to be discarded along with.
    expect(dispositionStore.get(alert!.id)).toMatchObject({ status: "CLEARED", reviewedBy: "compliance-officer-1" });

    // Simulate a restart: brand new BrokerState instance (fresh, empty
    // _amlAlerts Map -- exactly the pre-fix bug scenario), same underlying
    // Postgres-like store.
    const afterRestart = makeMockPrisma(auditRows, dispositionStore);
    const stateAfterRestart = new BrokerState({ secret: "test", liveTradingEnabled: false, prisma: afterRestart.prisma });

    const [alertAfterRestart] = await stateAfterRestart.getAmlAlerts();
    expect(alertAfterRestart!.id).toBe(alert!.id);
    expect(alertAfterRestart!.status).toBe("CLEARED");
    expect(alertAfterRestart!.reviewedBy).toBe("compliance-officer-1");
    expect(alertAfterRestart!.note).toBe("confirmed legitimate large withdrawal");
  });
});
