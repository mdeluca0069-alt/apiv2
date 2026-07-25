/**
 * autopilot.service.spec.ts
 *
 * Task 14, Phase 1 — first-ever test coverage for AutopilotService's config
 * CRUD (getConfig/saveConfig/recordDecision), covering the sandbox in-memory
 * path and the persistent DB path.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// REALTIME_FREEZE.md Critical #2: autopilot.service.ts now routes through
// immutableAudit.write() (real module, not mocked) instead of calling
// prisma.auditLog.create() directly -- $transaction/$queryRaw/
// auditLog.findFirst satisfy its chain-head lock and lookup.
const {
  mockFindUnique, mockUpsert, mockUpdate, mockAuditCreate, mockEventEmit,
  mockAssertEligible, mockGetConsentStatus, mockPrisma,
} = vi.hoisted(() => {
  const mockFindUnique = vi.fn();
  const mockUpsert     = vi.fn();
  const mockUpdate     = vi.fn();
  const mockAuditCreate = vi.fn().mockResolvedValue({});
  const mockEventEmit  = vi.fn();
  const mockAssertEligible   = vi.fn();
  const mockGetConsentStatus = vi.fn();
  const mockPrisma: Record<string, unknown> = {
    autopilotConfig: { findUnique: mockFindUnique, upsert: mockUpsert, update: mockUpdate },
    auditLog: { create: mockAuditCreate },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  mockPrisma.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(mockPrisma));
  return {
    mockFindUnique, mockUpsert, mockUpdate, mockAuditCreate, mockEventEmit,
    mockAssertEligible, mockGetConsentStatus, mockPrisma,
  };
});

let isPersistent = true;

vi.mock("../shared/db.js", () => ({
  get IS_PERSISTENT() { return isPersistent; },
  prisma: mockPrisma,
}));

vi.mock("../events-bus/event.bus.js", () => ({
  eventBus: { emit: mockEventEmit },
}));

vi.mock("../autopilot-service/autopilot.eligibility.js", () => ({
  autopilotEligibility: { assertEligible: mockAssertEligible },
}));

vi.mock("../autopilot-service/autopilot.consent.js", () => ({
  autopilotConsentService: { getStatus: mockGetConsentStatus },
}));

import { AutopilotService } from "../autopilot-service/autopilot.service.js";

beforeEach(() => {
  isPersistent = true;
  mockFindUnique.mockReset();
  mockUpsert.mockReset();
  mockUpdate.mockReset().mockResolvedValue({});
  mockAuditCreate.mockReset().mockResolvedValue({});
  mockEventEmit.mockReset();
  mockAssertEligible.mockReset().mockResolvedValue({ eligible: true });
  mockGetConsentStatus.mockReset().mockResolvedValue({ version: "v1", text: "...", accepted: true });
});

describe("AutopilotService.getConfig", () => {
  it("returns the sandbox default config when not persistent", async () => {
    isPersistent = false;
    const service = new AutopilotService();
    const cfg = await service.getConfig("user-1");
    expect(cfg.enabled).toBe(false);
    expect(cfg.mode).toBe("BALANCED");
    expect(cfg.userId).toBe("user-1");
  });

  it("maps a persistent DB row into the full config shape", async () => {
    mockFindUnique.mockResolvedValue({
      userId: "user-1", enabled: true, mode: "AGGRESSIVE", minConfidence: 0.8,
      maxRiskPerTrade: 0.1, maxOpenTrades: 5, maxExposurePct: 40,
      allowedSymbols: ["EURUSD"], blockedSymbols: [], stopDrawdownPct: 15, capitalPct: 80,
      eventLockMinutes: 60, maxDailyTrades: 20,
      breakEvenTriggerR: 1.2, trailingStopEnabled: false, trailingActivationR: 2, atrTrailMultiple: 3,
      regimeExitEnabled: false, maxHoursOpen: 24,
      tier: "PLATINUM", lastDecision: null, updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const service = new AutopilotService();
    const cfg = await service.getConfig("user-1");

    expect(cfg.enabled).toBe(true);
    expect(cfg.mode).toBe("AGGRESSIVE");
    expect(cfg.minConfidence).toBe(0.8);
    expect(cfg.allowedSymbols).toEqual(["EURUSD"]);
  });

  it("falls back to the default config when no row exists yet for the user", async () => {
    mockFindUnique.mockResolvedValue(null);
    const service = new AutopilotService();
    const cfg = await service.getConfig("user-2");
    expect(cfg.enabled).toBe(false);
    expect(cfg.userId).toBe("user-2");
  });
});

describe("AutopilotService.saveConfig", () => {
  it("rejects out-of-range input via Zod validation", async () => {
    const service = new AutopilotService();
    await expect(service.saveConfig("user-1", { minConfidence: 1.5 })).rejects.toThrow();
  });

  it("upserts, writes an AuditLog entry, and emits autopilot.config_changed on the persistent path", async () => {
    mockUpsert.mockResolvedValue({
      userId: "user-1", enabled: true, mode: "BALANCED", minConfidence: 0.7,
      maxRiskPerTrade: 0.05, maxOpenTrades: 3, maxExposurePct: 20,
      allowedSymbols: [], blockedSymbols: [], stopDrawdownPct: 10, capitalPct: 100,
      eventLockMinutes: 30, maxDailyTrades: 10,
      breakEvenTriggerR: 1, trailingStopEnabled: true, trailingActivationR: 1.5, atrTrailMultiple: 2,
      regimeExitEnabled: true, maxHoursOpen: 48,
      tier: "STANDARD", lastDecision: null, updatedAt: new Date(),
    });

    const service = new AutopilotService();
    const cfg = await service.saveConfig("user-1", { enabled: true }, "user-1");

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actor: "user-1", action: "autopilot.config_updated", entity: "user-1" }),
    }));
    expect(mockEventEmit).toHaveBeenCalledWith("autopilot.config_changed", { userId: "user-1", enabled: true });
    expect(cfg.enabled).toBe(true);
  });

  it("updates the in-memory store and emits the event on the sandbox path, without any DB calls", async () => {
    isPersistent = false;
    const service = new AutopilotService();
    const cfg = await service.saveConfig("user-3", { enabled: true, mode: "AGGRESSIVE" });

    expect(cfg.enabled).toBe(true);
    expect(cfg.mode).toBe("AGGRESSIVE");
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockEventEmit).toHaveBeenCalledWith("autopilot.config_changed", { userId: "user-3", enabled: true });
  });

  it("throws AUTOPILOT_NOT_ELIGIBLE when turning autopilot on and the eligibility check fails", async () => {
    mockFindUnique.mockResolvedValue(null); // not enabled yet
    mockAssertEligible.mockResolvedValue({ eligible: false, reason: "KYC not approved (status: pending)" });

    const service = new AutopilotService();
    await expect(service.saveConfig("user-1", { enabled: true }, "user-1"))
      .rejects.toThrow(/AUTOPILOT_NOT_ELIGIBLE/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("throws AUTOPILOT_CONSENT_REQUIRED when eligible but consent was never accepted", async () => {
    mockFindUnique.mockResolvedValue(null);
    mockAssertEligible.mockResolvedValue({ eligible: true });
    mockGetConsentStatus.mockResolvedValue({ version: "v1", text: "...", accepted: false });

    const service = new AutopilotService();
    await expect(service.saveConfig("user-1", { enabled: true }, "user-1"))
      .rejects.toThrow(/AUTOPILOT_CONSENT_REQUIRED/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("does not re-check eligibility/consent when autopilot is already enabled (e.g. a settings-only update)", async () => {
    mockFindUnique.mockResolvedValue({
      userId: "user-1", enabled: true, mode: "BALANCED", minConfidence: 0.7,
      maxRiskPerTrade: 0.05, maxOpenTrades: 3, maxExposurePct: 20,
      allowedSymbols: [], blockedSymbols: [], stopDrawdownPct: 10, capitalPct: 100,
      eventLockMinutes: 30, maxDailyTrades: 10,
      breakEvenTriggerR: 1, trailingStopEnabled: true, trailingActivationR: 1.5, atrTrailMultiple: 2,
      regimeExitEnabled: true, maxHoursOpen: 48, maxDailyLossPct: 5, maxSpreadBps: 15,
      tier: "STANDARD", lastDecision: null, updatedAt: new Date(),
    });
    mockUpsert.mockResolvedValue({ userId: "user-1", enabled: true, mode: "AGGRESSIVE" });

    const service = new AutopilotService();
    await service.saveConfig("user-1", { enabled: true, mode: "AGGRESSIVE" }, "user-1");

    expect(mockAssertEligible).not.toHaveBeenCalled();
    expect(mockGetConsentStatus).not.toHaveBeenCalled();
  });
});

describe("AutopilotService.recordDecision", () => {
  it("persists lastDecision and writes a namespaced AuditLog action on the persistent path", async () => {
    const service = new AutopilotService();
    await service.recordDecision("user-1", "EURUSD", "EXECUTED", "Signal conf=80%");

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data:  { lastDecision: expect.objectContaining({ symbol: "EURUSD", action: "EXECUTED" }) },
    });
    expect(mockAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "autopilot.decision.executed", actor: "AUTOPILOT_ENGINE" }),
    }));
  });

  it("updates only the in-memory store on the sandbox path", async () => {
    isPersistent = false;
    const service = new AutopilotService();
    await service.recordDecision("user-4", "XAUUSD", "SKIPPED", "low confidence");

    const cfg = await service.getConfig("user-4");
    expect(cfg.lastDecision).toEqual(expect.objectContaining({ symbol: "XAUUSD", action: "SKIPPED" }));
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
