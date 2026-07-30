/**
 * transaction.monitor.withdrawal.spec.ts
 *
 * CRITICAL_REMEDIATION Phase 1 (C15) — withdrawals were never AML-screened
 * at all. transactionMonitor.monitor() had exactly one call site in the
 * entire codebase, on POST /api/v1/client/deposit -- confirmed via grep.
 * AmlEngine's own RAPID_DEPOSIT_WITHDRAWAL detection (compliance-engine/
 * aml.engine.ts) exists specifically for transactionType==="WITHDRAWAL",
 * checking whether a credit landed within RAPID_CYCLE_MINUTES of the
 * withdrawal -- exactly the "clean deposit in, launder out fast" pattern
 * AML screening exists to catch -- but that branch could never execute in
 * production, since nothing ever called assess()/monitor() with
 * "WITHDRAWAL" as the type.
 *
 * Fix: gateway/routes.ts's POST /api/v1/client/withdraw handler now calls
 * transactionMonitor.monitor(userId, amount, "WITHDRAWAL") before
 * processing the request, mirroring the deposit route's existing
 * screening exactly, and blocks (COMPLIANCE_HOLD) on CRITICAL risk.
 *
 * These tests exercise TransactionMonitor.monitor()/AmlEngine.assess()
 * directly with transactionType="WITHDRAWAL" -- the exact call shape the
 * route now makes -- proving the previously-unreachable withdrawal
 * detection logic is correct now that it's reachable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAggregate, mockFindFirst, mockAuditWrite } = vi.hoisted(() => ({
  mockAggregate: vi.fn(),
  mockFindFirst: vi.fn(),
  mockAuditWrite: vi.fn().mockResolvedValue("audit-id"),
}));

vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: {
    ledgerEntry: { aggregate: mockAggregate, findFirst: mockFindFirst },
  },
}));

vi.mock("../security/immutable.audit.js", () => ({
  immutableAudit: { write: mockAuditWrite },
}));

const { mockEmit } = vi.hoisted(() => ({ mockEmit: vi.fn() }));
vi.mock("../events-bus/event.bus.js", () => ({ eventBus: { emit: mockEmit } }));

const { transactionMonitor } = await import("../compliance-engine/transaction.monitor.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockAggregate.mockResolvedValue({ _sum: { amount: null }, _count: 0 });
  mockFindFirst.mockResolvedValue(null);
});

describe("TransactionMonitor.monitor() — WITHDRAWAL screening (C15)", () => {
  it("flags RAPID_DEPOSIT_WITHDRAWAL when a credit landed within the rapid-cycle window -- the exact pattern this screening exists to catch", async () => {
    mockFindFirst.mockResolvedValue({ id: "credit-1", createdAt: new Date() });

    const result = await transactionMonitor.monitor("user-1", 2_000, "WITHDRAWAL", "wd-1");

    expect(result.flagged).toBe(true);
    expect(result.flags).toContain("RAPID_DEPOSIT_WITHDRAWAL");
    expect(mockFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: "user-1", status: "COMPLETED" }),
    }));
  });

  it("does not flag RAPID_DEPOSIT_WITHDRAWAL for a DEPOSIT (only checked on WITHDRAWAL)", async () => {
    mockFindFirst.mockResolvedValue({ id: "credit-1", createdAt: new Date() });

    const result = await transactionMonitor.monitor("user-1", 2_000, "DEPOSIT", "dep-1");

    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(result.flags).not.toContain("RAPID_DEPOSIT_WITHDRAWAL");
  });

  it("flags a CRITICAL large withdrawal and marks it FLAGGED_FOR_SAR -- the route now blocks on this", async () => {
    const result = await transactionMonitor.monitor("user-1", 100_000, "WITHDRAWAL", "wd-2");

    expect(result.riskLevel).toBe("CRITICAL");
    expect(result.actionTaken).toBe("FLAGGED_FOR_SAR");
  });

  it("an ordinary small withdrawal with no recent credit is not flagged", async () => {
    const result = await transactionMonitor.monitor("user-1", 100, "WITHDRAWAL", "wd-3");

    expect(result.flagged).toBe(false);
    expect(result.riskLevel).toBe("LOW");
    expect(result.actionTaken).toBe("ALLOWED");
  });

  it("writes an AuditLog entry and emits compliance.alert for a CRITICAL withdrawal, same as it already does for deposits", async () => {
    await transactionMonitor.monitor("user-1", 100_000, "WITHDRAWAL", "wd-4");

    expect(mockAuditWrite).toHaveBeenCalledWith(expect.objectContaining({
      actor: "TRANSACTION_MONITOR",
      action: "tx.monitor.flagged_for_sar",
    }));
    expect(mockEmit).toHaveBeenCalledWith("compliance.alert", expect.objectContaining({
      userId: "user-1", type: "TRANSACTION_FLAGGED", severity: "CRITICAL",
    }));
  });
});
