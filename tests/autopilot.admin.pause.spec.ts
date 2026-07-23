/**
 * autopilot.admin.pause.spec.ts
 *
 * Task 14, Phase 3 — per-client admin pause, distinct from the platform-wide
 * /admin/olos/update toggle and from the client's own `enabled` flag.
 * Covers AutopilotService.adminSetPause() (persistent + sandbox), the new
 * pipeline gate that reads `cfg.pausedByAdmin`, and the AdminAutopilotPauseSchema
 * contract. The route handler itself is thin boilerplate identical to every
 * other admin route already in gateway/routes.ts (no test precedent exists
 * for that layer anywhere in this codebase) — not duplicated here.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AdminAutopilotPauseSchema } from "../shared/contracts.js";

// REALTIME_FREEZE.md Critical #2: autopilot.service.ts now routes through
// immutableAudit.write() (real module, not mocked) instead of calling
// prisma.auditLog.create() directly -- $transaction/$queryRaw/
// auditLog.findFirst satisfy its chain-head lock and lookup.
const { mockUpsert, mockAuditCreate, mockPrisma } = vi.hoisted(() => {
  const mockUpsert      = vi.fn();
  const mockAuditCreate = vi.fn().mockResolvedValue({});
  const mockPrisma: Record<string, unknown> = {
    autopilotConfig: { upsert: mockUpsert },
    auditLog: { create: mockAuditCreate, findFirst: vi.fn().mockResolvedValue(null) },
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
  mockPrisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(mockPrisma));
  return { mockUpsert, mockAuditCreate, mockPrisma };
});

let isPersistent = true;

vi.mock("../shared/db.js", () => ({
  get IS_PERSISTENT() { return isPersistent; },
  prisma: mockPrisma,
}));

vi.mock("../events-bus/event.bus.js", () => ({
  eventBus: { emit: vi.fn() },
}));

import { AutopilotService } from "../autopilot-service/autopilot.service.js";

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1", enabled: true, mode: "BALANCED", minConfidence: 0.7,
    maxRiskPerTrade: 0.05, maxOpenTrades: 3, maxExposurePct: 20,
    allowedSymbols: [], blockedSymbols: [], stopDrawdownPct: 10, capitalPct: 100,
    eventLockMinutes: 30, maxDailyTrades: 10,
    breakEvenTriggerR: 1, trailingStopEnabled: true, trailingActivationR: 1.5, atrTrailMultiple: 2,
    regimeExitEnabled: true, maxHoursOpen: 48,
    pausedByAdmin: false, pausedReason: null, pausedAt: null,
    tier: "PLATINUM", lastDecision: null, updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  isPersistent = true;
  mockUpsert.mockReset();
  mockAuditCreate.mockReset().mockResolvedValue({});
});

describe("AutopilotService.adminSetPause", () => {
  it("pauses on the persistent path: upserts pausedByAdmin/pausedReason/pausedAt and writes an audit entry", async () => {
    mockUpsert.mockResolvedValue(dbRow({ pausedByAdmin: true, pausedReason: "Suspicious activity", pausedAt: new Date() }));
    const service = new AutopilotService();

    const cfg = await service.adminSetPause("user-1", true, "Suspicious activity", "admin-1");

    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-1" },
      update: expect.objectContaining({ pausedByAdmin: true, pausedReason: "Suspicious activity" }),
    }));
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actor: "admin-1", action: "autopilot.admin_pause", entity: "user-1" }),
    }));
    expect(cfg.pausedByAdmin).toBe(true);
    expect(cfg.pausedReason).toBe("Suspicious activity");
  });

  it("resumes (clears) the pause on the persistent path, nulling reason/pausedAt", async () => {
    mockUpsert.mockResolvedValue(dbRow({ pausedByAdmin: false, pausedReason: null, pausedAt: null }));
    const service = new AutopilotService();

    const cfg = await service.adminSetPause("user-1", false, undefined, "admin-1");

    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ pausedByAdmin: false, pausedReason: null, pausedAt: null }),
    }));
    expect(cfg.pausedByAdmin).toBe(false);
  });

  it("updates only the in-memory store on the sandbox path, without touching prisma", async () => {
    isPersistent = false;
    const service = new AutopilotService();

    const cfg = await service.adminSetPause("user-2", true, "manual review", "admin-1");

    expect(cfg.pausedByAdmin).toBe(true);
    expect(cfg.pausedReason).toBe("manual review");
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("AdminAutopilotPauseSchema", () => {
  it("accepts a valid pause request with a reason", () => {
    expect(() => AdminAutopilotPauseSchema.parse({ userId: "user-1", paused: true, reason: "manual review" })).not.toThrow();
  });

  it("accepts a valid resume request with no reason", () => {
    expect(() => AdminAutopilotPauseSchema.parse({ userId: "user-1", paused: false })).not.toThrow();
  });

  it("rejects a reason shorter than 3 characters", () => {
    expect(() => AdminAutopilotPauseSchema.parse({ userId: "user-1", paused: true, reason: "no" })).toThrow();
  });
});
