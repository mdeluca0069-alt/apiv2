/**
 * alert.manager.audit.spec.ts
 *
 * FASE 5.3 (Ledger, §0.14, LEDGER_FREEZE.md) — alert.manager.ts's own
 * header comment has claimed "All alerts are also written to AuditLog for
 * compliance" since it was written, but send() never actually did --
 * every money/risk-related alert (reconciliation mismatches, settlement
 * failures, margin discrepancies, stop-out waves, swap errors, audit/
 * notification consumer failures, circuit breaker trips) went out over
 * Telegram/email with zero durable compliance record.
 *
 * Fix: send() now writes an AuditLog row for every genuinely-sent (i.e.
 * non-deduplicated) alert, making the header comment's claim true.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuditLogCreate, mockPrisma } = vi.hoisted(() => {
  const mockAuditLogCreate = vi.fn().mockResolvedValue({});
  // REALTIME_FREEZE.md Critical #2: alert.manager.ts now routes through
  // immutableAudit.write() (real module, not mocked) instead of calling
  // prisma.auditLog.create() directly -- it needs $transaction/$executeRaw/
  // $queryRaw on this mock to satisfy write()'s chain-head lock and
  // lookup, in addition to the create() call these tests assert on.
  // $executeRaw (not $queryRaw) backs the advisory lock itself
  // (pg_advisory_xact_lock() returns SQL type `void`, which $queryRaw
  // cannot deserialize). FASE 7 CLOSURE, Phase C: _getChainHead() now
  // reads via $queryRaw (ordered by the _written_at JSON path, which
  // Prisma's typed orderBy can't express) instead of auditLog.findFirst.
  const mockPrisma: Record<string, unknown> = {
    auditLog: { create: mockAuditLogCreate },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  mockPrisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(mockPrisma));
  return { mockAuditLogCreate, mockPrisma };
});
vi.mock("../shared/db.js", () => ({
  IS_PERSISTENT: true,
  prisma: mockPrisma,
}));

const { mockMetricsInc } = vi.hoisted(() => ({ mockMetricsInc: vi.fn() }));
vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: mockMetricsInc, observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

const { alertManager } = await import("../alerting/alert.manager.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AlertManager.send() — writes AuditLog for compliance (§0.14)", () => {
  it("writes an AuditLog row for a genuinely-sent alert", async () => {
    await alertManager.send({
      type: "SETTLEMENT_FAILURE", severity: "CRITICAL",
      title: "Settlement Transaction Failed", message: "Position pos-1 could not be settled.",
      metadata: { positionId: "pos-1", userId: "user-1" },
    });

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const entry = mockAuditLogCreate.mock.calls[0][0].data as {
      actor: string; action: string; entity: string;
      payload: { severity: string; title: string; message: string; positionId: string };
    };
    expect(entry.actor).toBe("ALERT_MANAGER");
    expect(entry.action).toBe("alert.settlement_failure");
    expect(entry.entity).toBe("SETTLEMENT_FAILURE");
    expect(entry.payload.severity).toBe("CRITICAL");
    expect(entry.payload.positionId).toBe("pos-1");
  });

  it("does not write a second AuditLog row for a deduplicated alert within the dedup window", async () => {
    const alert = {
      type: "STOP_OUT_WAVE" as const, severity: "WARNING" as const,
      title: "Stop-Out Wave Detected", message: "5 stop-outs in one cycle.",
    };

    await alertManager.send(alert);
    await alertManager.send(alert); // same type+severity, within 5min window

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
  });

  it("a failed AuditLog write does not throw or block the alert send", async () => {
    mockAuditLogCreate.mockRejectedValueOnce(new Error("transient DB error"));

    await expect(alertManager.send({
      type: "MARGIN_DISCREPANCY", severity: "WARNING",
      title: "Margin Discrepancy", message: "test",
    })).resolves.toBeUndefined();
  });

  it("works via the real pre-built templates too (e.g. reconciliationMismatch)", async () => {
    await alertManager.reconciliationMismatch(3, "details here");

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const entry = mockAuditLogCreate.mock.calls[0][0].data as { action: string };
    expect(entry.action).toBe("alert.reconciliation_mismatch");
  });
});
