/**
 * feed.circuit.audit.spec.ts
 *
 * PHASE2_REMEDIATION (H16) — the admin route audit found that
 * POST /admin/feed/circuit/reset (feedCircuit.close()) had zero call into
 * the permanent, hash-chained AuditLog. Forcing the feed circuit closed
 * re-enables live pricing platform-wide even if the underlying feed issue
 * that opened it hasn't actually resolved.
 *
 * close()'s new `actor` param is only supplied by the admin route --
 * FeedManager's own automatic recovery-path caller omits it, so this also
 * proves the automatic system path stays unaudited (it is not an admin
 * action).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuditWrite } = vi.hoisted(() => ({ mockAuditWrite: vi.fn().mockResolvedValue("audit-id-1") }));
vi.mock("../security/immutable.audit.js", () => ({
  immutableAudit: { write: mockAuditWrite },
}));

const { feedCircuit } = await import("../shared/feed.circuit.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditWrite.mockResolvedValue("audit-id-1");
  feedCircuit.open();
});

describe("feedCircuit.close() — PHASE2_REMEDIATION (H16): immutable audit trail", () => {
  it("writes an immutable audit entry when an actor is supplied (the admin manual-reset route)", async () => {
    feedCircuit.close("admin-1");

    await vi.waitFor(() => expect(mockAuditWrite).toHaveBeenCalledTimes(1));
    const [entry] = mockAuditWrite.mock.calls[0]!;
    expect(entry).toMatchObject({ actor: "admin-1", action: "feed.circuit_reset", entity: "platform" });
    expect(feedCircuit.isOpen()).toBe(false);
  });

  it("does not write an audit entry when no actor is supplied (FeedManager's automatic recovery path)", () => {
    feedCircuit.close();

    expect(mockAuditWrite).not.toHaveBeenCalled();
    expect(feedCircuit.isOpen()).toBe(false);
  });
});
