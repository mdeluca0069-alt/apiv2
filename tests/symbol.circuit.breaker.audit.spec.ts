/**
 * symbol.circuit.breaker.audit.spec.ts
 *
 * PHASE2_REMEDIATION (H16) — the admin route audit found that
 * POST /admin/symbol-circuit-breaker/:symbol/reset (SymbolCircuitBreaker.
 * clear()) had zero call into the permanent, hash-chained AuditLog. Manually
 * clearing a halt before its cooldown elapses re-enables trading on that
 * symbol immediately -- only a console.log recorded who did it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockIsEnabled, mockSetEnabled } = vi.hoisted(() => ({
  mockIsEnabled:  vi.fn().mockReturnValue(true),
  mockSetEnabled: vi.fn().mockResolvedValue({}),
}));
vi.mock("../liquidity-engine/broker.spread.config.js", () => ({
  brokerSpreadConfig: { isEnabled: mockIsEnabled, setEnabled: mockSetEnabled },
}));

vi.mock("../alerting/alert.manager.js", () => ({
  alertManager: { symbolCircuitBreakerTripped: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../gateway/metrics.js", () => ({
  metrics: { inc: vi.fn(), observe: vi.fn(), set: vi.fn(), get: vi.fn() },
}));

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("audit-id-1") }));
vi.mock("../security/immutable.audit.js", () => ({
  immutableAudit: { write: mockAuditWrite },
}));
vi.mock("../shared/db.js", () => ({ prisma: null, IS_PERSISTENT: true }));

const { symbolCircuitBreaker } = await import("../risk-service/symbol.circuit.breaker.js");

async function flushMicrotasks() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsEnabled.mockReturnValue(true);
  mockSetEnabled.mockResolvedValue({});
  mockAuditWrite.mockResolvedValue("audit-id-1");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-31T12:00:00.000Z"));
});

describe("SymbolCircuitBreaker.clear() — PHASE2_REMEDIATION (H16): immutable audit trail", () => {
  it("writes an immutable audit entry when a halt is manually cleared", async () => {
    symbolCircuitBreaker.recordTick("AUDIT_EURUSD_A", 1.1000, "FX_MAJOR");
    vi.advanceTimersByTime(1_000);
    symbolCircuitBreaker.recordTick("AUDIT_EURUSD_A", 1.1100, "FX_MAJOR"); // trips the breaker
    await flushMicrotasks();
    expect(symbolCircuitBreaker.isHaltedByBreaker("AUDIT_EURUSD_A")).toBe(true);
    mockAuditWrite.mockClear();

    await symbolCircuitBreaker.clear("AUDIT_EURUSD_A", "admin-1");

    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    const [entry] = mockAuditWrite.mock.calls[0]!;
    expect(entry).toMatchObject({
      actor:  "admin-1",
      action: "symbol_circuit_breaker.manually_cleared",
      entity: "AUDIT_EURUSD_A",
    });
  });
});
